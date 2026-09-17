# LabMate 0.6.0 release record

Status: implementation and release-candidate qualification. Real-account Box
recovery, user dictation acceptance, and installation acceptance must be recorded
before treating this as the daily-use release. No software can promise literal
100% reliability.

The release branch integrates `codex/zotero-citation-labels` without rewriting
history. Schema 6 adds Solid/Glass and a durable change token. Schemas 1–5 remain
restorable; existing palettes, experiment-wide references, explicit citation
styles, and neutral white exports remain intact.

## Protection behavior

SQLite and managed attachments remain in local Application Support. Automatic
checkpoints target changed work every 15 minutes while running, catch up on
launch/resume, and flush drafts before normal quit. The timer checks due work at
one-minute intervals. There is no scheduler after quitting. Long operations or
resource failures can make protection overdue; the interface reports this
rather than advancing the captured revision or time prematurely.

The database capture is exclusive and short. Private hard links pin immutable
objects. Compression, encryption, and verification run in a separate worker
thread. Box access runs in a disposable child process with its own filesystem
queue and a bounded timeout, after the local checkpoint is durable. Ordinary
saves resume after capture. Restore stays exclusive. Selected incoming archives
are first copied into private local staging; an unavailable provider can be
cancelled without occupying the library worker.
The encrypted local checkpoint is verified before it is cataloged; a missing
Box folder leaves a persistent pending delivery. Existing backup passwords stay
protected by macOS secure storage with no plaintext fallback. Quit waits for
local capture and verification, then allows pending Box delivery to be deferred
explicitly. Repeated quit requests cannot bypass this boundary.

Rotation keeps the union of 16 recent, 30 daily, and 12 weekly archives, plus the
last successfully rehearsed archive. Overlapping selections count once. Pending
deliveries and rollback evidence are retained conservatively, so prolonged Box
unavailability can require additional disk space. Pruning checks catalog
ownership and the exact archive hash. Unknown or changed files are retained.
Changing the Box destination leaves copies at the previous destination alone.

A local checkpoint, a verified Box-folder copy, a cloud upload, and a recovery
rehearsal are distinct events. LabMate cannot infer cloud upload from a local
copy. See [Box's offline-content documentation](https://support.box.com/hc/en-us/articles/360043697574-Making-Content-Available-Offline).

Supported limits are 2 GiB archive/expanded content, 1 GiB per file, and 10,000
entries. Import checks unique content, database size, and temporary space. Database
growth is rejected if it would cross complete-backup capacity. Existing oversized
libraries get an actionable status. Recovery material is never rotation-pruned.

Restore authenticates and validates the incoming archive before preserving the
current files. It can recover over a corrupt current database or missing current
attachment. Cancellation ends before the switch. The durable `opened` phase is
the commit boundary; later cleanup failures return the restored snapshot with a
warning. Startup completes cleanup or restores the previous coherent pair.

## Audit regression map

| Finding | Regression evidence |
| --- | --- |
| A01 Undo/Redo across records | `scripts/check-release.cjs`, all four sections and persisted readback; `check-functional.mjs`, same-ID restore |
| A02 cleanup after restore | `tests/daily-use.test.cjs`, cleanup warning and fresh reopen |
| A03 cancellation at commit | `tests/backup.test.cjs`, cancellation before/during the switch |
| A04 Markdown ownership/rollback | `tests/exports.test.cjs`, unrelated files and retained failed rollback |
| A05 whole-notebook export | `scripts/check-release.cjs`, each format and scope |
| A06 offered sort orders | `shared/ordering.cjs`, `scripts/check-release.cjs` |
| A07 Trash ancestry | `scripts/check-release.cjs`, persisted experiment restoration |
| A08 export ancestry | `tests/exports.test.cjs`, every scope |
| A09 damaged current attachments | `tests/daily-use.test.cjs` |
| A10 unblurred captions | `scripts/check-release.cjs`, native close and database readback |
| A11 startup Retry | `tests/daily-use.test.cjs`, remove obstruction and retry same worker |
| A12 full mutation responses | `tests/daily-use.test.cjs`, bounded deltas; `scripts/check-performance.mjs`, packaged 1,000/5,000-run measurements |
| A13 Recent navigation | `scripts/check-release.cjs` |
| A14 terminal preview progress | `scripts/check-release.cjs` |

Recovery tests terminate a real subprocess at each durable restore phase and
reopen the library. Lifecycle checks use a disposable password with actual macOS
secure storage, restart with delivery queued, simulate resume, save on quit,
change passwords, and rehearse older archives with their original password.
They do not contact the user's Box account.

Candidate measurements: 5,000 runs, approximately 47.8 MB initial snapshot;
preference update 481 bytes and about 0.6 ms store work. During a packaged backup,
39 saves had about 2 ms median, 102 ms 95th percentile, and 122 ms maximum latency.
A 2,131,361,983-byte encrypted archive recovered 2,032 MiB of attachments. The
latest candidate capacity backup and recovery exercise took about 99 seconds. These are
measurements on this Mac, not timing guarantees.

## Package identity and final gates

`npm run package:mac` requires committed release source. The package contains
`Contents/Resources/LabMate-release.json`: version, schema, commit, source hash,
and hashes for every shipped desktop/shared/renderer file. Package checks compare
those bytes to the checkout. `LABMATE_REQUIRE_PACKAGE=1 npm run test:backend`
requires package checks; an old package cannot silently pass by version alone.
A dirty candidate can be built explicitly for investigation, but fails the
matching-package acceptance gate.

Final evidence belongs in `artifacts/release/`. Record the final artifact hashes
and keep automated/backend, packaged/native, and real-account acceptance separate.
The prior 0.5.1 package is preserved there. Preserve a verified consistent copy of
the working library before installation or migration.

The working schema-5 library was copied and verified before migration. The user
configured secure storage and a dedicated UCLA Box folder. The first encrypted
checkpoint was verified locally, observed online, and freshly downloaded with an
identical SHA-256 hash. Evidence is in `artifacts/release/box-online/`.

Remaining live gates: test and restore the downloaded archive in a disposable
profile using the password; pin that rehearsal;
verify credentials after installation/restart; dictate a real utterance and repeat
offline; inspect Glass on the actual desktop and with macOS accessibility settings.
Do not infer these outcomes from fixture tests.
