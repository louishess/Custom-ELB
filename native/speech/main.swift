import Foundation
import Speech
import AVFoundation

// Line-delimited JSON over private inherited pipes. No audio is written to disk.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}
struct SpeechFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@available(macOS 26.0, *)
@MainActor final class Dictation {
    var sessionID: String?
    var analyzer: SpeechAnalyzer?
    var engine: AVAudioEngine?
    var continuation: AsyncStream<AnalyzerInput>.Continuation?
    var resultsTask: Task<Void, Never>?
    var interruptionObserver: NSObjectProtocol?
    var finalized = ""
    var transcript = ""
    var recording = false
    var tapInstalled = false
    var generation = 0
    var terminalError: String?
    var analysisFormat: AVAudioFormat?
    var sourceSampleRate: Double = 0
    var sourceChannels: AVAudioChannelCount = 0
    var tapGeneration = 0
    var routeRecoveries = 0

    func event(_ state: String, message: String? = nil, final: Bool = false) {
        guard let sessionID else { return }
        var value: [String: Any] = ["sessionId": sessionID, "state": state, "transcript": transcript, "final": final]
        if let message { value["message"] = message }
        emit(["event": value])
    }
    func capabilities() async -> [String: Any] {
        guard SpeechTranscriber.isAvailable else { return ["available": false, "reason": "On-device speech recognition is unavailable on this Mac.", "locales": []] }
        var locales: [[String: Any]] = []
        for locale in await SpeechTranscriber.supportedLocales.sorted(by: { $0.identifier < $1.identifier }) {
            let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
            // installedLocales describes the locale generally; this exact module may still need assets.
            let installed = await AssetInventory.status(forModules: [transcriber]) == .installed
            locales.append(["id": locale.identifier.replacingOccurrences(of: "_", with: "-"), "name": Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier, "installed": installed])
        }
        if locales.isEmpty { return ["available": false, "reason": "macOS did not return any supported speech languages. Check system connectivity and try again.", "locales": []] }
        return ["available": true, "locales": locales]
    }
    func supportedLocale(_ identifier: String) async throws -> Locale {
        guard SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else { throw SpeechFailure(message: "This dictation language is unavailable on this Mac.") }
        return locale
    }
    func reservedModule(_ identifier: String) async throws -> SpeechTranscriber {
        let locale = try await supportedLocale(identifier)
        // Reservations are app-specific and persist independently of this helper process.
        // Never infer module readiness solely from SpeechTranscriber.installedLocales.
        do { try await AssetInventory.reserve(locale: locale) }
        catch { throw SpeechFailure(message: "Could not reserve the selected speech language: \(error.localizedDescription)") }
        return SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    }
    func prepare(_ session: String, locale: String) async throws {
        guard !recording else { throw SpeechFailure(message: "Stop the active recording before preparing another language.") }
        sessionID = session
        event("preparing", message: "Preparing on-device language assets. The initial download requires internet access.")
        let transcriber = try await reservedModule(locale)
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() }
        } catch { throw SpeechFailure(message: "Could not prepare the selected speech language: \(error.localizedDescription)") }
        guard await AssetInventory.status(forModules: [transcriber]) == .installed else { throw SpeechFailure(message: "The speech language assets are not ready. Connect to the internet and prepare the language again.") }
        event("ready")
    }
    func start(_ session: String, locale: String) async throws {
        guard !recording, analyzer == nil else { throw SpeechFailure(message: "A recording is already active.") }
        generation += 1
        let recordingGeneration = generation
        sessionID = session
        finalized = ""; transcript = ""; terminalError = nil; routeRecoveries = 0
        let transcriber = try await reservedModule(locale)
        guard await AssetInventory.status(forModules: [transcriber]) == .installed else { throw SpeechFailure(message: "Prepare the selected language before recording.") }
        let permission = await AVCaptureDevice.requestAccess(for: .audio)
        guard permission else { throw SpeechFailure(message: "Microphone access was denied. Enable LabMate in System Settings > Privacy & Security > Microphone, then try again.") }
        // Keep one I/O engine for this helper's lifetime. Recreating it after every Stop
        // allows delayed hardware shutdown notifications to interrupt the next Start.
        let engine = self.engine ?? AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let naturalFormat = input.inputFormat(forBus: 0)
        guard naturalFormat.sampleRate > 0, naturalFormat.channelCount > 0,
              let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: naturalFormat) else { throw SpeechFailure(message: "No compatible microphone input is available.") }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer; self.analysisFormat = format
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(256))
        self.continuation = continuation
        try await analyzer.prepareToAnalyze(in: format)
        guard generation == recordingGeneration else { throw SpeechFailure(message: terminalError ?? "Recording startup was interrupted.") }
        resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self, self.sessionID == session, self.generation == recordingGeneration else { return }
                    let text = String(result.text.characters)
                    if result.isFinal { self.finalized += text }
                    self.transcript = result.isFinal ? self.finalized : self.finalized + text
                    self.event(self.recording ? "recording" : "stopped", final: result.isFinal)
                }
            } catch {
                guard let self, !Task.isCancelled else { return }
                await self.failRecording(recordingGeneration, message: "Speech recognition stopped: \(error.localizedDescription)")
            }
        }
        try await analyzer.start(inputSequence: stream)
        guard generation == recordingGeneration, self.analyzer === analyzer else { throw SpeechFailure(message: terminalError ?? "Recording startup was interrupted.") }
        try installInputTap(engine, format: format, continuation: continuation, recordingGeneration: recordingGeneration)
        engine.prepare()
        try engine.start()
        recording = true
        // Observe only after startup. A queued startup notification must not stop a healthy engine.
        // Return from NotificationCenter immediately; Apple warns against synchronous teardown here.
        let engineIdentity = ObjectIdentifier(engine)
        interruptionObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            Task { @MainActor in
                guard let self, let engine = self.engine, ObjectIdentifier(engine) == engineIdentity else { return }
                let currentFormat = engine.inputNode.inputFormat(forBus: 0)
                guard shouldStopForConfiguration(isCurrent: self.generation == recordingGeneration, recording: self.recording, isRunning: engine.isRunning, formatMatches: currentFormat.sampleRate == self.sourceSampleRate && currentFormat.channelCount == self.sourceChannels) else { return }
                await self.recoverInput(recordingGeneration, reason: "configuration changed")
            }
        }
        event("recording")
    }
    func installInputTap(_ engine: AVAudioEngine, format: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation, recordingGeneration: Int) throws {
        let input = engine.inputNode
        // Input scope is the hardware format. A stale output-scope format may survive a route change.
        let naturalFormat = input.inputFormat(forBus: 0)
        guard naturalFormat.sampleRate > 0, naturalFormat.channelCount > 0,
              let converter = AVAudioConverter(from: naturalFormat, to: format) else {
            throw SpeechFailure(message: "No compatible microphone input is available.")
        }
        sourceSampleRate = naturalFormat.sampleRate; sourceChannels = naturalFormat.channelCount
        tapGeneration += 1
        let currentTap = tapGeneration
        input.installTap(onBus: 0, bufferSize: 4096, format: naturalFormat) { [weak self] buffer, _ in
            // Create an owned buffer. The engine reuses its tap buffer after this callback.
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * format.sampleRate / naturalFormat.sampleRate)) + 32
            guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
            var supplied = false
            var conversionError: NSError?
            let status = converter.convert(to: converted, error: &conversionError) { _, state in
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true; state.pointee = .haveData; return buffer
            }
            if status == .error || conversionError != nil {
                let errorCode = conversionError?.code ?? 0
                Task { @MainActor in
                    guard let self, self.tapGeneration == currentTap else { return }
                    await self.recoverInput(recordingGeneration, reason: "audio conversion error \(errorCode)")
                }
                return
            }
            if converted.frameLength > 0, case .dropped = continuation.yield(AnalyzerInput(buffer: converted)) {
                Task { @MainActor in
                    guard let self, self.tapGeneration == currentTap else { return }
                    await self.failRecording(recordingGeneration, message: "Speech processing could not keep up with the microphone. Stop and try again.")
                }
            }
        }
        tapInstalled = true
    }
    func inputDiagnostics(_ engine: AVAudioEngine) -> String {
        let hardware = engine.inputNode.inputFormat(forBus: 0)
        return "running=\(engine.isRunning), hardware=\(Int(hardware.sampleRate))Hz/\(hardware.channelCount)ch, tap=\(Int(sourceSampleRate))Hz/\(sourceChannels)ch, recoveries=\(routeRecoveries)"
    }
    func recoverInput(_ expectedGeneration: Int, reason: String) async {
        guard generation == expectedGeneration, recording, let engine, let analysisFormat, let continuation else { return }
        let diagnostic = inputDiagnostics(engine)
        if ProcessInfo.processInfo.environment["LABMATE_SPEECH_DIAGNOSTICS"] == "1" {
            // Explicit diagnostics contain device format/state only, never audio or recognized text.
            FileHandle.standardError.write(Data("LabMate speech: \(reason); \(diagnostic)\n".utf8))
        }
        guard routeRecoveries < 3 else {
            await failRecording(expectedGeneration, message: "The microphone connection is unstable. Review the transcript and start again.")
            return
        }
        routeRecoveries += 1
        // Preserve the analyzer, its transcript and its input continuation across a valid route change.
        // No gap is invented as audio; recognition resumes from the next available input buffer.
        engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        tapGeneration += 1
        do {
            try installInputTap(engine, format: analysisFormat, continuation: continuation, recordingGeneration: expectedGeneration)
            engine.prepare()
            try engine.start()
            event("recording", message: "Microphone reconnected. Listening on this Mac…")
        } catch {
            await failRecording(expectedGeneration, message: "The microphone could not reconnect. Review the transcript and start again. \(error.localizedDescription)")
        }
    }
    func failRecording(_ expectedGeneration: Int, message: String) async {
        guard generation == expectedGeneration else { return }
        terminalError = message
        let stoppedAnalyzer = invalidateRecording()
        event("error", message: message)
        await stoppedAnalyzer?.cancelAndFinishNow()
    }
    // Clear state before awaiting native cancellation; late work cannot tear down a newer recording.
    func invalidateRecording() -> SpeechAnalyzer? {
        generation += 1
        stopAudio()
        resultsTask?.cancel(); resultsTask = nil
        let stoppedAnalyzer = analyzer; analyzer = nil
        return stoppedAnalyzer
    }
    func stopAudio() {
        recording = false
        if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer); interruptionObserver = nil }
        if let engine { engine.stop(); if tapInstalled { engine.inputNode.removeTap(onBus: 0) } }
        tapInstalled = false; tapGeneration += 1
        // Retain the stopped engine, with no tap and no active recording, for a stable next Start.
        analysisFormat = nil
        continuation?.finish(); continuation = nil
    }
    func stop(_ session: String) async throws {
        guard sessionID == session else { throw SpeechFailure(message: "This dictation session is no longer active.") }
        let stoppingGeneration = generation
        let stoppedAnalyzer = analyzer
        let stoppedResults = resultsTask
        stopAudio()
        if let stoppedAnalyzer { try await stoppedAnalyzer.finalizeAndFinishThroughEndOfInput() }
        await stoppedResults?.value
        guard generation == stoppingGeneration else { throw SpeechFailure(message: terminalError ?? "Speech recognition ended unexpectedly. Review the transcript.") }
        generation += 1; resultsTask = nil; analyzer = nil
        event("stopped", final: true)
    }
    func cleanupAfterError() async {
        let stoppedAnalyzer = invalidateRecording()
        await stoppedAnalyzer?.cancelAndFinishNow()
    }
    func cancel() async {
        let stoppedAnalyzer = invalidateRecording()
        event("cancelled"); sessionID = nil; finalized = ""; transcript = ""
        await stoppedAnalyzer?.cancelAndFinishNow()
    }
}

// A notification is advisory until the active engine's health and format are checked.
func shouldStopForConfiguration(isCurrent: Bool, recording: Bool, isRunning: Bool, formatMatches: Bool) -> Bool {
    isCurrent && recording && (!isRunning || !formatMatches)
}

#if !SPEECH_NATIVE_TESTS
@main struct Main {
    static func main() async {
        guard #available(macOS 26.0, *) else { emit(["fatal": "Integrated dictation requires macOS 26 or later."]); return }
        let dictation = Dictation()
        let lines = AsyncStream<String> { continuation in
            DispatchQueue.global().async {
                while let line = readLine() { continuation.yield(line) }
                continuation.finish()
            }
        }
        for await line in lines {
            guard line.utf8.count <= 8192, let data = line.data(using: .utf8), let command = try? JSONSerialization.jsonObject(with: data) as? [String: String], let id = command["id"], let operation = command["operation"] else { continue }
            do {
                var value: [String: Any] = [:]
                switch operation {
                case "capabilities": value = await dictation.capabilities()
                case "prepare": try await dictation.prepare(command["sessionId"] ?? "", locale: command["locale"] ?? "en-US"); value = ["ready": true]
                case "start": try await dictation.start(command["sessionId"] ?? "", locale: command["locale"] ?? "en-US"); value = ["started": true]
                case "stop": try await dictation.stop(command["sessionId"] ?? ""); value = ["stopped": true]
                case "cancel": await dictation.cancel(); value = ["cancelled": true]
                default: throw SpeechFailure(message: "Unsupported dictation operation.")
                }
                emit(["id": id, "value": value])
            } catch {
                await dictation.cleanupAfterError()
                emit(["id": id, "error": ["code": "UNAVAILABLE", "message": error.localizedDescription]])
            }
        }
        await dictation.cancel()
    }
}

#endif
