# Deferred integration boundaries

The local notebook, Tiptap editing, database, attachments, previews, local
exports and encrypted backups are implemented. See `HANDOFF.md` for current
behavior and evidence. The following integrations remain separate milestones.

## Zotero

Use a read-only picker through Zotero's documented local API after checking the
actual running client's availability, permissions and version. Do not read or
write the Zotero SQLite database directly. Associate references using source
instance, library and item identifiers plus a bibliographic snapshot; the
storage-only citation association table reserves these fields. No real Zotero
library has been accessed or modified by this implementation.

An optional companion plugin could add Send to LabMate after an association
interface exists. It is not a prerequisite for a notebook-side picker. Keep
future local API requests behind a narrow desktop interface; the renderer
must not gain arbitrary network or filesystem access.

References for future verification:
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
