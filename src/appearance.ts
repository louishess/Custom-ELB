// Palette endpoints retain the warmer light and brighter dark designs.
const lightPalette = {
  "canvas": "#f9f1df",
  "surface": "#fff7e8",
  "surface-soft": "#fbf3e1",
  "surface-muted": "#f3ecd7",
  "sidebar": "#f2edd9",
  "line": "#e9e5cf",
  "ink": "#293c32",
  "ink-secondary": "#606d62",
  "ink-muted": "#616d61",
  "brand": "#35644f",
  "green": "#327059",
  "green-dark": "#285c48",
  "accent-ink": "#32674e",
  "accent-soft": "#e2eddc",
  "on-accent": "#fffef7",
  "highlight": "#f9e3a5",
  "sage": "#e1e8c6",
  "sage-ink": "#506f40",
  "blue": "#e8e0f0",
  "blue-ink": "#5d568c",
  "clay": "#f7dcc0",
  "clay-ink": "#965d3d",
  "spark": "#bd7448",
  "board-todo": "#f4eef3",
  "board-progress": "#fbefda",
  "board-complete": "#eef1df",
  "todo-ink": "#6d5b9b",
  "progress-ink": "#976324",
  "complete-ink": "#477848"
} as const;

const darkPalette: Record<keyof typeof lightPalette, string> = {
  "canvas": "#1d2826",
  "surface": "#283531",
  "surface-soft": "#2c3934",
  "surface-muted": "#37463d",
  "sidebar": "#22312b",
  "line": "#435345",
  "ink": "#e8eee3",
  "ink-secondary": "#b2beb0",
  "ink-muted": "#a5b49e",
  "brand": "#40795b",
  "green": "#467956",
  "green-dark": "#457856",
  "accent-ink": "#aed49a",
  "accent-soft": "#3d5339",
  "on-accent": "#fffef7",
  "highlight": "#635931",
  "sage": "#405937",
  "sage-ink": "#c0d7a5",
  "blue": "#424465",
  "blue-ink": "#c5c0ee",
  "clay": "#5e4736",
  "clay-ink": "#edc49d",
  "spark": "#edb075",
  "board-todo": "#2f3343",
  "board-progress": "#3c3628",
  "board-complete": "#2c3d2f",
  "todo-ink": "#c6b8f2",
  "progress-ink": "#eac583",
  "complete-ink": "#aad29d"
};

type ColorKey = keyof typeof lightPalette;

export const appearancePalettes = [
  { id: 'sage', label: 'Original Sage' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'lavender', label: 'Lavender' },
  { id: 'terracotta', label: 'Terracotta' },
  { id: 'rose', label: 'Rose' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'midnight', label: 'Midnight Purple' },
] as const;
export type AppearancePaletteId = typeof appearancePalettes[number]['id'];

// Only workspace colors change with the palette. Notebook identities and
// tracker states retain their familiar sage, purple and clay colors.
type PaletteOverrides = Partial<Record<ColorKey, string>>;
const variants: Record<Exclude<AppearancePaletteId, 'sage'>, { light: PaletteOverrides; dark: PaletteOverrides }> = {
  ocean: {
    light: { canvas: '#eaf3f7', surface: '#f6fcff', 'surface-soft': '#edf6fa', 'surface-muted': '#dcebf2', sidebar: '#e0edf4', line: '#c9dfe9', ink: '#253b48', 'ink-secondary': '#506b7b', 'ink-muted': '#526c79', brand: '#235d7c', green: '#256684', 'green-dark': '#1e5573', 'accent-ink': '#215d7a', 'accent-soft': '#d9edf6', spark: '#327fa0' },
    dark: { canvas: '#1c2933', surface: '#263744', 'surface-soft': '#2a3c49', 'surface-muted': '#334958', sidebar: '#21313e', line: '#435d6d', ink: '#e4eff7', 'ink-secondary': '#b5c9d7', 'ink-muted': '#a8c1d0', brand: '#326d8b', green: '#326d8b', 'green-dark': '#2b6180', 'accent-ink': '#a8d4ed', 'accent-soft': '#304e60', spark: '#8ecbe5' },
  },
  lavender: {
    light: { canvas: '#f2eef8', surface: '#fcf9ff', 'surface-soft': '#f5f0fb', 'surface-muted': '#eae2f2', sidebar: '#ebe5f4', line: '#dbd0e9', ink: '#393145', 'ink-secondary': '#6a5e7b', 'ink-muted': '#6b607a', brand: '#685085', green: '#6b528a', 'green-dark': '#584372', 'accent-ink': '#644b85', 'accent-soft': '#e9dff4', spark: '#9570b2' },
    dark: { canvas: '#282331', surface: '#352e40', 'surface-soft': '#3a3246', 'surface-muted': '#493e56', sidebar: '#2e2738', line: '#5a4b69', ink: '#eee7f6', 'ink-secondary': '#c8bdd7', 'ink-muted': '#baadcd', brand: '#735b91', green: '#735b91', 'green-dark': '#624d7d', 'accent-ink': '#d5b8f3', 'accent-soft': '#503e62', spark: '#d5a9ef' },
  },
  terracotta: {
    light: { canvas: '#f8eee6', surface: '#fff8f1', 'surface-soft': '#fcf1e9', 'surface-muted': '#f0e1d6', sidebar: '#f2e4d8', line: '#e8d5c5', ink: '#49372e', 'ink-secondary': '#795e4f', 'ink-muted': '#775f53', brand: '#914e36', green: '#965238', 'green-dark': '#7e422d', 'accent-ink': '#884a32', 'accent-soft': '#f4dfd1', spark: '#ac6240' },
    dark: { canvas: '#302620', surface: '#40312a', 'surface-soft': '#46362e', 'surface-muted': '#564237', sidebar: '#382b24', line: '#685044', ink: '#f5e9dd', 'ink-secondary': '#d3bfb0', 'ink-muted': '#c7b09f', brand: '#965b42', green: '#965b42', 'green-dark': '#854d36', 'accent-ink': '#f0ba98', 'accent-soft': '#5f4333', spark: '#f0b085' },
  },
  rose: {
    light: { canvas: '#f8edf0', surface: '#fff7fa', 'surface-soft': '#fbedf2', 'surface-muted': '#f0dfe6', sidebar: '#f2e1e8', line: '#e8d1dc', ink: '#49313c', 'ink-secondary': '#785967', 'ink-muted': '#755b67', brand: '#914865', green: '#964d6b', 'green-dark': '#803e59', 'accent-ink': '#8b425f', 'accent-soft': '#f3dce6', spark: '#ad6384' },
    dark: { canvas: '#30232b', surface: '#402e39', 'surface-soft': '#46323f', 'surface-muted': '#56404e', sidebar: '#372833', line: '#684c5c', ink: '#f7e7ef', 'ink-secondary': '#d5b9c8', 'ink-muted': '#c9aabc', brand: '#97566f', green: '#97566f', 'green-dark': '#86465f', 'accent-ink': '#f0b3cf', 'accent-soft': '#613e51', spark: '#efa6c7' },
  },
  graphite: {
    light: { canvas: '#f0f1f2', surface: '#fbfcfd', 'surface-soft': '#f4f5f6', 'surface-muted': '#e3e6e9', sidebar: '#e7e9ec', line: '#d4d9de', ink: '#303740', 'ink-secondary': '#5e6670', 'ink-muted': '#606872', brand: '#505e70', green: '#556374', 'green-dark': '#455264', 'accent-ink': '#4d5c70', 'accent-soft': '#e0e6ed', spark: '#72869d' },
    dark: { canvas: '#24282e', surface: '#30363e', 'surface-soft': '#343b44', 'surface-muted': '#424b56', sidebar: '#292f37', line: '#525e6d', ink: '#e9edf3', 'ink-secondary': '#bdc6d3', 'ink-muted': '#afbcca', brand: '#5a687b', green: '#5a687b', 'green-dark': '#4b596d', 'accent-ink': '#bccfe9', 'accent-soft': '#425065', spark: '#aec7e3' },
  },
  midnight: {
    light: { canvas: '#f3ebfc', surface: '#fcf7ff', 'surface-soft': '#f5edfc', 'surface-muted': '#e9dcf5', sidebar: '#ece1f6', line: '#dac8eb', ink: '#342541', 'ink-secondary': '#675173', 'ink-muted': '#6c557a', brand: '#7134a7', green: '#7438a8', 'green-dark': '#5e288c', 'accent-ink': '#683098', 'accent-soft': '#ead9f8', spark: '#9953c4' },
    dark: { canvas: '#000000', surface: '#0c0a10', 'surface-soft': '#15111b', 'surface-muted': '#21182c', sidebar: '#060509', line: '#3d2c50', ink: '#f2eafa', 'ink-secondary': '#cfbddf', 'ink-muted': '#bda6d0', brand: '#7843a8', green: '#7843a8', 'green-dark': '#64358f', 'accent-ink': '#d6b2ff', 'accent-soft': '#2c183f', spark: '#c48aef' },
  },
};

function endpoints(id: AppearancePaletteId) {
  const variant = id === 'sage' ? undefined : variants[id];
  return { light: { ...lightPalette, ...variant?.light }, dark: { ...darkPalette, ...variant?.dark } };
}

function channels(color: string): number[] {
  return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255);
}

function hex(values: number[]): string {
  return '#' + values.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('');
}

function blend(start: string, end: string, position: number): string {
  const finish = channels(end);
  return hex(channels(start).map((value, index) => value + (finish[index] - value) * position));
}

const linear = (value: number) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const encoded = (value: number) => value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055;
const weighted = (values: number[]) => values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
const luminance = (color: string) => weighted(channels(color).map(linear));

export function contrastRatio(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1] + .05) / (values[0] + .05);
}

function atLuminance(color: string, target: number): string {
  // Pure black is a valid endpoint; avoid dividing its zero luminance by zero.
  if (target <= 0) return '#000000';
  const values = channels(color).map(linear);
  const current = weighted(values);
  // Mixing toward white/black in linear RGB preserves the target luminance.
  const adjusted = current < target
    ? values.map(value => value + (1 - value) * (target - current) / (1 - current))
    : values.map(value => value * target / current);
  return hex(adjusted.map(encoded));
}

const surfaces: ColorKey[] = ['canvas', 'surface', 'surface-soft', 'surface-muted', 'sidebar', 'accent-soft', 'highlight', 'sage', 'blue', 'clay', 'board-todo', 'board-progress', 'board-complete'];
const commonSurfaces: ColorKey[] = ['canvas', 'surface', 'surface-soft', 'surface-muted', 'sidebar', 'accent-soft', 'highlight', 'board-todo', 'board-progress', 'board-complete'];

function readable(seed: string, backgrounds: string[], darkText: boolean): string {
  const extreme = darkText ? '#000000' : '#ffffff';
  for (let amount = 0; amount <= 100; amount++) {
    const candidate = blend(seed, extreme, amount / 100);
    if (backgrounds.every(background => contrastRatio(candidate, background) >= 4.5)) return candidate;
  }
  return extreme;
}

export function appearancePalette(value: number, paletteId: AppearancePaletteId = 'sage'): Record<ColorKey, string> {
  const position = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)) / 100;
  const { light, dark } = endpoints(paletteId);
  const palette = Object.fromEntries((Object.keys(lightPalette) as ColorKey[]).map(key => [key, blend(light[key], dark[key], position)])) as Record<ColorKey, string>;

  // Backgrounds cross the readable-text threshold together, without jumping
  // between presets. Hue is retained while luminance follows a continuous path.
  // At the midpoint, either black or white text has at least 4.5:1 contrast.
  for (const key of surfaces) {
    const target = position <= .5
      ? luminance(light[key]) + (.179 - luminance(light[key])) * position * 2
      : .179 + (luminance(dark[key]) - .179) * (position - .5) * 2;
    palette[key] = atLuminance(palette[key], target);
  }

  const darkText = position <= .5;
  const foregrounds = darkText ? light : dark;
  const normalBackgrounds = commonSurfaces.map(key => palette[key]);
  for (const key of ['ink', 'ink-secondary', 'ink-muted', 'accent-ink'] as const) {
    palette[key] = readable(foregrounds[key], normalBackgrounds, darkText);
  }
  for (const [foreground, background] of [
    ['sage-ink', 'sage'], ['blue-ink', 'blue'], ['clay-ink', 'clay'],
    ['todo-ink', 'board-todo'], ['progress-ink', 'board-progress'], ['complete-ink', 'board-complete'],
  ] as const) {
    palette[foreground] = readable(foregrounds[foreground], [palette[background], palette.surface, palette['surface-soft'], palette.sidebar], darkText);
  }
  return palette;
}

export function applyAppearance(value: number, paletteId: AppearancePaletteId = 'sage'): void {
  const position = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const root = document.documentElement;
  for (const [key, color] of Object.entries(appearancePalette(position, paletteId))) root.style.setProperty(`--${key}`, color);
  for (const [key, amount] of [['light', 0], ['middle', 50], ['dark', 100]] as const) {
    root.style.setProperty(`--appearance-${key}`, appearancePalette(amount, paletteId).canvas);
  }
  root.dataset.appearance = String(position);
  root.dataset.palette = paletteId;
  // Native dropdowns and other OS controls expose only a light/dark scheme.
  root.style.colorScheme = position <= 50 ? 'light' : 'dark';
}
