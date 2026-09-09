# Custom ELB

An electronic lab notebook application, with macOS as the initial primary platform.

## Frontend skeleton

A standalone Mac interface built with Electron, React, TypeScript, and Vite.
All notebooks, experiment records, references, and attachment illustrations are
fictional. This build has no notebook storage, backend, accounts, or integrations.
Session state resets on relaunch.

### Working interface

- Notebook directory with grid/list views and recent-entry navigation.
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
out/Custom ELB-darwin-arm64/Custom ELB.app
```

Open it in Finder or run:

```sh
open 'out/Custom ELB-darwin-arm64/Custom ELB.app'
```

This is a local review build. Developer ID signing, notarization, Intel builds,
and production distribution are deferred. Dependencies, build output, and
verification screenshots are excluded from Git.

## Interface verification

After `npm run build`, run `npm run check:ui` to launch Electron and check the
navigation, forms, layouts, scheme examples, attachment/citation panels, export
options, minimum window size, renderer sandbox, and session reset behavior.
Screenshots and a check report are written under `artifacts/ui/`.

To exercise the packaged app instead of the source entry point:

```sh
ELB_APP_BINARY="$PWD/out/Custom ELB-darwin-arm64/Custom ELB.app/Contents/MacOS/Custom ELB" npm run check:ui
```

The checks interact only with fictional interface content. They do not test
backend or integration behavior that this skeleton intentionally does not have.

## Organization

- `src/fixtures.ts` and `src/types.ts`: fictional records and display types.
- `src/App.tsx`: directory, navigation, notebook workspace, and session state.
- `src/components.tsx` and `src/panels.tsx`: reusable content, dialogs, and options.
- `src/styles.css`: Mac-oriented layout, typography, and responsive styling.
- `electron/main.cjs`: isolated desktop shell with a local application protocol.
- `scripts/`: packaging, code-drawn app icon, and interface verification.

The renderer has no Node access, preload bridge, or filesystem access. The
packaged shell permits application content only and denies permission requests,
external navigation, and new windows. Only the compiled UI and desktop shell are
needed at runtime; the packaging step removes source Node dependencies.

See [Integration notes](docs/integration-notes.md) for future editor, viewer,
export, and Zotero integration boundaries. Keep personal lab data and credentials
out of this public repository.
