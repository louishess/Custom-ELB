# LabMate 0.4.1 feedback fixes

Verified 2026-09-09T20:59:53.122273+00:00. Local review build; changes remain uncommitted and unpublished. This pass fixes dictation startup/restart and the cramped Insert Table dialog. Yield calculation behavior is unchanged.

- Application: `out/LabMate-darwin-arm64/LabMate.app`
- ZIP: `artifacts/LabMate-0.4.1-macOS-arm64.zip` (177,453,754 bytes)
- ZIP SHA-256: `6bf83ec5ea3fea37ee434ad5872a16dcecb81291032941943d7bc8c31aeb63fa`
- app.asar SHA-256: `99d7f01b6356832e71a1fdfe8caab748708748fc60a4850693c3b39a92b42d66`
- ZIP readback: `artifacts/archive-check-0.4.1.txt`.

The immediate Start failure was reproduced: general locale availability said English was installed, but the exact progressive transcription module was unprepared. Start now reserves and prepares that module first. A real microphone diagnostic then exposed a second-start audio configuration interruption. The helper now retains its stopped engine and reconnects valid route changes without replacing the active analyzer or transcript. Operation/generation guards prevent cancelled preparation, late Stop replies and obsolete native callbacks from changing a new recording.

| Current check | Result | Evidence |
| --- | --- | --- |
| TypeScript, Vite, native Swift build and arm64 packaging | Passed | `artifacts/release-0.4.1/package-build.txt` |
| Backend/package and native lifecycle tests | 98 passed, zero failures/skips | `artifacts/release-0.4.1/backend-tests.txt` |
| Packaged dictation UI | 7 passed, mocked transcripts | `artifacts/dictation/checks.json` |
| Exact English model preparation | Unprepared → ready → installed verified | Native helper preparation smoke |
| Real on-device synthetic audio recognition | Expected reaction/yield/analysis sentence recognized | `artifacts/dictation/native-synthetic-audio.json` |
| Packaged real microphone lifecycle | Two six-second sessions stayed recording until explicit Stop; immediate restart passed | `artifacts/dictation-live/checks.json` |
| Packaged table workflows and enlarged dialog | Passed structural editing, resizing, Undo/Redo, saved widths, keyboard focus and narrow window | `artifacts/release-0.4.1/table-tests.txt` |
| Table visual inspection | 520px dialog and 480px viewport clean, no clipping | `artifacts/tables/insert-table-after.png`, `artifacts/tables/insert-table-after-narrow.png` |
| Native helper signature | Valid on disk; ad-hoc signature verified | `codesign --verify --strict` |

All desktop checks used disposable libraries and profiles. The live diagnostic retained only timings, states and transcript lengths, with no live audio or transcript text saved. The final two microphone cycles contained no recognized speech; an earlier live diagnostic produced a transcript and exposed the second-start failure (`artifacts/dictation-live/restart-before-fix.json`). Synthetic recognition validates real speech decoding separately. Final live utterance accuracy and offline dictation still need manual acceptance. Normal LaunchServices launch was used because a directly spawned automated app was attributed to Codex for macOS microphone permission.

The broader functional, appearance, yield, backup and export baseline below belongs to 0.4.0. Those workflows were not redesigned in this feedback pass. Box upload/download, user Keychain setup and public signing/notarization remain manual or out of scope as documented below.

---

# LabMate 0.4.0 baseline validation

Verified 2026-09-09T19:43:21.363719+00:00. Built on commit `dc90f1d`; feature changes remain uncommitted and unpublished. All automated desktop work used disposable libraries/profiles and synthetic records.

## Deliverables

- Application: `out/LabMate-darwin-arm64/LabMate.app`
- ZIP: `artifacts/LabMate-0.4.0-macOS-arm64.zip` (177,445,345 bytes)
- ZIP SHA-256: `4cf6f42bd33cfe38e75cc48e10d76cf9954cdb001bfc52ff84bcd82b42bdb148`
- app.asar SHA-256: `6329328ee425a6df828381c9f376e2381396d6130b97fc24e7cb4ebd84825c57`
- ZIP CRC/readback: passed (`artifacts/archive-check.txt`).
- Electron 44.3.0 / Apple Silicon. Native speech helper compiled with the macOS 26 SDK and its ad-hoc bundle signature verified. This is a local review build without Developer ID signing or notarization.

## Verified results

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript, desktop/shared syntax, Vite, native Swift compilation and Mac packaging | Passed | `artifacts/package-build.txt` |
| Backend and package tests | 97 passed; zero failures/skips | `artifacts/backend-tests.txt` |
| Packaged functional workflows | 12 passed | `artifacts/functional/checks.json`, `artifacts/functional-tests.txt` |
| Packaged existing UI workflows | 13 passed | `artifacts/ui/checks.json`, `artifacts/ui-tests.txt` |
| Six palettes across brightness continuum | 606 combinations; minimum 4.50:1 tested text contrast | `artifacts/appearance-tests.txt` |
| Packaged palette Settings and persistence | 11 passed; 27 screenshots | `artifacts/palettes/checks.json` |
| Packaged dictation review/dialog behavior | 4 passed using synthetic transcript events | `artifacts/dictation/checks.json` |
| Packaged table editing | Passed chooser, row/column/header actions, merge/split, drag sizing, fit, Undo/Redo, layouts and exact saved widths | `scripts/check-tables.mjs` |
| Packaged yield card | Passed live math, incomplete drafts, reload, removal/Undo, immediate navigation/close flush, layouts and repeat reset | `scripts/check-yield.mjs`, `artifacts/yield/yield-calculation.png` |
| Native speech capabilities | Available; 30 supported locales; US English assets installed | Packaged helper read-only IPC smoke check |
| Dependency inventory | 339 resolved packages, 37 direct; no new third-party dependency | `docs/DEPENDENCIES.md` |
| Patch whitespace | Passed | `git diff --check` |

## Data and behavior acceptance

Schema 1 libraries migrate transactionally to schema 2 with Original Sage while preserving records and preferences. An authenticated schema 1 archive restores and migrates successfully. A mismatched schema-zero candidate is rejected before replacement. Backup status/configuration tests cover saved-password destination changes, canonical Box containment, unavailable folders, cancellation/failures, daily progress, and clear local-copy status. Existing archive tampering, rollback and interrupted restore tests pass.

Yield cards save versioned input strings through document autosave and revision checks; incomplete and invalid numbers remain editable. Shared pure math converts mol/mmol/µmol/nmol, handles the 2:1 mixed-unit 75% example, permits zero product, and flags over-100% results. Exports recompute readable summaries. HTML/RTF/DOCX preserve column widths, simultaneous row/column spans and headers, including a 50-row merge. TXT/Markdown include layout-loss warnings. Repeat clears Data, including yield cards.

Dictation tests exercise the actual desktop bridge with a mocked speech service: partial/final and late results, foreign session isolation, correction preservation, inline saved-selection insertion, separate Undo, cancellation/discard, and close veto/cleanup. Native compilation, bundle signature and runtime capabilities were checked separately. No recorded or synthetic transcript is represented as a real microphone accuracy test.

Palette and yield screenshots were visually inspected for readability and clipping. Native controls remain discoverable in both editor layouts; reduced-motion and small-window behavior were checked. Persistence polling explicitly awaits API readback before asserting saves.

## Remaining local acceptance

- **Microphone:** actual microphone permission, a live utterance and offline utterance after asset installation are not verified. In an experiment select a section, choose Dictate, Start, allow the macOS prompt, speak a short sentence, Stop, correct and Insert; confirm Undo. Repeat with internet disconnected after confirming the selected language is installed. LabMate stores no audio.
- **Box and Keychain:** user password setup, real cloud upload, fresh Box download and restoration into a disposable library remain manual. Automated tests never wrote the user's Box account. Follow `RECOVERY.md`; never rehearse by replacing the working library.
- **Distribution:** clean-Mac installation, Developer ID signing/notarization, updates and Intel packaging remain outside this local review release.

The live library remains local and is not password-encrypted; backup archives are encrypted. Existing backup size limits and seven-local-snapshot retention remain unchanged. Zotero, Google Docs, scientific viewers, live cloud synchronization and multiuser workflows remain deferred.
