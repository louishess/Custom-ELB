# Yield from marked materials

Select a complete material description in any editor section, then use the toolbar's **Mark as Starting Material** or **Mark as Product** button. Hover over the flask, product and copy icons for their tooltips. Green identifies starting material; blue identifies product. The pair can be in different sections of the same run.

Use one starting material and one product per run. Click inside an existing highlight and use its role button again to remove it; Undo restores it. Marking another material with the same role requires removing the previous one first. Pasted duplicate or fragmented roles are reported instead of choosing one automatically.

## Automatic parsing

Examples:

- `Starting compound (0.20 g, 2 mmol, 2 eq.)`
- `Product (75mg,750 µmol,1equiv.)`

The final parentheses contain one mass or volume, one molar amount and one equivalents value, separated by commas. Spaces between numbers and units are optional; multiple spaces and nonbreaking spaces work. Decimal and scientific notation are accepted. Chemical names may contain commas or balanced parentheses.

Supported molar units are mol, mmol, µmol (also μmol and umol), and nmol. Mass supports kg, g, mg, µg (μg/ug), and ng; volume supports L, mL, µL (μL/uL), and nL. Unit detection is case-insensitive. Equivalents accept eq, equiv or equivalents, with an optional period. Unknown units, duplicate amounts, incomplete descriptions and invalid numbers use manual entry.

## Manual fallback

If a selected description cannot be parsed, a popup asks for a material label, molar amount, unit and equivalents. These values are saved with the highlight, without replacing the original prose. Starting amount and equivalents must be positive; product may be zero. Decimal and scientific notation work here too.

The manually entered values are tied to the exact marked text. After editing that text, **Copy Yield** opens the popup again. The toolbar also offers **Edit starting material amounts** or **Edit product amounts** for existing manual values. Cancellation leaves the document and clipboard unchanged. Unknown mass or volume is omitted from the copied result.

## Copy Yield

The result updates as marked text changes. **Copy Yield** writes a readable summary to the clipboard containing:

- Starting material and the equivalents basis.
- Theoretical molar yield, representing 100%.
- Actual molar yield, its original mass/volume when parsed, and percentage yield.

Theoretical product = starting molar amount × product equivalents ÷ starting equivalents. Actual percentage = product molar amount ÷ theoretical product × 100. Units are converted before calculation. The example above gives 1,000 µmol theoretical product and 750 µmol actual product, or **75%**. Percentages display up to two decimal places; values above 100% remain valid with a check-inputs notice.

This uses the designated starting material; it does not determine a limiting reagent automatically or infer molar mass, purity, density or theoretical mass. Incomplete, ambiguous or numerically unsupported calculations do not overwrite the clipboard.

## Persistence and compatibility

Marks and manual values use the existing document autosave, revision checks and encrypted backups. Rich exports retain role colors and all five export formats label the original marked descriptions. A repeated run retains its existing Information/Method prose and ordinary formatting but clears material roles, so an old product cannot supply a new run's yield.

Previously saved yield cards remain editable and exportable. New calculations use the three markup controls instead of adding another card.
