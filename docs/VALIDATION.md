# LabMate 0.4.3 Midnight Purple validation

Verified 2026-09-10T00:16:51.514950+00:00. Local Apple Silicon review build on `ec51ff7`; changes remain uncommitted and unpublished.

**Midnight Purple** is a seventh separate palette in Settings. The light end is soft purple; appearance 100 has a pure black canvas with violet controls, selected states and header tint. The six existing palettes and notebook/status identities retain their colors. Original Sage remains the default.

- Application: `out/LabMate-darwin-arm64/LabMate.app`
- ZIP: `artifacts/LabMate-0.4.3-macOS-arm64.zip` (177,467,319 bytes)
- ZIP SHA-256: `60a9d333a601a95d4b2580f5665767bc62cfb5e153e28e7ea5798531d54a57f3`
- app.asar SHA-256: `f109003126f0b01359fd4d9ba3f2e46852b9393d9090fccb2b0aafdc378cc086`
- ZIP readback: `artifacts/archive-check-0.4.3.txt`.

| Current check | Result | Evidence |
| --- | --- | --- |
| TypeScript, renderer, desktop syntax, Swift helper and arm64 packaging | Passed | `artifacts/release-0.4.3/package.txt` |
| Backend/package, migration, recovery and existing subsystem tests | 132 passed, zero failures/skips | `artifacts/release-0.4.3/backend.txt` |
| All seven palettes across the 101-position slider | 707 combinations passed; minimum tested text contrast 4.50:1 | `artifacts/release-0.4.3/appearance.txt` |
| Packaged palette Settings, persistence and full restart | 12 checks passed; 31 screenshots | `artifacts/palettes/checks.json` |
| Packaged existing functional workflows | 12 passed | `artifacts/functional/checks.json` |
| Visual inspection | Black/violet directory and narrow Settings view readable and unclipped | `artifacts/palettes/midnight-100-directory.png`, `artifacts/palettes/midnight-100-narrow.png` |

Schema 3 expands the palette constraint through a transaction that rebuilds only preferences. Tests use genuine schema-2 tables with the old six-palette CHECK, verify every snapshot value survives migration, verify rollback on failure, restore authenticated schema-1 and schema-2 backups, roundtrip Midnight Purple through encrypted schema-3 backups, and reject schema-2 archives that falsely contain the new palette. Unsupported future versions remain rejected. All testing used disposable libraries/profiles/destinations; the working library and Box account were not modified.

The palette UI checks also cover keyboard radio navigation/focus, reduced motion, narrow windows and exact black at the darkest endpoint. Feature acceptance from 0.4.2 and prior releases below remains historical; this pass changes appearance and its persisted preference support.

---

# LabMate 0.4.2 material yield baseline

Verified 2026-09-09T21:26:06.234621+00:00. Local Apple Silicon review build on `ec51ff7`; working-tree changes remain uncommitted and unpublished. The new workflow marks one starting material and one product across a run's editor sections, automatically parses amounts/units/equivalents, and copies theoretical and actual yield. Parse failures open the persisted manual-entry popup. Existing yield cards remain supported.

- Application: `out/LabMate-darwin-arm64/LabMate.app`
- ZIP: `artifacts/LabMate-0.4.2-macOS-arm64.zip` (177,464,892 bytes)
- ZIP SHA-256: `1dc876aaedfb94f53fff7ae398532fa6efd50fbe37b8d6a70331bcd454f90a71`
- app.asar SHA-256: `468bfbf492b50c24ae779f029c8c632fd08b046f8b1b05f439e3bf2c69ba479c`
- ZIP readback: `artifacts/archive-check-0.4.2.txt`.

| Check on current sources/package | Result | Evidence |
| --- | --- | --- |
| TypeScript, desktop syntax, Vite, Swift helper and arm64 package | Passed | `artifacts/release-0.4.2/package.txt` |
| Backend/package, parser, persistence/export, clipboard bridge and native lifecycle | 127 passed; zero failures/skips | `artifacts/release-0.4.2/backend-final.txt` |
| New packaged material markup workflows | 7 passed | `artifacts/material-yield/checks.json` |
| Existing packaged yield cards | Passed | `artifacts/release-0.4.2/legacy-yield.txt` |
| Packaged functional workflows | 12 passed | `artifacts/functional/checks.json` |
| Packaged existing UI workflows | 13 passed | `artifacts/ui/checks.json` |
| Packaged dictation UI with mocked speech | 7 passed | `artifacts/dictation/checks.json` |
| Packaged table editing and enlarged dialog | Passed | `artifacts/release-0.4.2/tables.txt` |
| Appearance continuum | 606 palette/position combinations passed | `artifacts/release-0.4.2/appearance.txt` |
| Visual review | Manual dialog at 600px viewport and editor at 1100px inspected, readable and unclipped | `artifacts/material-yield/manual-entry-narrow.png`, `artifacts/material-yield/marked-yield.png` |
| Native speech helper signature | Valid ad-hoc bundle signature | `codesign --verify --strict` |

New coverage verifies spacing variants, mixed molar units and non-1:1 equivalents (75% example), zero product, scientific notation, ambiguous/invalid inputs, numeric range, above-100% handling, formatting splits, separate Undo/Redo, cross-section calculation, autosave/reopen, explicit manual correction and exact-source invalidation. Manual values and marks survive encrypted backup restoration; repeats clear semantic roles while keeping copied prose and ordinary formatting. HTML/RTF/DOCX retain role colors; all five exports identify roles without exposing internal mark identifiers/manual metadata.

Clipboard UI checks invoke the real typed bridge and shared parser; only the final Electron clipboard write is captured inside the disposable app. The user's clipboard was neither read nor changed. Invalid or stale manual input never writes a result. All app/backup checks use disposable libraries, profiles and archive destinations. No working library or Box account was replaced.

Usage and limitations are in `YIELD-MARKUP.md`. Theoretical yield is molar; no molar mass, density, purity or automatic limiting-reagent inference is performed. The prior speech live acceptance and external Box/distribution limits below remain separate; this pass did not access the microphone or user's Box account.

---

# LabMate 0.4.1 feedback baseline

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
