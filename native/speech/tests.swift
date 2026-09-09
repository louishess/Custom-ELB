import Foundation
import Speech
import AVFoundation

@main struct SpeechNativeTests {
    @MainActor static func main() async throws {
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--transcribe-file" {
            let locale = Locale(identifier: "en-US")
            try await AssetInventory.reserve(locale: locale)
            let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
            guard await AssetInventory.status(forModules: [transcriber]) == .installed else { throw SpeechFailure(message: "Install the English speech assets before running the audio smoke test.") }
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let results = Task { () throws -> String in
                var text = ""
                for try await result in transcriber.results where result.isFinal { text += String(result.text.characters) }
                return text
            }
            do {
                let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[2]))
                _ = try await analyzer.analyzeSequence(from: file)
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                let text = try await results.value
                print("TRANSCRIPT: \(text)")
            } catch {
                results.cancel()
                await analyzer.cancelAndFinishNow()
                throw error
            }
            return
        }
        // Healthy delayed startup notifications must not terminate capture.
        precondition(!shouldStopForConfiguration(isCurrent: true, recording: true, isRunning: true, formatMatches: true))
        // Genuine active-engine stops and format changes remain actionable.
        precondition(shouldStopForConfiguration(isCurrent: true, recording: true, isRunning: false, formatMatches: true))
        precondition(shouldStopForConfiguration(isCurrent: true, recording: true, isRunning: true, formatMatches: false))
        // An old recording's callback and an intentional stop must be inert.
        precondition(!shouldStopForConfiguration(isCurrent: false, recording: true, isRunning: false, formatMatches: false))
        precondition(!shouldStopForConfiguration(isCurrent: true, recording: false, isRunning: false, formatMatches: false))

        let dictation = Dictation()
        dictation.generation = 4
        dictation.recording = true
        dictation.transcript = "New recording"
        let retainedEngine = AVAudioEngine()
        dictation.engine = retainedEngine
        await dictation.recoverInput(3, reason: "Old route callback")
        precondition(dictation.generation == 4 && dictation.recording)
        await dictation.failRecording(3, message: "Old failure")
        precondition(dictation.generation == 4 && dictation.recording)
        precondition(dictation.terminalError == nil && dictation.transcript == "New recording")

        await dictation.failRecording(4, message: "Active failure")
        precondition(dictation.generation == 5 && !dictation.recording)
        precondition(dictation.engine === retainedEngine && !retainedEngine.isRunning)
        precondition(!dictation.tapInstalled && dictation.continuation == nil)
        precondition(dictation.terminalError == "Active failure")
        precondition(dictation.transcript == "New recording")
        // Repeated callbacks cannot overwrite the original failure or end a replacement recording.
        await dictation.failRecording(4, message: "Late duplicate failure")
        precondition(dictation.generation == 5 && dictation.terminalError == "Active failure")
        await dictation.cancel()
        precondition(dictation.generation == 6 && dictation.transcript.isEmpty)
        print("PASS native configuration and generation lifecycle")
    }
}
