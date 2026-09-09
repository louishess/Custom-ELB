# LabMate

For the next implementation phase, read the [agent handoff](docs/HANDOFF.md),
including remaining systems, dependency order, packaging constraints, and verification status.

An electronic lab notebook application, with macOS as the initial primary platform.

## Frontend skeleton

A standalone Mac interface built with Electron, React, TypeScript, and Vite.
All notebooks, experiment records, references, and attachment illustrations are
fictional. This build has no notebook storage, backend, accounts, or integrations.
Session state resets on relaunch.

### Working interface

- Notebook directory with grid/list views and recent-entry navigation.
- **Organization → Experiment tracker:** To-Do, In Progress, and Complete columns
  with notebook filtering, entry links, and session-only status changes.
- **Appearance continuum:** use the 0–100 slider in Settings (or its sidebar
  shortcut) to move from warm light to soft dark. Every position updates the
  directory, editor, tracker, and panels. Arrow keys adjust by one step; Home/End
  select the endpoints. Text contrast adapts separately to stay readable.
- Warmer paper surfaces, sage/periwinkle/apricot notebook accents, and the LabMate
  identity. Appearance resets to Light on relaunch.
- Notebook sidebar, entry selection, and named scheme navigation. Overlapping
  schemes show different sequences of the same run entries.
- Continuous-page and section-tab layouts, selected through Settings and shared
  across notebooks during the session.
- New notebook, new experiment, repeat experiment, citation, and attachment panels.
- Export options for one entry, selected entries, or a notebook, with format,
  ordering, section inclusion/order, and data inclusion controls.
- Keyboard-accessible dialogs with Escape dismissal and focus restoration;
  section tabs support arrow keys, Home, and End.

### Planned capabilities shown in the interface

Creating or editing records, text formatting, search, sorting, scheme editing,
file handling, dictation, citation association, Zotero connection, and export
generation are not implemented. Actions are disabled or labeled as planned.
Sort selections update their displayed option; only selecting a sample scheme
changes the example sequence. Export selections never create a file or remote
document. Dictation does not request a microphone or simulate a transcript.

## Development and packaging

Requirements: macOS on Apple Silicon, Node.js 22.12+ (verified with Node.js 26),
npm, and Apple Command Line Tools for icon generation. Network access is needed
for the initial dependency and Electron runtime downloads. The packaged app runs
offline.

```sh
npm ci
npm start
```

`npm start` builds and launches the native Electron window. For quick renderer
iteration in a browser, run `npm run dev` and open the local URL printed by Vite.
It does not provide native window controls or Electron-specific checks.

```sh
npm run typecheck
npm run build
npm run package:mac
```

The Mac bundle is generated at:

```text
out/LabMate-darwin-arm64/LabMate.app
```

Open it in Finder or run:

```sh
open 'out/LabMate-darwin-arm64/LabMate.app'
```

This is a local review build. Developer ID signing, notarization, Intel builds,
and production distribution are deferred. Dependencies, build output, and
verification screenshots are excluded from Git.

## Interface verification

After `npm run build`, run `npm run check:ui` to launch Electron and check the
navigation, forms, layouts, scheme examples, attachment/citation panels, export
options, appearance endpoints and intermediate settings, the organization tracker, minimum window size, renderer
sandbox, and session reset behavior.
Screenshots and a check report are written under `artifacts/ui/`.

To exercise the packaged app instead of the source entry point:

```sh
LABMATE_APP_BINARY="$PWD/out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate" npm run check:ui
```

The checks interact only with fictional interface content. They do not test
backend or integration behavior that this skeleton intentionally does not have.

`npm run check:appearance` verifies all 101 slider positions, preserved endpoint
backgrounds, monotonic brightness, and a minimum 4.5:1 contrast for the checked
text/surface pairs. The native OS controls use their nearest light/dark scheme;
the application colors vary continuously. Appearance remains session-only.

## Organization

- `src/fixtures.ts` and `src/types.ts`: fictional records and display types.
- `src/App.tsx`: directory, navigation, notebook workspace, and session state.
- `src/components.tsx` and `src/panels.tsx`: reusable content, dialogs, and options.
- `src/styles.css`: Mac-oriented layout, typography, and responsive styling.
- `src/appearance.ts`: palette interpolation and readable text colors.
- `src/theme.css`: appearance controls, visual accents, and tracker styling.
- `src/Tracker.tsx`: the organization board over fictional notebook entries.
- `electron/main.cjs`: isolated desktop shell with a local application protocol.
- `scripts/`: packaging, code-drawn app icon, and interface verification.

The renderer has no Node access, preload bridge, or filesystem access. The
packaged shell permits application content only and denies permission requests,
external navigation, and new windows. Only the compiled UI and desktop shell are
needed at runtime; the packaging step removes source Node dependencies.

See [Integration notes](docs/integration-notes.md) for future editor, viewer,
export, and Zotero integration boundaries. Keep personal lab data and credentials
out of this public repository.
