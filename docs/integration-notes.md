# Future integration boundaries

These are implementation notes for later work, not capabilities delivered by the
frontend skeleton. No changes to Zotero or personal libraries are included.

## Editor and notebook records

Use a rich-text editor such as Tiptap when functional editing begins. The current
toolbar and formatted content are presentation components, not an editor.
Experiments and runs will need independent stable IDs: the displayed
`[experiment label]-N-Y` identifier should not be the storage key. Sorting and
scheme changes must not renumber experiments or repeated runs.

Choose persistent storage, autosave, backups, and attachment ownership before
accepting real notebook records. The current typed fixtures establish display
needs only; they are not a production storage schema.

## Zotero feasibility

Zotero documents a local API on `localhost:23119/api/` and a desktop plugin
framework. The custom Zotero checkout inspected during planning contains both
local API and plugin infrastructure. This establishes a plausible integration
route; it does not establish compatibility with an installed/running build.

- First explore a read-only citation picker using the local API. Check whether
  the API is enabled and discover capabilities from the actual running client.
- Associate a reference using source-instance, library, and item identifiers,
  accompanied by a bibliographic snapshot. Do not key associations by title.
- A companion plugin could add “Send to LabMate” inside Zotero. Build that only
  when the notebook has a real association interface and the push workflow is
  needed. A plugin need not be a prerequisite for the notebook-side picker.
- Put future local API access behind a narrow desktop-process interface rather
  than exposing arbitrary requests to the renderer. Do not read or write the
  Zotero SQLite database directly.
- Verify permissions and API/version behavior against the intended standard and
  custom Zotero builds before claiming interoperability.

Primary references:

- [Zotero local API](https://www.zotero.org/support/dev/web_api/v3/local_api)
- [Zotero plugin development](https://www.zotero.org/support/dev/client_coding/plugin_development)
- [Zotero JavaScript API](https://www.zotero.org/support/dev/client_coding/javascript_api)

## Files, dictation, and export

The image, PDF, and table details are locally rendered illustrations. The `.fid`
example deliberately shows the future-viewer state. Introduce file-type-specific
viewers after concrete format requirements are known; no parsing is present now.

Future dictation should insert into the actual Notes editor with explicit user
control of recording. Decide between system dictation support and an integrated
speech interface at that stage. The current control never accesses audio.

Keep the export options independent of document generation. Each real exporter
will need to implement entry selection/order, section order/inclusion, data
treatment, and the target format's formatting limits. Google Docs is a connected
destination, distinct from a downloadable text file. No Google account or export
service is used by the skeleton.
