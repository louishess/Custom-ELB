# LabMate basic Zotero integration plan

Status: implemented in LabMate 0.5.0, September 12, 2026. This document preserves the approved design and its original planning baseline. Read `ZOTERO.md` for the working behavior and `VALIDATION.md` for acceptance evidence, including the authorized read-only live check with one personal-library reference.

Build a Zotero integration inside LabMate that lets the user browse their connected desktop library and associate references with an experiment. The user confirmed that **citations belong to the whole experiment and appear in every run**.

The proposed connection is to Zotero Desktop on the same Mac, consistent with `integration-notes.md`. Zotero must be running to browse or fetch new reference data. Previously linked references remain readable in LabMate when Zotero is closed. A separate installable Zotero companion plugin can follow later; the initial LabMate picker does not require one.

## 1. Basic user experience

1. In Settings, choose **Connect Zotero**. Show connection status and, when necessary, instructions to open Zotero and enable its local application access setting. Remember the connection preference locally.
2. Open an experiment and choose **Add citation** in the existing citation area. Show the destination experiment label and “Shared across all runs.”
3. Select My Library or an available local group library, optionally select a collection, and search by title, author, or year. Results show title, authors, year, publication, and library context. An empty library produces an honest empty state.
4. Select one or more references, inspect their details, and choose **Add to experiment**. Already-associated items show an “Added” state. Adding the same reference twice does not create duplicate links.
5. All runs of that experiment show the same citation list. Clicking a citation opens its saved bibliographic details, with **Refresh details** and **Remove from experiment** actions. Removing the association leaves the source item in Zotero intact.

Reuse the existing Citation library sidebar entry for browsing without an open experiment. Linking from that view requires selecting a destination experiment. Preserve the current frontend, palettes, continuous/tabbed editor layouts, and keyboard-accessible modal patterns.

Use a simple readable reference format for v1: authors, year, title, publication details, and DOI or URL when available. Handle missing authors/dates and organizational authors without inventing information. Style selection, inline numbered citations, and a full citation-processing engine are later features.

## 2. Connection and scope

Zotero documents a desktop API at `http://localhost:23119/api/`. Read access requires enabling its Advanced setting for local applications, but does not require an API key. This supports a local, offline connection without a hosted LabMate service. [Zotero local API](https://www.zotero.org/support/dev/web_api/v3/local_api)

For v1, expose personal and group libraries that the running client makes available. This does not promise access to cloud-only libraries or changes that have not reached the desktop client. LabMate does not initiate or manage Zotero synchronization.

Implement reads only. Store experiment associations in LabMate. Do not access Zotero's SQLite files or request permission to change Zotero records. Keep PDFs, attachments, annotations, and notes outside this initial import scope; the picker selects bibliographic parent items.

The connection service should expose distinct states: disconnected, checking, connected, Zotero unavailable, local access disabled, unsupported client, source changed, and request failed. Offer a retry action with a useful reason. Disconnect stops requests and clears transient browsing data while preserving the experiment's saved citations.

## 3. Fit with the existing application

The current source confirms these starting points:

| Existing location | Implementation work |
| --- | --- |
| `src/components.tsx`: disabled `CitationChips` | Display saved citations and enable Add citation for an active experiment. |
| `src/panels.tsx`: placeholder `CitationPanel` | Replace with the library/collection picker and saved-reference detail view. |
| `src/App.tsx` | Pass the experiment identity, apply citation snapshots, and preserve pending editor drafts. |
| `shared/contracts.ts`, main/preload allowlists | Add narrow, validated Zotero and citation operations. |
| `electron/backend/store.cjs` | Add experiment-owned citation persistence and transactional mutations. |
| `electron/backend/schema.cjs` | Add the next schema version and restore validation. |
| `electron/backend/exports.cjs` | Include saved reference details in the shared export model. |

The reserved `citation_associations` table is currently **run-owned**, and citations are absent from `LibrarySnapshot`. It cannot provide the confirmed experiment-wide behavior without a schema and contract change. Existing storage alone is not a functioning Zotero integration.

Add a small `electron/zotero.cjs` service for asynchronous local API requests, with SQLite writes still serialized through the existing backend worker. This keeps a slow Zotero request from blocking document autosave or backup work. Reuse installed platform facilities and existing validation dependencies where practical.

## 4. Experiment-owned storage and lifecycle

Add an `experiment_citations` table in the next schema migration (currently schema 3, so provisionally schema 4):

| Field | Purpose |
| --- | --- |
| `id`, `experiment_id` | LabMate association ID and experiment foreign key, cascading on permanent experiment deletion. |
| `source_instance` | Identity of the Zotero database that supplied the reference. |
| `library_type`, `library_id`, `item_key` | Distinguish personal/group libraries and the exact source item. |
| `snapshot_json` | Versioned, validated bibliographic fields saved by LabMate. |
| `created_at`, `updated_at` | Association creation and last accepted metadata refresh. |

Enforce uniqueness on experiment + source instance + library type + library ID + item key. Neither DOI nor title is an identity key: the same article can legitimately occur in multiple libraries. Sort citations deterministically by creation time and association ID for v1.

The snapshot contains only supported reference metadata: item type, title, structured creators, date/year, publication or publisher, volume/issue/pages, DOI, URL, library label, fetched time, and source version when available. Preserve a format version so later readers can interpret it. Do not import arbitrary source HTML, file paths, or attachment contents.

Preserve the existing legacy run-owned table during migration. Released UI cannot populate it, but unexpected rows in an imported or development database must survive; flag these for migration review instead of silently changing their scope or discarding them. Fresh integrations write only the experiment table. Validate restores against the archive's original schema, then migrate transactionally, retaining existing recovery behavior.

Lifecycle rules:

- Repeating a run shows the experiment's existing references automatically; it creates no citation copies. Adding or removing a citation affects all runs, including completed runs, as the user requested.
- A separate new experiment starts without citations. Citation lists are independent between experiments even when they reference the same Zotero item.
- Trashing a run leaves experiment citations intact. Trashing/restoring an experiment or notebook hides/restores its references with the parent. Permanently deleting an experiment removes its associations through the foreign key.
- Add/remove/accepted refresh increments the experiment revision, not the run document revision. Check the expected experiment revision and active ancestors in the transaction. Return the updated library snapshot and retain unsaved run text when applying it.
- Persist the bibliography at association time. Refresh fetches a candidate and shows changed details before replacing the saved snapshot. Metadata changes in Zotero do not silently alter the experiment record.
- An unavailable, deleted, or inaccessible source item leaves its saved reference intact. Distinguish “unable to check” from a confirmed missing item; manual replacement requires selecting a new source.
- Backups include saved associations and metadata through SQLite. Restoring a backup restores those citations and clears outstanding picker/refresh requests. A restored connection is revalidated before live operations resume.

## 5. API and source identity

Use the documented item, collection, and group routes. Prototype `GET /api/`, `/api/users/0/groups`, library collections, library/collection `items/top`, and individual item retrieval. Personal-library requests can use the local user alias; group requests use a group ID. Request JSON and explicitly bound every list request. [Local API](https://www.zotero.org/support/dev/web_api/v3/local_api), [read endpoints](https://www.zotero.org/support/dev/web_api/v3/basics)

Start with 50 results per page, a debounced title/author/year search, and explicit loading of later pages. Filter out attachment, note, and annotation types; a filtered page must still retain its next-page state. Use documented quick search for v1 and defer a promised exact DOI search until verified. [Search and pagination](https://www.zotero.org/support/dev/web_api/v3/basics#searching)

Zotero 10+ documents a stable `Zotero-Server-ID` and instance-specific object versions. Send the observed ID on subsequent reads. An ID mismatch requires a fresh connection and a separate browsing cache; it must not rebind stored citations. Older clients' synced version numbers cannot reliably identify local edits. [Source identity and versions](https://www.zotero.org/support/dev/web_api/v3/local_api#server_id)

For the initial supported-client boundary, require a verified API v3 implementation with stable source identity. Test the user's actual installed build before declaring compatibility. A client without that capability gets an explanatory unsupported-connection state; previously saved citations remain usable. Supporting older clients requires a separately verified identity adapter, not a guessed identity derived from the port or item key.

Record source identity separately from user/group identity, and partition versions and request caches by source. Keep request caches in memory for v1; only associated references are stored durably. On a profile change, preserve the old association snapshots and require explicit reference selection to replace their source. Never match across databases by title or DOI automatically.

## 6. Desktop contract and request handling

Proposed renderer operations:

| Operation | Responsibility |
| --- | --- |
| `zotero.status/connect/disconnect` | Check capabilities and control the local connection. |
| `zotero.libraries/collections/search/item` | Return bounded, normalized library and item data. |
| `citations.add` | Receive experiment ID, expected revision, connection generation, and selected source identities; fetch/validate metadata before a transactional insert. |
| `citations.remove` | Remove a specific experiment association with a revision check. |
| `citations.previewRefresh/applyRefresh` | Fetch a candidate, then apply the displayed candidate using a bounded, expiring token and expected revision. |

Add typed citation records to `LibrarySnapshot`. Preserve the existing result-envelope pattern and classify connection failures without exposing internal paths or raw server responses.

All requests use a fixed loopback origin and allowlisted GET routes. Construct paths from validated identifiers; reject redirects and arbitrary URLs. Set timeouts, response-size limits, and cancellation. Render bibliographic fields as text. Keep networking out of the renderer and preserve the existing Electron sandbox and navigation restrictions.

Zotero's current HTTP server checks Host and browser-like request headers. Use a dedicated desktop request identity and test the request headers against the actual client. [Zotero developer compatibility notes](https://www.zotero.org/support/dev/zotero_10_for_developers#local_http_server_and_local_api)

Capture the target experiment when opening the picker; navigation cannot silently retarget an in-flight add. Discard late results after disconnect, source change, modal cancellation, renderer shutdown, or library restore. Revalidate the parent/revision and a library generation token at commit time so a network response from before restore cannot write into the restored library.

## 7. Offline references and exports

Use the saved metadata to show citations and export a **References** block after the selected sections of each exported run. Each entry is independently readable; repeated runs may therefore repeat the shared reference list in a combined export. Never contact Zotero during export.

Include readable references in TXT, Markdown, HTML, RTF, and DOCX using the shared model and existing visual conventions. Omit the block when there are no citations. Preserve safe DOI/HTTP(S) links where the writer supports them and readable URLs elsewhere. References are independent of the selected rich-text sections and attachment preview policy.

Coordinate this work with the export changes already present in the working tree; this planning pass changes no exporter code. An Open in Zotero shortcut is a small follow-up once item-selection links and source checks have been validated on the supported client.

## 8. Implementation milestones and acceptance

| Milestone | Deliverable and completion evidence |
| --- | --- |
| 1. Connection prototype | Verify the installed client, local access setting, stable source identity, personal/group libraries, collection browsing, and paginated searches. Record the tested version and any compatibility limits. |
| 2. Persistence and contracts | Add the experiment citation schema, typed bridge, revision checks, duplicate prevention, and backup/restore support. Pass migration and lifecycle tests using disposable libraries. |
| 3. LabMate workflow | Implement Settings connection, library picker, shared citation chips, details, removal, and explicit metadata refresh. Validate keyboard navigation, long titles, empty results, multiple runs, and both editor layouts. |
| 4. Exports and resilience | Include saved references in all five writers; verify offline output, missing sources, profile changes, restore races, and request failures. Inspect representative rendered exports. |
| 5. Packaged acceptance | Test the packaged macOS arm64 app against a disposable Zotero profile, then verify a user-selected reference with the actual installed client. Record automated and live results separately. |

Required checks include one citation appearing in every run, removing it across all runs, another experiment remaining independent, no duplicate on a retried add, identical item keys in different libraries remaining distinct, repeat-run inheritance, restart persistence, Trash/restore/purge, migration from supported old schemas, and backup round trips. Exercise source metadata edits, missing items, closed Zotero, disabled access, source-ID mismatch, pagination, malicious metadata, and navigation/restore during an in-flight request. Confirm the request log contains only permitted reads and no Zotero database-file access.

Run the existing build/type checks, backend suite, and relevant packaged functional/UI checks after implementation. Test autosave while browsing, schema/recovery regressions, and the supported appearance layouts. A plan, fixture-only check, or development startup does not establish live or packaged compatibility.

The basic extension is complete when the user can connect the supported local Zotero client, find a real reference, attach it once to an experiment, see it in every run, reopen it after restarting LabMate, and export or restore the saved reference without Zotero running.

Later milestones can add a Zotero-side Send to LabMate plugin, account-based Web API access, inline citations and CSL styles, attachment import, and deliberate source replacement tools. They are outside the initial implementation scope.
