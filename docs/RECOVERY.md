# LabMate data and recovery

## Where records live

LabMate keeps its working SQLite database and copied attachments in `~/Library/Application Support/LabMate/`. Do not move the live library into Box Drive or edit its contents while LabMate is running. Imported originals remain untouched. The application copies each imported file into managed storage and verifies its content hash.

The local library is not password-encrypted. The password described below protects portable backup archives. FileVault and your Mac account protect local files according to your macOS configuration.

## Save status

Editing saves automatically after a short pause and during continuous editing. Wait for the saved indicator before treating edits as durable. A failed or stale save keeps the draft available in the open application. Resolve the displayed error before closing; force-quitting can lose edits that have not reached the database.

## Trash

Move records to Trash to remove them from ordinary notebook and tracker views. Restore a trashed parent before restoring a separately trashed child. Permanently deleting an item also removes its descendants and attachment references. A managed file remains if another record still references it.

Permanent deletion affects the current library. Existing backup archives and the retained pre-restore rollback library may still contain those records.

## Set up encrypted backups

Open Settings → Backups, enter and confirm a password, then choose a destination folder inside the detected Box Drive directory. If Box Drive is unavailable, open or install it and retry. After setup, use Create first backup to produce and verify the initial copy. Show in Finder opens the configured folder. Change destination reuses the saved password; changing your password affects future archives only. Keep the password in a separate password manager: it is required to restore a backup on another Mac. LabMate remembers it locally using macOS-protected secure storage, but that local secret is deliberately excluded from backups.

Once configured, LabMate creates a daily backup while open and catches up at the next launch. Back up now creates an additional snapshot. Snapshots include records, preferences, Trash, and referenced managed attachments. The application retains the newest seven local encrypted snapshots; destination backups remain until you remove them.

This release bounds backups to 2 GiB of archive/expanded data, 1 GiB per included file (including the database), and 10,000 archive entries. A library exceeding these limits is rejected with an error; a partial archive is never reported as a successful backup. Files can remain attached even when they exceed preview or backup limits. Keep separate copies of oversized data and check backup status before relying on protection.

Completed archives use `.labmatebackup`. “Saved to Box Drive” means the file was written and verified locally. Box Drive controls upload; confirm availability through Box when you need proof that a backup has reached the cloud. Settings shows folder availability, live progress, the last attempt, the last verified local copy with date and time, and the latest failure. Failed or cancelled attempts do not advance the last-success timestamp. An unavailable destination does not stop local editing. Check the reported backup error and retry after the folder is available. A new destination has no verified copy until the first successful backup there. Symbolic links are not the backup mechanism; the live database remains outside Box Drive.

## Restore

Save current edits first, then use Restore backup in Settings. Choose a completed archive and enter its password. Restore replaces the current working library after confirmation; it does not merge two libraries.

LabMate authenticates the encrypted archive, validates its file paths and hashes, checks the database, and preserves the current library for rollback before switching. A wrong password, damaged archive, missing attachment, or unsupported newer schema is rejected. Do not remove staging or recovery files during an interrupted restore: startup recovery needs them.

After a successful restore, LabMate closes the old editors, returns to the notebook directory, and applies the restored appearance and layout. Open a notebook to inspect its restored contents before continuing work.

Pre-restore copies are retained under the working library's `rollback/rollback-*` folders. Each contains a consistent `library.sqlite` and its `objects` directory. Prefer restoring an earlier encrypted archive through Settings. If manual rollback is needed, quit LabMate first, preserve a complete copy of the current library, and recover the database and objects together from one rollback folder into a separate library for inspection. Do not mix databases and attachment directories from different snapshots or overwrite a running library.

## Rehearse recovery without replacing your library

1. Create a backup and record its filename and last verified local-copy time in Settings.
2. In the Box website or mobile app, confirm the completed `.labmatebackup` archive is present. Download a fresh copy from Box; this is the cloud-transfer acceptance step that LabMate cannot verify itself.
3. Quit LabMate. Launch the local review build with a disposable library and profile using the commands below. These locations are newly created temporary folders; never substitute your working library path.
4. In that disposable instance, use Settings → Backups → Restore backup, provide the archive password, and select the downloaded copy. Confirm replacement of the empty disposable library.
5. Inspect notebooks, runs, all four sections, tables and their widths, yield calculations, preferences, Trash, and representative attachments. Record the archive name, download date, and observed results.
6. Quit the disposable instance before reopening your normal LabMate application. Retain the test directory until the rehearsal is accepted; remove only that disposable directory when finished.

```sh
LABMATE_REHEARSAL_ROOT="$(mktemp -d -t labmate-recovery)"
LABMATE_LIBRARY_ROOT="$LABMATE_REHEARSAL_ROOT/library" \
LABMATE_TEST_PROFILE="$LABMATE_REHEARSAL_ROOT/profile" \
"/absolute/path/to/LabMate.app/Contents/MacOS/LabMate"
```

Replace the application path with the review build's actual path. The application has a single-instance guard, so quit any running normal instance first. Automated tests use only synthetic archives and disposable destinations. Real Box upload/download acceptance is a separate manual check. A successful local export is not a substitute for a complete backup.

## Deferred services

Zotero, Google Docs, live cloud synchronization, shared accounts, scientific file viewers, signing, and notarization are separate milestones. No credentials for those services are required to use the local notebook.
