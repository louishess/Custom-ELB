import assert from 'node:assert/strict';
import { appearancePalette, contrastRatio } from '../src/appearance.ts';

const backgrounds = ['canvas', 'surface', 'surface-soft', 'surface-muted', 'sidebar', 'accent-soft', 'highlight', 'board-todo', 'board-progress', 'board-complete'];
let lastLumaProxy = Infinity;
let minimumContrast = Infinity;
for (let value = 0; value <= 100; value++) {
  const colors = appearancePalette(value);
  const lumaProxy = contrastRatio(colors.canvas, '#000000');
  assert.ok(lumaProxy < lastLumaProxy, `Canvas must darken continuously at ${value}`);
  lastLumaProxy = lumaProxy;
  const pairs = ['ink', 'ink-secondary', 'ink-muted', 'accent-ink'].flatMap(ink => backgrounds.map(background => [ink, background]));
  pairs.push(['sage-ink', 'sage'], ['blue-ink', 'blue'], ['clay-ink', 'clay'], ['todo-ink', 'board-todo'], ['progress-ink', 'board-progress'], ['complete-ink', 'board-complete'], ['on-accent', 'green']);
  for (const [ink, background] of pairs) {
    const contrast = contrastRatio(colors[ink], colors[background]);
    minimumContrast = Math.min(minimumContrast, contrast);
    assert.ok(contrast >= 4.5, `${value}%: ${ink} on ${background} has ${contrast.toFixed(2)}:1 contrast`);
  }
}
assert.deepEqual(appearancePalette(-1), appearancePalette(0));
assert.deepEqual(appearancePalette(101), appearancePalette(100));
assert.deepEqual(appearancePalette(NaN), appearancePalette(0));
assert.equal(appearancePalette(0).canvas, '#f9f1df');
assert.equal(appearancePalette(100).canvas, '#1d2826');
console.log(`PASS 101 slider positions, endpoint preservation, monotonic brightness, and text contrast (minimum ${minimumContrast.toFixed(2)}:1).`);
