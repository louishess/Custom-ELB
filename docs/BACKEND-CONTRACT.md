# Backend contract — implementation 0.4

PM-owned shared contract is `shared/contracts.ts`. Coordinate amendments with PM before changing it. All renderer-facing API methods return `{ok:true,value}` or `{ok:false,error:{code,message}}`. Internal service methods return raw values and throw errors with a `code`; `store.dispatch` may return an envelope because worker normalizes it. In particular snapshot/getAttachment/backupDatabase/close/reopen and attachment mutation helpers MUST NOT hide failures inside an unchecked Result. Mutation results are complete snapshots; renderer must not overwrite unsaved editor drafts when applying a snapshot. Snapshots include trashed entities (frontend derives ancestor visibility); no paths, credentials, or fictional fixtures are returned. Backend defaults to empty. Dates are validated YYYY-MM-DD local calendar values. IDs are UUIDs. Errors distinguish VALIDATION, NOT_FOUND, STALE_REVISION, IO, CANCELLED, UNAVAILABLE and CORRUPT_BACKUP.

## Module ownership and interfaces

- Storage lead: `electron/backend/store.cjs` exports `LibraryStore` class. `new LibraryStore(root)` opens/migrates isolated root. Public `root`, `databasePath`, `db` (better-sqlite3); `snapshot()`, synchronous `dispatch(method,payload)` for records/documents/schemes/preferences/trash, `async backupDatabase(destination)`, `close()`, `reopen()`. Database name `library.sqlite`; immutable attachment objects at `root/objects/<sha256>`. Counters persist after purge. `attachment` metadata table is store-owned. Expose `addAttachment(record)` (uses AttachmentRecord fields), `getAttachment(id)`, `updateAttachment(id,caption)`, `removeAttachment(id)`; these methods validate active parent and transact; metadata operations return snapshot except getAttachment returns record. Files lead must use these methods rather than independent SQL schemas. Purge deletes metadata, then garbage-collect unreferenced objects ONLY when backup not active. Store has public `backupLocks` integer; backup increments/decrements in finally. Cleanup can conservatively leave orphans until next launch when unlocked. Store startup cleans staging safely. Do not remove referenced objects.
- Storage lead: `electron/backend/backup.cjs` exports `createBackupService(store, options={})`. Methods `create({password,destination,jobId}, context) -> {name,createdAt,message}`, `restore({password,source,jobId},context) -> snapshot`. `context` has `signal` AbortSignal, `onProgress(event)` optional. Credentials/config are never backed up. Encrypted archives in root/backups; staging in root/staging; manifest and DB plus referenced objects only. Restore swaps only library DB/objects, preserves local config/backups, and reopens same store object. Retain a rollback library after restore. Always authenticate fully before extracting. Enforce bounded extraction, no traversal/symlinks/duplicates. Future schema is rejected. Backup consistency: block mutations during DB snapshot + reference manifest capture, immutable objects + backupLocks thereafter. Worker serial queue provides mutation exclusion for entire backup/restore as simple safe v1.
- Files lead: `electron/backend/files.cjs` exports `createFileService(store)`. Methods `importFiles({runId,paths,jobId},context) -> snapshot`, `preview({id,jobId},context) -> Preview`, `getPath(id) -> validated managed path`, `update({id,caption}) -> snapshot`, `remove({id}) -> snapshot`. Paths only injected by MAIN native picker, never public renderer payload. Files immutable SHA-256 objects; refuse symlink escapes. Spreadsheet parsing in isolated child process, cancellation/timeout kill; PDF worker renderer-local.
- Files lead: `electron/backend/exports.cjs` exports `createExportService(store,fileService)`. `write({...ExportRequest,destination},context) -> {cancelled:false,name,warnings}`. Main owns save dialog and injects destination. Atomic/staged output, never overwrite without native dialog confirmation. Markdown companion assets named for output stem. Resolve selection and scheme before writing. Selected export in scheme order includes only selected members; notebook scheme order exports scheme members; return explicit validation error for selected records outside chosen scheme. Other ordering values use current fixture sortOptions plus stable ID fallback. Preserve basic marks/tables in rich formats. Available export previews mean raster images and spreadsheet tables; PDF/scientific files may use caption fallback with explicit warning.
- Files lead: `src/AttachmentPreview.tsx` default export takes `{attachmentId:string}`; uses window.labmate.attachments.preview, maintains its own job cancellation, bundled pdfjs worker (Vite asset URL), native image rendering, bounded spreadsheet table. Desktop lead mounts it in attachment dialog and owns surrounding caption/open/remove controls.
- Desktop lead: `electron/backend/worker.cjs` instantiates services with root passed in process args. UtilityProcess uses parentPort; messages `{id,method,payload}`, reply `{id,result}`; progress `{event:'progress',value:JobEvent}`. Validate worker inputs too. Main injects trusted paths/passwords; schemas must distinguish internal from external payloads. Serialize operations; jobs.cancel must bypass serial queue and abort active job. On worker exit reject all pending requests; offer retry/restart without false success. Never replay mutations automatically.
- Desktop lead: main/preload and all frontend except AttachmentPreview. Main native dialogs and safeStorage; single instance lock; backend root default app.getPath('appData')/LabMate, test override `LABMATE_LIBRARY_ROOT`; userData/test profile separate from live data. Main close handshakes renderer flush, then closes worker DB. Main offers no arbitrary renderer requests; allowlisted methods with exact schemas, top-frame validation, existing sandbox/network restrictions. Backend progress bridged to matching app window. safeStorage encrypted password and destination stored in local config outside snapshots; backup status returns display folder name only. Missing Keychain availability means prompt to retry setup, no plaintext fallback. Daily backup schedule/catch-up runs only when configured, not concurrent; last success updated after complete verified copy. Restore asks native destructive-action confirmation after password/file selected, saves current edits first.

## Cross-cutting frozen choices

Storage schemaVersion 2 (schema 1 remains restorable and migrates transactionally); preferences add palette with default sage; section JSON root type doc, empty paragraph default. Revision increments on each record change. Run save includes all four documents in single transaction. Independent metadata changes can yield STALE_REVISION: UI must retain pending draft and offer reload/retry, not silently replace content. Notebook/experiment renames don't change numeric IDs. Repeat copies Information and Method; date supplied by renderer validated, author/title copied, Notes/Data empty, no attachments or scheme memberships copied. Scheme membership is ordered UUID list, same notebook only, unique. Trash restore requires ancestors active (UI offers restore parent first); purge only trashed records and validates revision. Initial setup includes author entry field; no accounts. Trash permanence does not remove existing backups.

Installation/package/lockfile and shared types belong to the primary integrator.
All tests use disposable libraries and destinations; no real Box writes or
personal records during automated validation.

## Version 0.4 additions

- `schema.cjs` is the source of truth for supported SQLite versions and required
  columns. Restore validates the authenticated candidate against its own
  supported version, not against the currently open database's columns.
  Store migration from v1 to v2 is transactional and adds palette=sage.
- Preferences palette is one of sage/ocean/lavender/terracotta/rose/graphite;
  validate it at the main/worker/store boundaries.
- `yieldCalculation` is an atomic Tiptap node with version 1 inputs in attrs.
  Numeric inputs are strings so incomplete drafts survive autosave. The shared
  `yield.cjs` validates the shape and computes outputs for both UI and exports.
  Derived results are never authoritative persisted values. UI adds cards in
  Data; all section editors register the node to avoid destructive parsing.
- Dictation remains in main/native helper, outside the serial SQLite worker.
  `dictation.capabilities`, `prepare`, `start`, `stop`, `cancel` and
  `onDictation` use the shared typed contract. Sessions belong to the originating
  webContents; only that renderer receives events or controls its session.
  No renderer-provided helper path, audio path, shell or network operation is
  accepted. Parent/renderer shutdown terminates capture. The modal binds
  insertion to the originating document and rejects a changed target.
- Backups add `changeDestination` (reuse encrypted credentials) and
  `revealDestination` (native configured-folder opener). Setup chooses a real
  folder inside detected Box Drive. Local config retains format version 1 with
  optional lastAttemptAt/lastFailure fields; snapshots contain no credentials.
  BackupStatus reports configured/available separately and includes sanitized
  progress plus attempt/failure details. A local verified copy never claims
  cloud-upload completion.

Storage-only citation_associations v1 table reserves id, run_id (FK cascade), source_instance, library_id, item_key, snapshot_json and created_at, unique per run/source/library/item. It starts empty and has no renderer methods until Zotero integration.
