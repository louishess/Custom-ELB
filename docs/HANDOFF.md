# LabMate functional application handoff

Updated September 9, 2026. Version 0.4.3 builds on commit `ec51ff7` (dictation fix).
These feature changes are in the working tree, uncommitted and unpublished.
Preserve the frontend, seven-palette appearance continuum, and local-first
architecture. Read `BACKEND-CONTRACT.md` before changing subsystem interfaces.
See `VALIDATION.md` for the evidence and remaining live acceptance checks.

Version 0.4.3 adds Midnight Purple as a separate Settings palette: soft purple at the light end, a pure black canvas and violet accents at the dark end. Existing palettes, brightness, notebook identities and status colors remain unchanged. Schema 3 expands the palette constraint through a transactional preferences-only migration from schemas 1 and 2.

The previous 0.4.1 feedback pass fixed dictation preparation and repeated recording startup,
and enlarges the Insert Table dialog with comfortable spacing and larger inputs.
Yield calculation behavior is unchanged. Start now prepares/reserves the exact
progressive transcription module before opening audio. The native helper retains
its stopped audio engine, reconnects valid configuration changes, and rejects
stale recording/tap callbacks. Renderer operation guards prevent cancelled
preparation or finalization from changing a newer recording.

The 0.4.2 yield pass adds Mark as Starting Material, Mark as Product and Copy
Yield in the editor toolbar. Distinct semantic highlights work across all four
sections of one run. The parser accepts spaced/unspaced mass or volume, molar
units and equivalents. Parse failures open a manual-entry popup; saved manual
values are tied to the exact highlighted text and must be reviewed after edits.
Copy Yield includes theoretical molar amount, actual amount and percentage.
Old yield cards remain editable, but new calculations use markup controls.
Read `YIELD-MARKUP.md` for supported notation and the manual fallback workflow.

## Product and data boundaries

Real libraries start empty. Demonstration mode is explicitly labelled,
read-only, fictional, and separate from the desktop database. The working
library is `~/Library/Application Support/LabMate/`, with SQLite and copied,
content-addressed attachments. Box Drive is a backup destination; the live
library must remain local. The working library itself is not password-encrypted.

Working capabilities include notebook/experiment/run creation and metadata,
four rich-text sections, autosave with revision checks, repeat runs, search,
numeric and text sorting, ordered overlapping schemes, run tracker status,
appearance/layout/view preferences, recoverable Trash and permanent deletion.
Repeats retain title, Information and Method, use today's date and the next
run number, reset status to To-Do, and leave Notes and Data empty. Numbers are
allocated transactionally and are never reused after deletion. There is no
user-visible revision history.

The editor provides table insertion sizing, row/column actions, headers,
merge/split, fit-to-editor and visible drag handles. Column widths and merged
cells persist; rich exports retain them and text/Markdown report layout losses.
Data retains previously saved versioned editable yield cards. Amounts use mol/mmol/µmol/nmol;
the user selects one starting material as the calculation basis and provides
its equivalents ratio to product. Inputs autosave with the document, incomplete
values remain editable, and exports recompute a static readable summary.
Repeat still clears Data, including yield cards; it also removes material role marks from copied Information/Method while keeping the prose and ordinary formatting.

Appearance offers Original Sage, Ocean, Lavender, Terracotta, Rose, Graphite and Midnight Purple.
All seven preserve the 0–100 slider and semantic notebook/status colors. Schema 3
adds Midnight Purple to the saved palette choices. Schema 1 libraries migrate to
Original Sage; schema 2 libraries keep their saved palette and brightness.
Authenticated backups from schemas 1, 2 and 3 are supported; future schemas are rejected.

Integrated dictation uses a bundled Swift helper with Apple's SpeechAnalyzer
and SpeechTranscriber on macOS 26+. The helper exposes capabilities and language
preparation, then explicit Start/Stop. A modal shows the live transcript for
correction before inserting at the saved selection in any section. Audio is
processed in memory and never stored by LabMate. Cancel stops capture; an
unresolved transcript blocks app close until inserted/discarded. Supported
languages are discovered at runtime; asset preparation can require internet.
On older/unsupported Macs, dictation displays the reason and editing remains
available. Exact US English module preparation and real on-device recognition
of a generated audio fixture passed. In the final packaged app, two actual
microphone sessions stayed active for six seconds each through explicit Stop
and restart. No live audio or transcript text was saved by the diagnostic.
These final sessions contained no recognized speech; a preceding diagnostic
did produce a live transcript while exposing the now-fixed second-start bug.
Live dictated-utterance accuracy and offline utterance acceptance remain manual.

Attachments are copied without changing the original. PNG/JPEG, PDF, CSV/TSV
and XLSX have real previews. Unsupported files remain attachable and can be
opened explicitly as an external copy. PDF pages render with bundled PDF.js;
spreadsheet parsing runs separately. Preview limits are 200 MiB PDF, 25 MiB
spreadsheet, 100,000 displayed spreadsheet cells and 50 megapixels per image.

Local exports use a shared selection and document model for TXT, Markdown,
HTML, RTF and DOCX. The UI explains losses before export; exporter warnings
report unavailable previews. PDF attachments use captions in exports. Raster
images and spreadsheet tables have richer output where supported. Markdown
writes relative companion assets. Aggregate export limits are 128 MiB of
raster data and 100,000 spreadsheet cells, with caption fallback warnings.

## Backups and recovery

Settings provides password confirmation and native Box destination setup, first backup/Back up now, restore,
and daily backup scheduling with launch catch-up. The destination picker
suggests a detected Box Drive folder. Remembered passwords use Electron
safeStorage; only encrypted credential bytes are stored locally, outside the
backup. Setup is completed by the user on their Mac. Destination changes reuse the
saved password; Finder reveal is limited to the configured directory. Settings
shows availability, progress, last verified local copy, attempt and failure.
Daily failures are persisted; a successful copy clears the latest failure.

Backups use SQLite's consistent snapshot API, include Trash and referenced
attachments, and are archived then encrypted with AES-256-GCM and scrypt.
Each archive has a fresh salt/nonce and authenticated header. Completed files
are validated before publishing, destination copies are verified, the newest
seven local snapshots are retained, and destination archives are never pruned
automatically. “Saved to Box Drive; upload managed by Box” is a local result,
not proof of cloud upload.

This release bounds each backup to 2 GiB of archive/expanded data, 1 GiB per
included file, and 10,000 archive entries. Exceeding a limit fails the entire
backup without publishing a partial copy. Larger files can remain attached;
the limits and failure behavior are shown in Settings and `RECOVERY.md`.

Restore authenticates into staging, validates archive paths/hashes/schema and
SQLite integrity, preserves the current library for rollback, and uses a
durable journal to recover an interrupted directory/database switch. Do not
manually remove recovery staging while a restore is interrupted. Permanent
deletion does not erase older backup or rollback copies. See `RECOVERY.md`.

## Architecture and ownership

| Location | Responsibility |
| --- | --- |
| `shared/contracts.ts`, `docs/BACKEND-CONTRACT.md` | Typed API and subsystem agreements |
| `electron/main.cjs`, `electron/preload.cjs` | Sandboxed bridge, frame/payload validation, native pickers, safeStorage, scheduling and close flush |
| `electron/backend/worker.cjs` | Dedicated utility process, serial mutation queue, progress/cancellation |
| `electron/backend/schema.cjs` | Version-specific required columns and palette IDs |
| `electron/dictation.cjs`, `native/speech/main.swift` | Session-scoped speech helper, permissions, audio and transcript lifecycle |
| `shared/yield.cjs`, `src/YieldCalculation.tsx` | Shared deterministic calculation and legacy persisted editor card |
| `shared/material-yield.cjs`, `src/MaterialYield.tsx` | Material parser, semantic highlights, manual fallback and Copy Yield |
| `electron/backend/store.cjs` | SQLite migrations, repository operations, optimistic revisions, Trash |
| `electron/backend/backup.cjs` | Snapshot, encryption, archive validation and journalled restoration |
| `electron/backend/files.cjs`, `parser.cjs` | Managed imports and isolated spreadsheet previews |
| `electron/backend/exports.cjs` | Shared export model and five writers |
| `src/App.tsx`, `src/panels.tsx`, `src/Tracker.tsx` | Durable UI workflows |
| `src/components.tsx`, `src/autosave.ts` | Tiptap editor and autosave coordination |
| `src/workflows.ts`, `src/fixtures.ts` | Ordering/search helpers and separate demo fixtures |
| `src/AttachmentPreview.tsx` | Bounded image, PDF and table display |
| `src/appearance.ts`, `src/theme.css`, `src/styles.css` | Preserved appearance and layout |
| `scripts/package.mjs` | Production dependency packaging, arm64 native rebuild and local workers |

The primary agent owns contracts, integration, migrations, packaging and release
acceptance. Bounded depth-1 agents covered dictation, backups, tables, appearance
and yield/exports; one depth-2 worker handled table exporters. No commits,
separate user-owned tasks or public releases were created.

## Install and validate

Use macOS arm64, a supported Node release, npm, and Apple Command Line Tools with macOS 26 SDK/Swift for native speech compilation.
The lockfile is authoritative. Native dependencies must match Electron's ABI.
Initial setup needs network access; local app workflows operate offline.

```sh
npm ci
npm run setup:desktop
npm run check:dependencies
npm run test:backend
npm run check:appearance
npm run build:speech
npm run package:mac
LABMATE_REQUIRE_PACKAGE=1 npm run test:backend
LABMATE_APP_BINARY="$PWD/out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate" npm run check:functional
LABMATE_APP_BINARY="$PWD/out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate" npm run check:ui
# Use the same LABMATE_APP_BINARY for check:tables, check:yield, check:material-yield, check:palettes, check:dictation.
```

CommonJS desktop code is explicitly syntax-checked and packaged as source;
renderer TypeScript is checked then compiled with Vite. Production node_modules
are retained, SQLite's arm64 binary and the parser are unpacked, and the PDF
worker is bundled locally. The previous packaging deletion of node_modules has
been removed. Dependencies and licenses are recorded in `DEPENDENCIES.md` and
`artifacts/dependencies.json`. ExcelJS's UUID override is covered by an XLSX
round-trip test. The unchanged cached icon avoids a local Swift SDK mismatch.

Final acceptance evidence is recorded in `VALIDATION.md` and the generated
`artifacts/ui/checks.json` and `artifacts/functional/checks.json`. Tests use
synthetic files and disposable libraries/profiles. They do not write the user's
Box account or validate a real cloud upload. Native Keychain setup, Box upload
and download on the user's account, clean-Mac installation, signing and
notarization remain separate manual/distribution checks.

## Deferred controls

Zotero and Google Docs integration, scientific viewers, public
signing/notarization, Intel packaging and updates remain deferred. Future
citation associations have a separate storage table but no live picker/API.
No hosted backend, live cloud sync, multiuser access, electronic signatures or
regulated-lab compliance claims are included. See `integration-notes.md`.
