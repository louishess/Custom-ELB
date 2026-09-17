# Protecting and recovering LabMate

LabMate saves your working library on this Mac, outside Box. An encrypted backup
is a separate recovery copy. A failed save keeps its draft in the open window;
resolve it before closing. Force quit cannot preserve work that has not saved.

## First setup

Open **Settings → Backups**, choose and confirm a password, and select a dedicated
folder inside Box Drive. Keep the password in a password manager. LabMate stores
its remembered copy using macOS secure storage; credentials are excluded from
archives and there is no plaintext fallback.

Choose **Create first backup**. Check the separate local checkpoint and Box-folder
copy times. Box uploads asynchronously: a verified folder copy does not prove an
online copy exists. Confirm the archive on the Box website and download it freshly
before relying on cloud recovery. Older archives always need their original
password, even after you change the password for future backups.

While LabMate is open, changed work is checkpointed every 15 minutes, checked at
one-minute intervals, with catch-up after launch or sleep. Unchanged work is
skipped. Normal quit flushes text and captions and finishes a safe local backup
boundary. If Box delivery is pending, you can keep LabMate open or explicitly quit
with that delivery recorded for the next launch. No backup scheduler runs after
LabMate quits.

Local checkpoints continue when Box is unavailable. Change destination if its
folder was moved; pending archives retry automatically. Copies in the former
folder are left alone. A failure never advances the captured revision or time.
Check the overdue indicator and available-space warning, especially for large
libraries or prolonged offline work.

Rotation retains 16 recent, 30 daily, 12 weekly copies and the latest successfully
tested archive, counting overlaps once. Required pending deliveries and recovery
material are also preserved. Only cataloged archives with matching hashes are
pruned. Unknown files remain untouched.

Each complete backup supports 2 GiB of archive/expanded data, 1 GiB per individual
file including the database, and 10,000 archive entries. Imports that exceed
complete-backup capacity are rejected. Existing oversized libraries are flagged.
Temporary verification and retained history need additional free space; Settings
shows an estimate. Very large backups can take several minutes.

## Test recovery

1. Download a completed `.labmatebackup` file from Box online.
2. In **Settings → Backups**, enter that archive's password and select **Test recovery**.
3. Choose the downloaded file. LabMate authenticates it, restores to a temporary
   library, checks records, documents, preferences, citations, and attachment
   hashes, and reports the result without replacing your working library.
4. A successful test pins that archive against rotation. Record its filename and
   the download/test date. LabMate records the test date, but cannot determine
   whether your selected file came from a fresh online download.

For the release acceptance rehearsal, additionally restore the downloaded file
into a disposable profile and inspect representative content. Automated tests
use synthetic data and do not establish real Box upload/download acceptance.

## Restore your library

Enter the archive password and choose **Restore backup**. Select the file and
confirm replacement. Restore replaces the library; it does not merge libraries.
Use the same recovery controls on the startup error screen if your current
library cannot open. Retry on that screen actually retries service initialization.

LabMate checks the incoming archive before switching. Wrong passwords, damaged
incoming files, missing incoming objects, and unsupported schemas leave the
working library untouched. Missing or damaged *current* files do not prevent a
valid recovery; available old bytes are preserved for inspection.

Cancellation is available before the switch. The switch itself must finish.
After commitment, a cleanup error is a warning and the restored library still
opens. Interrupted startup either restores the old coherent files or finishes
cleanup of the committed library. Do not manually delete staging files or the
restore journal after an interruption.

The app returns to the notebook directory with new editor histories, restored
preferences and no stale drafts. Inspect your restored work before continuing.
Version 0.6.0 supports schemas 1–6, migrating older archives transactionally to
schema 6. References remain shared across every run of their experiment. Old
archives get Solid appearance, paper-title citation labels, and no automatically
selected citation style where those preferences were absent.

Pre-restore files remain under `~/Library/Application Support/LabMate/rollback/`.
If the current database was damaged, its preserved copy may also be damaged; it
is retained evidence, not a verified incoming backup. Do not mix a database from
one copy with objects from another. Preserve all material and use a separate
library for manual inspection. Keep the live SQLite database out of Box.

## Disposable recovery profile

This opens an independent library and profile; it does not point at your working
library. Replace the app path with the exact release artifact being tested.

```sh
LABMATE_REHEARSAL_ROOT="$(mktemp -d -t labmate-recovery)"
LABMATE_LIBRARY_ROOT="$LABMATE_REHEARSAL_ROOT/library" \
LABMATE_TEST_PROFILE="$LABMATE_REHEARSAL_ROOT/profile" \
"/absolute/path/to/LabMate.app/Contents/MacOS/LabMate"
```

Retain that temporary folder until inspection is complete. Use the archive
password explicitly, rather than remembered backup credentials.

Trash restoration requires active ancestors. Permanent deletion affects the
working library, not older backups or rollback copies. Google Docs, scientific
viewers, live multi-Mac synchronization, automatic updates, and public distribution
remain deferred. Zotero browsing remains read-only local desktop access.
