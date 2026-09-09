import assert from 'node:assert/strict';
import { appearancePalette, appearancePalettes, contrastRatio } from '../src/appearance.ts';

const backgrounds = ['canvas', 'surface', 'surface-soft', 'surface-muted', 'sidebar', 'accent-soft', 'highlight', 'board-todo', 'board-progress', 'board-complete'];
let minimumContrast = Infinity;
for (const { id } of appearancePalettes) {
let lastLumaProxy = Infinity;
for (let value = 0; value <= 100; value++) {
  const colors = appearancePalette(value, id);
  const originalColors = appearancePalette(value);
  for (const key of ['sage', 'blue', 'clay', 'board-todo', 'board-progress', 'board-complete']) {
    assert.equal(colors[key], originalColors[key], `${id}: semantic ${key} changes at ${value}`);
  }
  const lumaProxy = contrastRatio(colors.canvas, '#000000');
  assert.ok(lumaProxy < lastLumaProxy, `${id}: Canvas must darken continuously at ${value}`);
  lastLumaProxy = lumaProxy;
  const pairs = ['ink', 'ink-secondary', 'ink-muted', 'accent-ink'].flatMap(ink => backgrounds.map(background => [ink, background]));
  pairs.push(['sage-ink', 'sage'], ['blue-ink', 'blue'], ['clay-ink', 'clay'], ['todo-ink', 'board-todo'], ['progress-ink', 'board-progress'], ['complete-ink', 'board-complete'], ['on-accent', 'green'], ['on-accent', 'green-dark'], ['on-accent', 'brand']);
  for (const [ink, background] of pairs) {
    const contrast = contrastRatio(colors[ink], colors[background]);
    minimumContrast = Math.min(minimumContrast, contrast);
    assert.ok(contrast >= 4.5, `${id} ${value}%: ${ink} on ${background} has ${contrast.toFixed(2)}:1 contrast`);
  }
}
assert.deepEqual(appearancePalette(-1, id), appearancePalette(0, id));
assert.deepEqual(appearancePalette(101, id), appearancePalette(100, id));
assert.deepEqual(appearancePalette(NaN, id), appearancePalette(0, id));
}
assert.deepEqual(appearancePalette(-1), appearancePalette(0));
assert.deepEqual(appearancePalette(101), appearancePalette(100));
assert.deepEqual(appearancePalette(NaN), appearancePalette(0));
assert.equal(appearancePalette(0).canvas, '#f9f1df');
assert.equal(appearancePalette(100).canvas, '#1d2826');
assert.equal(new Set(appearancePalettes.map(({ id }) => appearancePalette(0, id).canvas)).size, 6);
console.log(`PASS all six palettes at 101 slider positions, endpoint and semantic color preservation, monotonic brightness, and text contrast (minimum ${minimumContrast.toFixed(2)}:1).`);
