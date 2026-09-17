# Zotero references in LabMate 0.5.1

Implemented and verified September 12, 2026. Citations belong to the whole
experiment and appear in every run, including completed runs. A separate
experiment has its own citation list.

## Connect and add a reference

1. Open Zotero on the same Mac. In Zotero Settings → Advanced, enable
   **Allow other applications on this computer to communicate with Zotero**.
2. In LabMate, open Settings → Integrations → **Connect Zotero**.
3. Open a run and choose **Add citation**. Select a library and optionally a
   collection, search by title, author or year, select references, and choose
   **Add to experiment**. The sidebar's Zotero control opens the same picker
   with an experiment destination selector.
4. Click a saved citation to inspect its bibliography. **Refresh details**
   retrieves a preview; **Use updated details** explicitly replaces the saved
   copy. **Remove from experiment** removes the association from every run.

The picker reads personal and group libraries available in the running desktop
client. Lists load 50 records at a time with explicit controls for further
pages. Notes, annotations, attachments and trashed items are excluded. Adding
the same item from the same Zotero library twice creates one association.

## Citation labels and style

In Settings → Integrations, set **Show citations as** to **Formatted citation**
and choose a **Citation style**. No style is preselected. The available choices
are ACS, APA, Chicago author–date, MLA, Harvard Cite Them Right, Nature,
Vancouver and IEEE. Paper titles remain visible until a style is selected.

Choosing a style retrieves matching labels for existing active references when
Zotero is connected. New references also retain that style's formatted label.
**Update citation labels** retries missing labels or fetches updated ones.
Updates are cancellable and keep completed labels. If Zotero is unavailable,
missing items or a different source prevents a label update, saved bibliographic
metadata is kept. References without a matching saved label show their title
until retrieval succeeds. Label updates do not silently accept new title,
author or other bibliographic details; those still require Refresh details.

Labels use Zotero's own formatting output. Numbered styles use the full
formatted bibliography entry to identify the source rather than a standalone
number. LabMate converts the returned markup to plain text. Zotero may download
a selected CSL style if it is not already installed. This selection belongs to
LabMate and does not change Zotero's Quick Copy preference. The style setting
controls labels in LabMate; exported reference lists retain their existing
format. Saved label and style are available offline and included in backups.

## Local and offline behavior

LabMate uses Zotero's read-only local HTTP API. It does not change Zotero items,
read Zotero's database files, import PDFs, initiate Zotero sync, or require a
Zotero cloud account/API key. The local-access setting applies to local
applications generally; disconnecting in LabMate stops LabMate's requests
without changing Zotero's setting.

Saved bibliographic metadata remains available when Zotero is closed or
disconnected. Offline exports in DOCX, HTML, RTF, Markdown and TXT include a
**References** section for each exported run, after its selected sections.
This works even when Data is excluded. References use a simple readable
author/date/title/publication format with a safe DOI or URL when present.

Removing or editing an item in Zotero never silently changes a saved citation.
A missing item produces a useful error during refresh and preserves the saved
copy. Switching Zotero databases requires reconnection; old references retain
their original source identity and cannot accidentally refresh from the new
database.

## Compatibility and storage

The client must expose local API v3 and a stable `Zotero-Server-ID`. Builds
without those capabilities show an unsupported-client message. Test the actual
running client rather than inferring compatibility from an installed app's
version. Live acceptance passed with the user's running custom build
`11.0.SOURCE.1e4dabc91`; this does not establish compatibility with every Zotero
version or custom build. Group libraries and pagination passed fixture tests;
the live check used one personal-library reference.

Schema 4 introduced experiment-owned associations and versioned bibliography
snapshots. Schema 5 adds citation-label/style preferences and optional formatted
labels. Existing schemas 1–4 migrate transactionally; migrated libraries keep
paper-title labels and have no selected style. References are stored
in LabMate's local database and included in encrypted backups. They have the
same local-disk protection as the rest of the working library. The connection
preference and transient browsing/refresh state are excluded from backups.
Restore replaces references with the restored snapshot, cancels pending
citation writes, resets open pickers, and revalidates the connection before
new requests. Saved citations from another Zotero database remain readable.

Trashing a run leaves the experiment references intact. Trashing and restoring
the parent hides and restores its references. Permanently deleting an
experiment removes its associations, subject to the existing backup/rollback
retention behavior. Unexpected rows in the old run-owned
`citation_associations` table are preserved and flagged for migration review;
they are not silently promoted to experiment scope.

## Validation and further scope

`npm run check:zotero` runs nine fixture-backed packaged workflows. The opt-in
`scripts/check-zotero-live.mjs` uses a disposable LabMate library against the
running Zotero client only after personal-library access is authorized. Its
six live checks passed: connect, picker/add, refresh/repeat, offline
restart/export, encrypted recovery, and an explicitly chosen ACS label across an offline restart. Disposable personal metadata was
removed; the report retains only the client version and outcomes.

See `VALIDATION.md` and `artifacts/zotero/{checks,live-checks}.json` for evidence.
The review app is `out/LabMate-darwin-arm64/LabMate.app`. It has not been
Developer ID signed or notarized for public distribution.

A Zotero-side **Send to LabMate** plugin, export bibliography style selection, inline
citations, annotations/PDF import and a Zotero Web API connection remain future
work. The basic integration operates entirely inside LabMate.

Official API references:

- [Local API](https://www.zotero.org/support/dev/web_api/v3/local_api)
- [API read endpoints and pagination](https://www.zotero.org/support/dev/web_api/v3/basics)
- [Stable desktop source identity](https://www.zotero.org/support/dev/zotero_10_for_developers)
