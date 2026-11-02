/**
 * Line icons (24 px viewBox, stroked with currentColor), shared by the touch tools, the
 * Quick settings panel, the command palette and the context hints.
 */
export const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS = {
  pause: svg('<path d="M9 5v14M15 5v14"/>'),
  map: svg('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  // A quadcopter from above: four props on an X.
  fly: svg(
    '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/><rect x="10" y="10" width="4" height="4" rx="1"/>' +
      '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/>' +
      '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/>',
  ),
  glider: svg('<path d="M3 9c3-4 15-4 18 0"/><path d="M4 9l8 10 8-10M12 9v10"/>'),
  sled: svg('<path d="M3 17h13l3-3"/><path d="M5 17l2-5h7l3 2"/><path d="M10 12l1-3h3"/>'),
  view: svg(
    '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ),
  labels: svg('<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8" r="1.5"/>'),
  // Piste colours: mountains with a run winding down them.
  pistes: svg(
    '<path d="M2 20l7-13 4 6 2-3 7 10z"/><path d="M9 7.5c-1.5 2.5 2 3.5.5 6.5S9 18 10 20"/>',
  ),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  jump: svg('<path d="M12 20V5"/><path d="M5 12l7-7 7 7"/>'),
  tuck: svg('<path d="M6 7l6 6 6-6"/><path d="M6 13l6 6 6-6"/>'),
  stop: svg('<path d="M5 19L19 5"/><path d="M4 12h6M14 12h6" opacity="0.5"/>'),
  flipFwd: svg('<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M17 2v4h-4"/>'),
  flipBack: svg('<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M7 2v4h4"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  skip: svg('<path d="M5 5l9 7-9 7z"/><path d="M18 5v14"/>'),
  fast: svg('<path d="M3 5l8 7-8 7z"/><path d="M12 5l8 7-8 7z"/>'),
  off: svg('<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>'),
  lean: svg('<circle cx="14" cy="5" r="2"/><path d="M13 8l-4 6 5 2-2 5"/><path d="M4 21h16"/>'),
  flaps: svg('<path d="M3 10h12l6 2"/><path d="M15 10l5 6"/>'),
  turnLeft: svg('<path d="M9 7H15a5 5 0 0 1 0 10h-4"/><path d="M12 4L9 7l3 3"/>'),
  turnRight: svg('<path d="M15 7H9a5 5 0 0 0 0 10h4"/><path d="M12 4l3 3-3 3"/>'),
  bail: svg('<circle cx="12" cy="5" r="2"/><path d="M5 10l7 2 7-2M12 12v4l-4 5M12 16l4 5"/>'),
  canopy: svg('<path d="M3 10c3-5 15-5 18 0"/><path d="M3 10l9 9 9-9M8 9l4 10 4-10"/>'),
  brake: svg('<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>'),
  // Registry entries (ui/toggles.ts): the Quick settings panel, palette and hints.
  lift: svg(
    '<path d="M3 5l18-2"/><path d="M12 4v5"/><rect x="7" y="9" width="10" height="8" rx="2"/><path d="M7 13h10"/>',
  ),
  peak: svg('<path d="M3 20l6-13 4 7 2-3 6 9z"/>'),
  // A plane seen from above.
  airfield: svg(
    '<path d="M12 3c1 0 1.5 1 1.5 2v5l7 4v2l-7-2v4l2 1.5V21L12 20l-3.5 1v-1.5l2-1.5v-4l-7 2v-2l7-4V5c0-1 .5-2 1.5-2z"/>',
  ),
  restaurant: svg('<path d="M6 3v8M9 3v8M6 11h3M7.5 11v10M17 3c-2 0-3 3-3 6h3zM17 9v12"/>'),
  hud: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h5M16 15h5"/>'),
  sound: svg('<path d="M4 9v6h4l5 4V5L8 9H4zM16 8a5 5 0 010 8"/>'),
  snowboard: svg(
    '<rect x="3" y="9.5" width="18" height="5" rx="2.5" transform="rotate(-20 12 12)"/><path d="M9 10.5v3M15 8.5v3"/>',
  ),
  sign: svg('<path d="M5 4h11l3 3-3 3H5zM11 10v10M8 20h6"/>'),
  debug: svg('<path d="M4 19V5M4 19h16"/><path d="M7 15l4-5 3 3 5-7"/>'),
  marker: svg(
    '<path d="M12 21s-6-6.5-6-11a6 6 0 0112 0c0 4.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  ),
  teleport: svg(
    '<path d="M12 21s-6-6.5-6-11a6 6 0 0112 0c0 4.5-6 11-6 11z"/><path d="M10 10h4M12.5 8l1.5 2-1.5 2"/>',
  ),
  ski: svg('<path d="M5 20L17 3M9 21L21 4"/><path d="M4 19l2 2M8 20l2 2"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  screenshot: svg(
    '<path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/><circle cx="12" cy="12" r="3"/>',
  ),
  options: svg(
    '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  ),
  controls: svg(
    '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  ),
  rules: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7"/>'),
  time: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  weather: svg(
    '<path d="M7 17a4 4 0 01-.5-8A6 6 0 0118 9a4 4 0 010 8z"/><path d="M9 20l1-1M13 20l1-1"/>',
  ),
  multiplayer: svg(
    '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M15 14.5c3 0 6 2 6 5.5"/>',
  ),
  quick: svg('<path d="M12 2l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  minimap: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12h8M12 8v8"/>'),
};

export type IconName = keyof typeof ICONS;
