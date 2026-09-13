# LabMate white export design plan

Status: implemented September 12, 2026. The original design rationale is retained below; final implementation choices and verification are recorded here and in `VALIDATION.md`.

All five writers now use the shared presentation specification in `electron/backend/export-design.cjs`. The entry identifier, title, metadata, numbered sections, neutral supporting blocks, proportional figures and multi-entry page breaks are implemented. The export dialog describes the selected format's behavior.

Two choices were resolved during visual review. DOCX and RTF use Arial and Courier New: the available recipient renderer substituted serif text for unavailable Helvetica Neue and Menlo, whereas the portable faces rendered as sans-serif and monospace. HTML retains the native system font stack. Extremely wide rich-format tables use explicit labeled rows with a warning, retaining every original cell once, rather than forcing a landscape section. No new dependency or database change was required.

Synthetic entry and notebook specimens, before/after files, browser checks, and rendered document pages are in `artifacts/exports/`. DOCX and RTF were visually inspected through bundled LibreOffice; native Word, Pages, TextEdit and Windows acceptance remains unverified. The local review app isolates this export work from concurrent Zotero integration edits; see `VALIDATION.md` for its exact scope and test evidence.

The aim is for an exported experiment to resemble the reading surface inside LabMate: a small entry identifier, a prominent experiment title, quiet metadata, numbered sections, readable prose, and restrained supporting elements. All generated page styling uses a fixed white and neutral-gray scheme, independently of the user's application palette or brightness.

## 1. Scope and current findings

Apply this design to all five existing document exports: DOCX, HTML, RTF, Markdown, and plain text. Cover single entries, selected entries, and whole notebooks, including scheme ordering and reordered or omitted sections. HTML printing is a layout validation target; a new PDF export format is outside this plan. Encrypted backups and the plain-text Copy Yield clipboard action retain their existing purposes.

The review used the current source, `docs/HANDOFF.md`, `docs/BACKEND-CONTRACT.md`, and existing editor screenshots. Screenshots supplied visual context; current source determined working capabilities. In particular, the older demo's Objective panel and citation chips are not evidence of corresponding working structured-data features.

| Current implementation | Consequence | Planned change |
| --- | --- | --- |
| UI uses an Apple system sans-serif stack; its experiment title is 29 px, body 14 px, section labels 15 px, and metadata 11 px. | Much of LabMate's identity comes from hierarchy and spacing. | Preserve those relationships with sizes adapted for documents. |
| All writers combine the entry code and title into one heading. | The exported entry loses the UI's recognizable badge-above-title composition. | Separate code, title, and metadata. |
| HTML has a short generic stylesheet and no print stylesheet. | Browser heading defaults dominate the page; print behavior is unspecified. | Add scoped document styles and explicit print rules. |
| DOCX defines no custom document styles or page geometry. | The writer and receiving application supply much of the appearance. | Define complete LabMate paragraph, character, table, and page styles. |
| RTF declares Helvetica and Menlo but no deliberate title/body size scale. | Bold text does most of the hierarchy work. | Define explicit sizes, spacing, indents, borders, and pagination. |
| DOCX images always use 520 × 340 dimensions; RTF images also use fixed width and height goals. | Figures can be stretched into the wrong proportions. | Fit images within the available space while preserving aspect ratio. |
| Section names and content are shared, but presentation is independently assembled by five writers. | Styling and structural details can drift across formats. | Give all writers one small presentation specification. |

## 2. The proposed visual language

### Typography

Use the existing native sans-serif character as the reference. HTML uses `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif`. DOCX and RTF use Arial and Courier New after the font substitution review described above. HTML uses Menlo with conventional monospace fallbacks for code. No font download or bundled font is required.

These are the implemented presentation targets, adapted from the initial design:

| Role | HTML screen | DOCX / RTF / HTML print | Treatment |
| --- | --- | --- | --- |
| Experiment title | 30 px | 22 pt | Medium or semibold; slightly tight spacing where supported; about twice body size |
| Notebook title, multi-entry opening | 24 px | 18 pt | Semibold, followed by notebook discipline and selection context |
| Section title | 16 px | 12 pt | Semibold, with a smaller two-digit section number |
| Body | 15 px | 11 pt | Regular; 1.75 screen line spacing, approximately 1.55 in documents |
| Metadata, entry code, captions | 12 px | 9 pt | Regular; code uses tabular numerals where supported |
| Table contents | 13–14 px | 10 pt | Comfortable cell padding; semibold header cells |

The design should keep LabMate's calm reading rhythm without copying every screen dimension into print. Use consistent paragraph spacing, around 28 px / 20 pt between major sections, and a smaller gap between a heading and its content. Keep ordinary prose left aligned.

Some document renderers expose only regular and bold faces reliably. Use the nearest supported weight and tune size and spacing instead of relying on an exact CSS weight of 550.

### White surfaces and restrained details

- White page and content backgrounds; dark charcoal primary text, legible gray secondary text, and thin light-gray rules.
- Very light gray only for supporting surfaces such as table headers, quotes, and code blocks. Avoid large filled panels, gradients, and shadows.
- Small outlined entry badges; modest corner rounding in HTML. DOCX and RTF may use a simple shaded or bordered label without matching the rounded shape exactly.
- A small LabMate wordmark in the opening context line. Typography and document structure carry the identity; the experiment remains the most prominent content on its page.
- Underlined neutral links. Preserve the existing format-specific link behavior.

This is a white document design, not a conversion of scientific content to grayscale. Preserve original image colors and intentional user-authored highlights. LabMate-generated material-role highlights can use neutral emphasis because explicit “Starting material” and “Product” labels already preserve their meaning. Do not carry notebook colors, status colors, or the active appearance palette into the generated page design.

## 3. Document composition

### Single entry

Use this reading order:

1. Small LabMate and notebook context line, including notebook discipline without an empty placeholder when absent.
2. Entry code in a compact badge on its own line.
3. Experiment title, with natural wrapping and no truncation.
4. Compact, wrapping metadata: date, author, experiment label, and run/experiment numbers. Keep all currently exported metadata, while presenting it more like the UI.
5. Thin divider and the selected sections, in their requested order.
6. Attachments within Data when the current selection and attachment policy include them.

Use unambiguous dates such as “Sep 12, 2026,” formatted without shifting a saved date across time zones. Do not export interactive controls, autosave status, or unavailable citation placeholders. Treat tabs as sections in the document; the user's on-screen layout preference does not hide requested export content.

### Multiple entries and notebooks

Start with a compact notebook heading on the first content page, followed immediately by the first entry. Include the selected-entry count and scheme name only when applicable. Avoid a separate cover page for routine exports.

Use the same entry layout throughout. Start subsequent entries on a new page in DOCX, RTF, and printed HTML; use generous separation between entries in continuous HTML. Preserve the resolved run order exactly. Use a quiet notebook header and page number in DOCX and RTF where the target applications render them reliably; HTML should not promise browser-independent running headers or page numbering.

Number the exported sections `01`, `02`, and so on in their final selected order, restarting per entry. For example, an export containing Method followed by Data becomes `01 Method`, `02 Data`. These numbers describe this export's sequence; stored section IDs and content are unchanged.

### Authored content and supporting blocks

- Preserve bold, italic, underline, strike, superscript, subscript, alignment, and list meaning to each format's existing capabilities. Scope authored heading styles separately from the export's notebook, entry, and section headings. Retain their relative hierarchy without allowing a body heading to take over the entry-title role.
- Render existing blockquotes as restrained inset notes with a thin vertical rule. Do not infer an Objective block from arbitrary prose or reproduce demo-only fields.
- Style existing legacy yield summaries as compact labeled result blocks, retaining the current deterministic calculation and incomplete-input wording. Preserve a presentation hint when normalizing the node so rich writers can recognize it; text writers keep the readable summary. This adds no new automatic calculation for ordinary marked prose.
- Keep material-role labels readable in every format. Any neutral styling must retain their explicit meaning and avoid duplicating labels across split text runs.
- Give images, spreadsheet previews, and caption-only attachments consistent spacing and filename/caption treatment. Size figures proportionally; do not crop scientific content. Keep a caption with its figure when it fits on a page.
- Use thin table borders, padded cells, and neutral header treatment. Preserve actual header-cell identity, saved column proportions, and merged cells in rich formats. Avoid silently turning data cells into headers.

### Pages and difficult content

Use US Letter with 0.75-inch margins as the initial DOCX/RTF default. Validate the HTML print layout on both Letter and A4. Keep headings with the first following content, control isolated lines where supported, and allow long sections and tables to span pages rather than forcing whole sections into unbreakable containers.

Repeat genuine table header rows where supported. Fit wide tables to the usable width while preserving proportions and a readable text size. If proportional fitting leaves any column narrower than 40 CSS pixels, rich formats use explicit labeled rows and a layout warning. Each original cell is retained once with its row, column and span context. Never silently clip columns, drop cells, or shrink text arbitrarily.

## 4. How each format expresses the design

| Format | Intended result | Practical boundary |
| --- | --- | --- |
| DOCX | Editable document with named LabMate styles, deliberate hierarchy, code labels, metadata, neutral tables, figure captions, and page layout. | Font substitution and some layout vary in Word, Pages, and other readers. Verify actual rendering. |
| HTML | Closest match to LabMate's reading surface, with scoped CSS, a comfortable centered column, responsive metadata, and print styling. | Browser print engines differ. Keep styles and existing embedded previews self-contained; no remote font or style requests. |
| RTF | Same font family intent, size ratios, numbered sections, spacing, and neutral rules using conservative formatting. | Prefer simple document constructs over floating panels or exact rounded badges. Validate in TextEdit and Word. |
| Markdown | Same notebook/entry/section hierarchy, separate code line, concise metadata, consistent spacing, captions, and relative image assets. | The reader chooses fonts, colors, and much of layout. Keep portable Markdown rather than adding CSS or HTML wrappers to imitate the rich formats. |
| Plain text | Same information order, title separation, numbered section labels, restrained separators, consistent indentation, and readable captions. | Fonts, bold, badges, and page geometry cannot be encoded. Use structure and whitespace; avoid elaborate fixed-width decoration. |

For Markdown and plain text, “looks like LabMate” therefore means recognizable information architecture and reading order. The three rich formats can also carry typography and layout.

## 5. Implementation sequence

### Phase 1 — Establish the reference

Create one synthetic, realistic experiment and one multi-entry notebook as the design fixtures. Include a long title, reordered sections, nested lists, authored headings, a merged table, portrait and landscape figures, spreadsheet data, material marks, and completed/incomplete legacy yield cards. Produce current baseline exports and a proposed white HTML specimen for comparison with the UI. This is the first concrete design review checkpoint, before propagating styles across every writer.

### Phase 2 — Shared presentation and HTML

Add a small backend presentation module, proposed as `electron/backend/export-design.cjs`, containing named text roles, neutral colors, spacing, page measurements, and metadata/section-label helpers. Keep the existing shared selection model and file-writing pipeline. Use explicit conversions from common measurements to CSS, document points, and RTF units.

Apply the design to `renderHtml`, including styles for authored content and print. Do not import the application's whole stylesheet or read appearance preferences. Presentation-only changes should require no database migration or new export request fields.

### Phase 3 — DOCX and RTF

Translate the same presentation roles into explicit DOCX styles and RTF formatting. Add the entry composition, page behavior, and supporting block treatments. Give text and tables complete defaults so receiving applications do not supply unintended heading colors, fonts, or spacing. Fix proportional figure sizing in both writers.

### Phase 4 — Markdown, plain text, and content edges

Apply the common reading order and numbering to the two text formats. Complete table overflow, long captions, authored heading hierarchy, yield presentation, and unsupported-preview fallbacks across all five writers. Keep selection semantics, warnings, companion-asset naming, cancellation, and staged replacement intact.

Update the existing Format behavior text in `src/panels.tsx` to describe the selected format: rich formats use the white LabMate document design; Markdown and plain text carry structure with format-specific limitations. No new theme selector is needed.

### Phase 5 — Visual and regression acceptance

Review the final files in their actual readers, resolve layout defects, and then validate exports from the packaged application. Update `docs/HANDOFF.md` and `docs/VALIDATION.md` after implementation with the formats and readers actually verified.

## 6. Acceptance criteria

- The rich exports visibly share LabMate's code/title/metadata composition, approximate 2:1 title-to-body scale, numbered section headings, whitespace, and thin dividers.
- Changing any application palette or brightness produces the same generated white styling. Compare presentation and rendered pages rather than raw DOCX bytes, which can contain generated metadata.
- All five formats contain the same selected runs, section order, metadata, scientific text, and appropriate captions. No format gains demo content or loses an omitted/reordered-section decision.
- Authored formatting, Unicode scientific symbols, superscripts/subscripts, explicit material roles, existing yield values, and merged table geometry survive to the supported fidelity of each format. Known losses remain explained.
- Portrait and landscape images preserve aspect ratio; headings, long filenames, captions, and table columns do not clip. Multi-page documents have sensible breaks, with genuine table headers repeated where supported.
- Markdown assets still resolve after moving the document and its companion folder together. Plain text remains legible in a basic editor.
- Inspect DOCX in Word and Pages, RTF in TextEdit and Word, and HTML on screen and in print. Include a recipient environment without Helvetica Neue, such as Word on Windows, for font substitution. Any unavailable reader or platform remains explicitly unverified.
- Run and extend the existing meaningful export/table/yield/material regression coverage, plus focused presentation assertions. Use rendered specimens for visual acceptance; valid XML/RTF or passing string checks alone do not establish good appearance.
- Use disposable fixtures and profiles for packaged export checks. A successful styling change must not disturb native save dialogs, overwrite behavior, cancellation, attachment limits, or the user's local library.

## Source map

| Source | Evidence or implementation responsibility |
| --- | --- |
| `src/styles.css:1`, `src/styles.css:191`, `src/styles.css:427` | Font stack, entry composition, typography, prose, and table styling |
| `src/theme.css:7`, `src/theme.css:61` | Brand typography and palette overlays to translate into neutral styling |
| `src/App.tsx:332`, `src/components.tsx:252` | Current entry header and numbered sections |
| `src/fixtures.ts:10` | Existing section names |
| `electron/backend/exports.cjs:243` | Normalization, legacy yield flattening, and material-role labels |
| `electron/backend/exports.cjs:488` | Shared selection and export document model |
| `electron/backend/exports.cjs:627` | Per-format loss descriptions |
| `electron/backend/exports.cjs:740`, `electron/backend/exports.cjs:866` | Plain-text and Markdown composition |
| `electron/backend/exports.cjs:962`, `electron/backend/exports.cjs:1120`, `electron/backend/exports.cjs:1279` | Rich-format composition and styling |
| `electron/backend/exports.cjs:1089`, `electron/backend/exports.cjs:1245` | Fixed image dimensions in RTF and DOCX |
| `src/panels.tsx:401` | Existing export dialog and format explanation |
| `tests/exports.test.cjs`, `tests/table-exports.test.cjs`, `tests/yield-exports.test.cjs`, `tests/material-persistence.test.cjs` | Existing functional regression coverage to retain and extend |

The initial planning pass reviewed source and existing visual artifacts. Implementation subsequently generated baseline and final exports, ran regression and packaged checks, and reviewed browser and document renders. `VALIDATION.md` distinguishes completed checks from remaining native-reader acceptance.
