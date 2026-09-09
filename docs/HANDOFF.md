# LabMate functional application handoff

Updated September 9, 2026. The approved local backend is implemented for the
Apple Silicon Mac application, version 0.3.0. The base commit remains `34b1039`;
implementation changes are in the working tree and have not been committed or
published. Preserve the current frontend, appearance continuum, and local-first
architecture. Read `BACKEND-CONTRACT.md` before changing subsystem interfaces.

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

Settings provides password and native destination setup, Back up now, restore,
and daily backup scheduling with launch catch-up. The destination picker
suggests a detected Box Drive folder. Remembered passwords use Electron
safeStorage; only encrypted credential bytes are stored locally, outside the
backup. Setup is completed by the user on their Mac.

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

PM owns shared contracts, manifests, integration and release acceptance. Three
Sol High depth-1 leads reviewed storage/recovery, desktop/workflows and
files/delivery. Each had up to two Luna Max depth-2 coding workers. Maximum nine
subagents, primary excluded; depth-2 agents cannot delegate. No separate
user-owned tasks or commits were created for this implementation.

## Install and validate

Use macOS arm64, a supported Node release, npm, and Apple Command Line Tools.
The lockfile is authoritative. Native dependencies must match Electron's ABI.
Initial setup needs network access; local app workflows operate offline.

```sh
npm ci
npm run setup:desktop
npm run check:dependencies
npm run test:backend
npm run check:appearance
npm run package:mac
LABMATE_REQUIRE_PACKAGE=1 npm run test:backend
LABMATE_APP_BINARY="$PWD/out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate" npm run check:functional
LABMATE_APP_BINARY="$PWD/out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate" npm run check:ui
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

Zotero and Google Docs integration, dictation, scientific viewers, public
signing/notarization, Intel packaging and updates remain deferred. Future
citation associations have a separate storage table but no live picker/API.
No hosted backend, live cloud sync, multiuser access, electronic signatures or
regulated-lab compliance claims are included. See `integration-notes.md`.
