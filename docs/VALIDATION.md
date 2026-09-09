# LabMate 0.3.0 release validation

Final verification: 2026-09-09T06:56:38.778532+00:00 (UTC). Base commit `34b1039`; implementation is in the working tree, uncommitted. All app acceptance used disposable libraries and profiles, not personal records.

## Delivered application

- Apple Silicon app: `out/LabMate-darwin-arm64/LabMate.app`
- Portable archive: `artifacts/LabMate-0.3.0-macOS-arm64.zip` (177,373,417 bytes)
- Archive SHA-256: `26d3ded1ba1dac3551f900a6e896f2ed80412d1fc1108cfbd017fb7fa5407495`
- Application archive SHA-256: `5d651bb80c6d1e36d9fea7b29f83c1e8cec4e2d319ebce1c5edb35c88c65d6f3`
- Archive CRC/readback check: passed (`unzip -tq`).
- Runtime: Electron 44.3.0, Node 24.20.0, SQLite 3.53.4; development Node 26.5.0.
- The executable is arm64 and has Electron's ad-hoc linker signature. No Developer ID/team identity or notarization is present. This is a local review build.

## Verified evidence

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript, desktop syntax and production compilation | Passed | `artifacts/package-build.txt` |
| Backend and package tests | 61 passed, zero failed/skipped | `artifacts/backend-tests.txt` |
| Standalone package checks | 2 passed, also included in the 61-test suite | `artifacts/packaged-tests.txt` |
| Packaged user workflows | 13 passed, zero renderer errors/external requests | `artifacts/ui/checks.json` (2026-09-09T06:54:06.315Z) |
| Packaged functional workflows | 12 passed, zero renderer errors/external requests | `artifacts/functional/checks.json` (2026-09-09T06:53:14.434Z) |
| Appearance continuum | All 101 positions passed; minimum tested contrast 4.50:1 | `artifacts/appearance-tests.txt` |
| Dependency audit | Zero known vulnerabilities returned | `artifacts/dependency-audit.json` |
| Version/license inventory | 339 resolved packages, 37 direct | `docs/DEPENDENCIES.md`, `artifacts/dependencies.json` |
| Patch whitespace | Passed | `git diff --check` |

Package inspection confirmed backend/preload modules, the local PDF worker, unpacked arm64 SQLite and the isolated parser. TypeScript, Vite, Playwright and the development Electron npm package are absent from the app archive. Packaged tests execute transactions, SQLite backup/reopen, actual attachment import, encrypted snapshot creation, wrong-password rejection and restoration with the installed runtime dependencies.

## Acceptance covered

UI checks exercise empty-library creation, actual click/select/type editing, links, bold and tables, a burst of 32 section updates, immediate navigation flush, normal close with final keystrokes, restart persistence, layout/appearance preferences, repeats, search and numeric ordering, ordered scheme creation and keyboard reordering, metadata edits followed by further editing, parent Trash restoration, demonstration isolation, tracker status/focus, backup controls, and small/zoomed windows. Screenshots are in `artifacts/ui/`.

Functional checks import real synthetic PNG, two-page PDF, CSV and XLSX files; render and page actual PDF pixels; reopen all five export formats (including macOS textutil readback of RTF/DOCX); verify Trash/purge numbering; and restart the app. Settings-based restoration replaces open documents even when the archive retains the same run IDs, restores four attachments, closes old editor instances, and immediately applies restored appearance/layout. Screenshots are in `artifacts/functional/`.

Storage/recovery tests cover duplicate/monotonic numbering, stale writes, mid-transaction rollback, migration/schema/FK failures, parent-child Trash semantics, shared object retention and orphan cleanup, interrupted import/cancellation, malformed/oversized previews, cached spreadsheet formula results without formula execution, export selection/order/Unicode/tables/assets and overwrite rollback, encrypted header/ciphertext tampering, wrong passwords, truncation, traversal, missing/zero-byte objects, unsupported document schemas, cancellation, seven-snapshot retention, unavailable destinations and interrupted copies. Real child-process termination tests cover the restore switch phases and startup journal recovery.

## Practical limits and remaining manual checks

- Backups are bounded to 2 GiB archive/expanded data, 1 GiB per included file, and 10,000 archive entries. An oversized library fails as a whole; no partial backup is published. Preview limits and export fallback limits are documented in `HANDOFF.md` and shown in the app.
- Automated safeStorage tests use test doubles. The user's actual Keychain setup, Box Drive upload, and cloud download/restoration must be confirmed on that account. A verified local Box-folder copy is not proof of cloud upload. Password/folder setup remains a first-run user action.
- Failure tests inject I/O errors and terminate processes. They do not fill the physical Mac disk or simulate hardware power loss. Native pickers use disposable selections in automation; no personal Box destination was written.
- Clean-Mac acceptance, Developer ID signing, notarization and public distribution remain separate. Zotero, Google Docs, dictation and scientific viewers remain deferred.

See `RECOVERY.md` for normal restore, rollback-copy handling, password protection, backup retention and deletion behavior. Machine-readable delivery metadata is in `artifacts/release.json`.
