# LabMate

A standalone Apple Silicon Mac electronic lab notebook, built with Electron, React, TypeScript, and SQLite. The working library stays on your Mac; encrypted portable snapshots can be saved to Box Drive.

Read [the handoff](docs/HANDOFF.md) for verified release status, [recovery instructions](docs/RECOVERY.md) before using backups, and [the dependency inventory](docs/DEPENDENCIES.md) for resolved versions and licenses.

## Local workflows

The functional release adds notebook and experiment creation, repeated runs, rich editing in four sections, autosave, search/sort, ordered overlapping schemes, a persistent experiment tracker, preferences, managed attachments, local exports, and recoverable Trash. A separate demonstration mode contains fictional examples; a new real library starts empty.

Version 0.4 adds on-device dictation with transcript review (macOS 26+), six coordinated palettes, table sizing and structural controls, and editable molar yield calculations in Data. The calculator uses one user-designated starting material and equivalents ratio; mass conversion and automatic limiting-reagent detection are not included.

Version 0.4.3 adds **Midnight Purple** under Settings → Workspace palette. The light end is soft purple; the darkest slider position uses a black background with violet accents. Existing palette selections stay unchanged.

Version 0.4.2 adds [yield from material highlights](docs/YIELD-MARKUP.md): mark starting material and product in the toolbar, detect amounts/units automatically, and copy theoretical and actual yield. Unrecognized descriptions open a manual-entry popup. Previous yield cards remain editable.

Version 0.4.1 addresses dictation startup and gives the Insert Table dialog more room. Start prepares the exact speech model before opening the microphone. Cancelling preparation prevents a later recording from starting. Yield calculations are unchanged in this update.

The existing warm Mac styling, notebook accents, continuous/tabbed entry layouts, and 0–100 appearance slider are retained. The local editor supports headings, marks, lists, links, tables, alignment, subscript, and superscript.

Supported attachment previews are PNG/JPEG, PDF, CSV/TSV, and XLSX. Other files can be retained and opened explicitly in an associated Mac application. Spreadsheet formulas and macros are not executed. Local export formats are Plain text, Markdown, HTML, RTF, and DOCX, with entry/section ordering and data inclusion options.

Zotero, Google Docs, scientific previews, live cloud synchronization, shared accounts, signing, and notarization remain deferred.

## Data and backups

The working library lives in `~/Library/Application Support/LabMate/`. Imported files are copied into managed storage; originals remain intact. Keep the live database outside cloud-synchronized folders.

Choose a Box Drive backup folder and confirm a password in Settings, then create the first backup. Destination changes reuse the saved password; availability, failures, and verified local copy times are visible. LabMate creates authenticated, password-encrypted `.labmatebackup` archives and remembers the password using macOS-protected secure storage. Backups include Trash and referenced attachments. The working library itself is not password-encrypted.

A local write to Box Drive does not prove upload completion. Box manages synchronization; use Box to confirm cloud availability when needed. Passwords and local destination configuration are excluded from backups. Restore replaces the current library after confirmation, with a rollback copy retained. See [Recovery](docs/RECOVERY.md).

## Development

Requirements: macOS arm64, Node.js 22.13+ (development verified with Node 26.5.0), npm, and Apple Command Line Tools with the macOS 26 SDK for the speech helper. Initial dependency, Electron runtime, and native build-header downloads require network access.

```sh
npm ci
npm run setup:desktop
npm start
```

`setup:desktop` explicitly installs Electron's runtime and rebuilds SQLite for Electron. It is needed when npm skips dependency install scripts. The renderer can be inspected using `npm run dev`; durable desktop operations require Electron.

```sh
npm run typecheck
npm run build
npm run test:backend
npm run check:appearance
npm run package:mac
```

The desktop backend/preload use explicit CommonJS sources, validated during build and included in the package. Renderer TypeScript compiles through Vite. Packaging retains production dependencies, native SQLite bindings, parser processes, and the locally bundled PDF worker.

The local review bundle, without Developer ID signing or notarization, is `out/LabMate-darwin-arm64/LabMate.app`:

```sh
open 'out/LabMate-darwin-arm64/LabMate.app'
```

## Verification

```sh
LABMATE_REQUIRE_PACKAGE=1 npm run test:backend
LABMATE_APP_BINARY="$PWD/out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate" npm run check:functional
LABMATE_APP_BINARY="$PWD/out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate" npm run check:ui
npm run check:dependencies
# With the same LABMATE_APP_BINARY, also run check:tables, check:yield,
# check:material-yield, check:palettes and check:dictation.
```

Automated functional checks use disposable libraries and synthetic files, never personal notebook records or a real Box destination. Native dialogs are substituted with disposable paths where file selection needs automation. Dictation UI tests inject synthetic transcript events; native recognition also passes a locally generated audio fixture. The 0.4.1 packaged app passed two actual microphone Start/Stop cycles. Live utterance accuracy, offline transcription, Keychain setup, and Box upload/download remain separate acceptance checks. Reports and screenshots are under `artifacts/` and excluded from Git.

The opt-in `scripts/check-dictation-live.mjs` opens the real microphone for two six-second sessions and saves only status/timing and transcript lengths. It uses a disposable library. Set `LABMATE_APP_BINARY` to the packaged binary and `LABMATE_LAUNCH_SERVICES=1` to launch normally through macOS; direct child-process tests may attribute microphone access to the test runner. `node tests/speech-audio-smoke.cjs` exercises the real recognizer with a generated temporary audio file and never opens a microphone.

For isolated development/testing, set `LABMATE_LIBRARY_ROOT` to a disposable folder. Do not point it at an existing unrelated folder. The renderer has no direct Node, shell, arbitrary filesystem, or arbitrary network access; native capabilities go through the narrow validated preload interface.
