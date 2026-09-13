/** Reference content area (photo minus bezel) the HUD layout was authored against. */
export const REF_WIDTH = 1160;
export const REF_HEIGHT = 755;

/**
 * Scales the HUD uniformly so the composition holds at any viewport size. Width-driven for
 * landscape screens (the reference case); the height clamp keeps the cluster and mini-map
 * proportionate on very short or portrait viewports.
 */
export function updateHudScale(width: number, height: number): number {
  const byWidth = width / REF_WIDTH;
  const byHeight = height / REF_HEIGHT;
  let s = Math.max(0.3, Math.min(byWidth, byHeight * 1.25, 2.2));
  // Narrow (phone / portrait) viewports: scale by width more generously; the CSS media query
  // repositions the bottom panels so they still fit side by side.
  if (width < 700) s = Math.min(Math.max(width / 820, 0.45), 0.85, byHeight * 1.4);
  document.documentElement.style.setProperty('--s', `${s.toFixed(4)}px`);
  return s;
}
