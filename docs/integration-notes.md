# Integration boundaries

The local notebook, Tiptap editing, database, attachments, previews, local
exports and encrypted backups are implemented. See `HANDOFF.md` for current
behavior and evidence. Working and future integration boundaries follow.

## Zotero

LabMate 0.5.0 implements a read-only picker through Zotero's documented local
API, with capability checks against the actual running client. Experiment-wide
references use source instance, library type/ID and item key plus a saved
bibliography. Schema 4 persists those associations, supports offline exports,
and includes references in encrypted backup/recovery. Zotero's database files
are never accessed. An authorized live check read one personal-library
reference into a disposable LabMate experiment without modifying Zotero items.
Read `ZOTERO.md` for setup, compatibility, behavior and validation limits.

An optional companion plugin could add Send to LabMate later. Requests already
use a narrow desktop interface; keep arbitrary network and filesystem access
out of the renderer. PDF/annotation import, inline citations, style selection,
and a Zotero Web API connection remain future work.

Official API references:
- [Zotero local API](https://www.zotero.org/support/dev/web_api/v3/local_api)
- [Zotero plugin development](https://www.zotero.org/support/dev/client_coding/plugin_development)

## Google Docs and scientific data

Google Docs is a connected destination, separate from the five implemented
local export formats. It will need authorized account setup, secure tokens,
reconnection behavior and format mapping against the shared export model.

Dictation is implemented through a bundled on-device Swift helper in 0.4.
Live microphone and offline utterance acceptance are recorded separately from
native capability checks and automated transcript/session tests.

Scientific files remain managed attachments with explicit associated-app
opening. Add specialized viewers only after concrete formats and sample files
are supplied. Common PDF, image and spreadsheet previews already work.

## Distribution

The arm64 app is a local review build. Developer ID signing, notarization,
clean-machine installation, updates, and optional Intel support remain separate
acceptance milestones. No public distribution or credentials are configured.
