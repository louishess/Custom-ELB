'use strict';
const CHANNEL = 'labmate:appearance';
const ACCESSIBILITY_NOTIFICATION = 'NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification';
function appearanceStatus(theme, requested = 'solid', platform = process.platform, preferences) {
  const reducedTransparency = !!theme?.prefersReducedTransparency;
  const highContrast = !!theme?.shouldUseHighContrastColors;
  const reducedMotion = !!preferences?.getAnimationSettings?.().prefersReducedMotion;
  return {material: requested === 'glass' && platform === 'darwin' && !reducedTransparency && !highContrast ? 'glass' : 'solid', reducedTransparency, highContrast, reducedMotion};
}
function applyMaterial(window, theme, requested, preferences) {
  if (!window || window.isDestroyed?.()) return appearanceStatus(theme, requested, process.platform, preferences);
  if (requested) window.__labmateMaterial = requested;
  const status = appearanceStatus(theme, window.__labmateMaterial, process.platform, preferences);
  window.__labmateAppearanceStatus = status;
  if (process.platform === 'darwin') window.setVibrancy?.(status.material === 'glass' ? 'under-window' : null);
  window.setBackgroundColor?.(status.material === 'glass' ? '#00000000' : '#f9f1df');
  window.webContents?.send?.(CHANNEL, status);
  return status;
}
function installMaterial(window, theme, preferences) {
  // BrowserWindow.webContents is a native getter that throws after the window
  // is destroyed. Keep its EventEmitter reference for closed-event cleanup.
  const contents = window.webContents;
  const update = () => applyMaterial(window, theme, undefined, preferences);
  const refresh = () => {
    if (window.isDestroyed?.()) return;
    const next = appearanceStatus(theme, window.__labmateMaterial, process.platform, preferences);
    const previous = window.__labmateAppearanceStatus;
    if (!previous || Object.keys(next).some(key => next[key] !== previous[key])) update();
  };
  theme?.on?.('updated', update);
  window.on?.('focus', refresh);
  contents?.on?.('did-finish-load', update);
  // Motion changes are not guaranteed to emit nativeTheme.updated. AppKit
  // publishes them on NSWorkspace's notification center, not the distributed
  // center. Poll the public native getter as a fallback for missed events.
  const subscription = process.platform === 'darwin'
    ? preferences?.subscribeWorkspaceNotification?.(ACCESSIBILITY_NOTIFICATION, refresh) : undefined;
  const timer = preferences?.getAnimationSettings ? setInterval(refresh, 1000) : undefined;
  timer?.unref?.();
  window.on?.('closed', () => {
    if (timer) clearInterval(timer);
    if (subscription !== undefined) preferences?.unsubscribeWorkspaceNotification?.(subscription);
    theme?.removeListener?.('updated', update);
    window.removeListener?.('focus', refresh);
    contents?.removeListener?.('did-finish-load', update);
  });
}
module.exports = {CHANNEL, ACCESSIBILITY_NOTIFICATION, appearanceStatus, applyMaterial, installMaterial};
