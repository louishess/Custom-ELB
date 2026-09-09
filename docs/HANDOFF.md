# LabMate implementation handoff

Prepared September 8, 2026 (local time). This is the transition from the approved
frontend skeleton to future functional work. The remaining items below are a
dependency map, not a claim that backend implementation has been authorized or
delivered. Agree on the next milestone before expanding scope.

## Current state and product decisions

LabMate is a standalone Apple Silicon Mac app using Electron, React, TypeScript,
and Vite. The repository/directory still uses Custom ELB. Current HEAD at handoff
is `ce853d6` (`skeleton init`); branding, tracker, appearance, and other subsequent
changes are in the working tree. Preserve and review those changes before
committing. This handoff does not commit or publish them.

All content is fictional; no database, saved records, accounts, uploads, real
exports, microphone access, or live Zotero connection exist. Do not silently
turn sample fixtures into user data.

Working presentation includes directory grid/list views, notebook/entry
navigation, overlapping schemes, four entry sections, continuous/tabs layout,
dialogs, export option selections, attachment illustrations, citation details,
and Organization → Experiment tracker. Tracker status changes are session-only.
Search, actual sorting, creation, editing, scheme membership/reordering,
dictation, export generation, and citation association remain planned.

Preserve the friendly Mac styling and color accents. Settings → Appearance is a
0–100 continuum, replacing binary light/dark. The light endpoint incorporates
the requested additional warmth; the dark endpoint is brighter. Surfaces vary
continuously while foreground colors adapt for contrast. Native controls use
the nearest light/dark scheme. Appearance and entry layout reset on relaunch.

## Existing dependencies and build environment

`package-lock.json` is the exact resolved dependency inventory, including
transitive dependencies. Use `npm ci`; do not replace the lockfile casually.
Declared direct dependencies at handoff:

| Package | Declared version | Purpose |
| --- | --- | --- |
| react, react-dom | ^19.2.8 each | UI and renderer mounting |
| lucide-react | ^0.577.0 | Locally bundled icons |
| electron | ^44.3.0 | Desktop runtime |
| @electron/packager | ^20.3.0 | Mac app packaging |
| typescript | ^6.0.0 | Type checking |
| vite | ^8.2.2 | Renderer compilation |
| @vitejs/plugin-react | ^6.0.0 | React build integration |
| @types/node | ^25.0.0 | Build/tool types |
| @types/react, @types/react-dom | ^19.2.0 each | UI types |
| playwright | ^1.58.0 | Electron UI verification |

Use macOS arm64, Node 22.12+ (previously verified with Node 26), npm, and Apple
Command Line Tools. Swift and `iconutil` generate the local app icon. Initial
installation/runtime downloads require network access; the packaged skeleton
runs offline. New native Node modules will require Electron ABI and arm64
packaging validation. No editor, database, document exporter, speech SDK, PDF
parser, spreadsheet parser, or Zotero SDK has been installed.

## Source map

| Location | Responsibility |
| --- | --- |
| `src/App.tsx` | Shell, directory, workspace navigation, session state |
| `src/fixtures.ts`, `src/types.ts` | Fictional content and display types |
| `src/components.tsx` | Entry sections, toolbar, attachment cards and shared UI |
| `src/panels.tsx` | Forms, settings, export/citation/attachment dialogs |
| `src/Tracker.tsx` | Session-only experiment board |
| `src/appearance.ts` | Palette interpolation and contrast adaptation |
| `src/styles.css`, `src/theme.css` | Layout, accents, responsive styling |
| `electron/main.cjs` | Sandboxed shell and local `elb://app/` protocol |
| `scripts/package.mjs`, `scripts/icon.swift` | Packaging and local icon |
| `scripts/check-ui.mjs`, `scripts/check-appearance.mjs` | Current checks |
| `docs/integration-notes.md` | Future integration boundaries and Zotero references |

## Remaining systems and their dependencies

Each row describes work still to build. Library choices beyond the installed
stack remain undecided; verify current official documentation, licenses, and
Electron compatibility when selecting them.

| System | Build requirements | Prerequisites and acceptance |
| --- | --- | --- |
| 1. Domain model | Separate notebook, experiment, run, section document, attachment, citation association, scheme membership, and settings entities. Stable IDs, timestamps, status and schema version. | Decide numbering allocation and deletion semantics. `[label]-N-Y` is display identity, not a primary key. Renames/sorting must not renumber history. Test unique N per notebook and Y per experiment. |
| 2. Local persistence | Choose storage engine/location, repository interfaces, migrations, transactions, atomic saves, autosave, error recovery, backups and restore. | Depends on 1. A local store is sufficient for the initial Mac target; a hosted service is not required. Demonstrate restart persistence, migration failure recovery, and backup restoration before real data. |
| 3. Desktop bridge | Add a narrow typed preload/contextBridge API and main-process handlers for approved record/file/integration operations. Validate payloads, sender and paths. | Depends on domain/service contracts. Keep renderer sandbox, context isolation and Node isolation. Never expose arbitrary filesystem, shell or network execution. |
| 4. Record operations | Implement notebook/experiment/run creation and updates, validation, empty states, loading/errors, unsaved edits and deletion/recovery policy. | Depends on 1–3. Repeat creates a new run of an existing experiment; decide which fields copy. Replace planned controls only when durable behavior works. |
| 5. Rich editor | Integrate an editor (Tiptap was deferred as a candidate), canonical document schema, commands, selection, undo/redo, paste sanitation, links, headings, lists, tables, marks, sub/superscript. | Depends on document schema and autosave. Share one document between continuous/tabs layouts. Test formatting round-trip and close/reopen recovery; current formatted JSX is not stored editor content. |
| 6. Search and ordering | Actual search over agreed fields, chronological ascending/descending, alphabetical, numeric experiment/run ordering, stable tie-breaks and scheme ordering. | Depends on persisted model, with full-text index only if needed. Numeric runs must sort numerically (2 before 10); define date/timezone and locale behavior. |
| 7. Schemes | Named schemes, ordered membership, add/remove entry, reorder with keyboard alternative, overlapping memberships. | Depends on stable run IDs and storage. Removing membership must not delete a run. Decide behavior for deleted entries and cross-notebook membership. |
| 8. Tracker and preferences | Persist To-Do/In Progress/Complete, appearance, entry layout, and any chosen workspace preferences. | Depends on 2–4. Decide whether status belongs to a run or an experiment; current board represents entries/runs. Status changes must survive restart. Preserve focus when cards move. |
| 9. Attachment ownership | Native picker, managed copy versus linked-file policy, MIME/type detection, metadata, captions, safe access, missing-file recovery, limits, cleanup and backup inclusion. | Depends on 2–3. Decide ownership before importing files. Keep originals intact and handle duplicate names, moved links, failed imports and partial writes. |
| 10. Attachment viewers | Image, PDF and spreadsheet viewers; explicit supported formats; scientific-data adapters after format requirements are supplied. | Depends on 9. Current PDF/table/image previews are illustrations; `.fid` is a placeholder. Choose parsers/viewers per format, isolate untrusted content and bound memory. Test representative real files and unsupported/corrupt files. Scientific formats remain an open user requirement. |
| 11. Export pipeline | Shared export document model and ordered selection resolver; Plain text, Markdown, HTML, RTF and DOCX writers; section ordering/inclusion and attachment policy; native save and error handling. | Depends on 1, 5, 7 and 9. Resolve this entry/selected entries/notebook, sequence and scheme before serialization. Define embed/link/omit behavior per format; implement explicit selected-entry selection. Verify reopened output, Unicode, tables and formatting loss. Single-entry UI hides entry ordering. |
| 12. Google Docs destination | Account/project setup, OAuth and secure token storage, document creation/write adapter, supported-format mapping and reconnect/errors. | Depends on shared export model and explicit account authorization. This is a remote destination, not a local text format. No credentials or Google project are configured. Validate against a real authorized account separately from local export tests. |
| 13. Notes dictation | Choose system dictation integration or speech service/native bridge; microphone permission if needed, explicit start/stop, insertion at selection, cancellation/errors and audio lifecycle. | Depends on functional Notes editor and 3. Decide offline/privacy requirements, macOS permission descriptions/entitlements and any service credentials. Current button has no recording behavior. Test actual Mac permission and insertion flows. |
| 14. Citations and Zotero | Persistent source-instance/library/item association plus bibliographic snapshot, read-only library picker, availability/version detection, citation association/removal and citation rendering. | Depends on 1–3. Investigate local API access against the intended running Zotero builds. No direct Zotero SQLite access. API enablement, permissions and real compatibility remain unverified; see integration notes. |
| 15. Optional Zotero companion plugin | Only if needed, add a Send to LabMate workflow and a validated, versioned receiving interface. | Depends on 14 and an actual association interface. The plugin is optional, not a prerequisite for a local API picker. The separate custom Zotero project is not modified by this skeleton; confirm target checkout/build and cross-app protocol first. |
| 16. Distribution | Developer ID signing, notarization, entitlements, clean install/update behavior, versioning and release process. Intel support and updater only if requested. | Depends on packaged native/service dependencies being included correctly. Apple developer credentials are external prerequisites. Verify signed app on a clean Mac; current `.app` is a local unsigned review build. |

Cross-cutting work: use accessible names and focus management, resize/zoom
coverage, actionable error states, cancellation for long operations, and tests
appropriate to real data integrity. Decide whether immutable history/audit trails
are required before treating this as a regulated ELN. Collaboration, cloud sync,
multi-user access control, electronic signatures and compliance certification
have not been requested or designed.

## Suggested build sequence

1. Agree on domain schema, local storage, attachment ownership and editor format.
2. Build persistence and the desktop bridge; deliver one durable notebook/run
   with edit/save/reopen and backup/restore before adding integrations.
3. Add remaining record operations, search/sort, schemes and tracker persistence.
4. Add attachments and a minimal explicitly supported viewer set.
5. Build the shared export model and local writers, then Google Docs separately.
6. Add Zotero picker and dictation after their underlying editor/data contracts
   are stable. Consider a companion plugin only after the picker is useful.
7. Complete native acceptance and distribution work for the selected release.

Independent viewers/export writers can be delegated after their shared contracts
are fixed. Avoid multiple agents independently redesigning storage or editing
the same shell files.

## Packaging trap for future dependencies

`scripts/package.mjs` currently deletes ALL `node_modules` after pruning because
the skeleton needs only bundled renderer code. Before adding any main-process
database module, parser, native helper, or other runtime package, change this
step to retain the required production dependencies. Package workers, WASM,
native binaries and local assets explicitly as needed, and test the packaged
app rather than relying on development success.

The Electron shell currently denies all permissions, new windows, external
navigation and requests outside `elb://app/`. Future integrations need narrow,
reviewed changes; blanket disabling of those restrictions is not the solution.

## Verification and artifacts

```sh
npm ci
npm run typecheck
npm run build
npm run check:appearance
npm run package:mac
LABMATE_APP_BINARY="$PWD/out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate" npm run check:ui
```

Local bundle: `out/LabMate-darwin-arm64/LabMate.app`.
Report: `artifacts/ui/checks.json`; screenshots: `artifacts/ui/` (Git-ignored).
The existing report, timestamped `2026-09-09T05:22:25.722Z`, records 14 packaged
UI checks, zero failures and zero external requests. The prior implementation
also passed typecheck/build and all 101 appearance positions with minimum 4.5:1
contrast for the tested pairs. These are previous-run evidence, not backend
acceptance or tests rerun during handoff preparation.

Native inspection caveat: the final manual CUA reopening attempt still selected
an older running window with the binary appearance button. Packaged automated
tests and generated screenshots exercised the new slider. On the next manual
review, close older LabMate instances and explicitly launch the bundle above;
confirm the Adjust appearance shortcut and slider before evaluating it.

## Agent settings

Project settings live in `.codex/config.toml`; project instructions in
`AGENTS.md` document a ceiling of 9 concurrent subagents (primary excluded) and
depth 2 (primary 0, child 1, grandchild 2). Do not treat that ceiling as a
requirement to spawn nine workers. Active sessions may retain lower runtime
limits; this handoff session reports four total slots. Start a fresh session to
load project settings and check the effective tool limits before delegating.

Official reference for the concurrency key:
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
The current public reference does not list `max_depth`; verify host support
instead of assuming its presence in a file proves enforcement. The explicit
depth rule in `AGENTS.md` applies independently of native support.
