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

export function appearancePalette(value: number): Record<ColorKey, string> {
  const position = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)) / 100;
  const palette = Object.fromEntries((Object.keys(lightPalette) as ColorKey[]).map(key => [key, blend(lightPalette[key], darkPalette[key], position)])) as Record<ColorKey, string>;

  // Backgrounds cross the readable-text threshold together, without jumping
  // between presets. Hue is retained while luminance follows a continuous path.
  // At the midpoint, either black or white text has at least 4.5:1 contrast.
  for (const key of surfaces) {
    const target = position <= .5
      ? luminance(lightPalette[key]) + (.179 - luminance(lightPalette[key])) * position * 2
      : .179 + (luminance(darkPalette[key]) - .179) * (position - .5) * 2;
    palette[key] = atLuminance(palette[key], target);
  }

  const darkText = position <= .5;
  const foregrounds = darkText ? lightPalette : darkPalette;
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

export function applyAppearance(value: number): void {
  const position = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const root = document.documentElement;
  for (const [key, color] of Object.entries(appearancePalette(position))) root.style.setProperty(`--${key}`, color);
  root.dataset.appearance = String(position);
  // Native dropdowns and other OS controls expose only a light/dark scheme.
  root.style.colorScheme = position <= 50 ? 'light' : 'dark';
}
