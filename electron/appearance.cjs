'use strict';
const CHANNEL = 'labmate:appearance';
function appearanceStatus(theme, requested = 'solid', platform = process.platform) {
  const reducedTransparency = !!theme?.prefersReducedTransparency;
  const highContrast = !!theme?.shouldUseHighContrastColors;
  return {material: requested === 'glass' && platform === 'darwin' && !reducedTransparency && !highContrast ? 'glass' : 'solid', reducedTransparency, highContrast};
}
function applyMaterial(window, theme, requested) {
  if (!window || window.isDestroyed?.()) return appearanceStatus(theme);
  if (requested) window.__labmateMaterial = requested;
  const status = appearanceStatus(theme, window.__labmateMaterial);
  if (process.platform === 'darwin') window.setVibrancy?.(status.material === 'glass' ? 'under-window' : null);
  window.setBackgroundColor?.(status.material === 'glass' ? '#00000000' : '#f9f1df');
  window.webContents?.send?.(CHANNEL, status);
  return status;
}
function installMaterial(window, theme) {
  const update = () => applyMaterial(window, theme);
  theme?.on?.('updated', update);
  window.on?.('closed', () => theme?.removeListener?.('updated', update));
  window.webContents?.on?.('did-finish-load', update);
}
module.exports = {CHANNEL, appearanceStatus, applyMaterial, installMaterial};
