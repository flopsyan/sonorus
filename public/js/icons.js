// The icon set, as inline SVG. One source for both the static shell markup
// (elements carrying data-icon) and everything rendered at runtime.

const STROKE = {
  home: '<path d="M4 10.5 12 3.5l8 7V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  music: '<path d="M9 18V5.5l12-2V16"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  tag: '<path d="M20.5 12.5 12 21l-9-9V3h9z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.6l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'folder-plus': '<path d="M3 7a2 2 0 0 1 2-2h3.6l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M3.5 20.5 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m3.5 3.5 5 5"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  'volume-high': '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  'volume-low': '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  'volume-mute': '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  queue: '<path d="M4 6h11M4 12h11M4 18h7"/><path d="m17 12.5 5 3-5 3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'plus-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5v6h-6"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  alert: '<path d="M12 3.5 2 20.5h20z"/><path d="M12 10v4.5"/><path d="M12 17.6h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  maximize: '<path d="M8 3H4a1 1 0 0 0-1 1v4"/><path d="M16 3h4a1 1 0 0 1 1 1v4"/><path d="M16 21h4a1 1 0 0 0 1-1v-4"/><path d="M8 21H4a1 1 0 0 1-1-1v-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.2 1.9"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7.5" y="12" width="3" height="5" rx="0.8"/><rect x="13" y="8" width="3" height="9" rx="0.8"/><rect x="18" y="14" width="3" height="3" rx="0.8"/>',
  trending: '<path d="m3 17 5.5-5.5 4 4L21 7"/><path d="M15 7h6v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.6 3.4a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5z"/>',
  pin: '<path d="M9 3.5h6v5l2.8 3.8H6.2L9 8.5z"/><path d="M12 12.3V21"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4 17 5-4.5 4.5 4 3-2.5L20 18"/>',
  sparkles: '<path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="m18.5 15.5.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
};

const FILL = {
  play: '<path d="M7.5 4.8v14.4L19.5 12z"/>',
  pause: '<rect x="6.5" y="4.5" width="4" height="15" rx="1.2"/><rect x="13.5" y="4.5" width="4" height="15" rx="1.2"/>',
  'skip-back': '<path d="M18.5 5.4v13.2L9 12z"/><rect x="5" y="5" width="2.6" height="14" rx="1.2"/>',
  'skip-forward': '<path d="M5.5 5.4v13.2L15 12z"/><rect x="16.4" y="5" width="2.6" height="14" rx="1.2"/>',
  more: '<circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  star: '<path d="m12 2.6 2.9 6 6.6.9-4.8 4.7 1.2 6.6L12 17.7l-5.9 3.1 1.2-6.6L2.5 9.5l6.6-.9z"/>',
};

// Outline version of the star, so an unrated track shows the same shape.
const STAR_OUTLINE = '<path d="m12 2.6 2.9 6 6.6.9-4.8 4.7 1.2 6.6L12 17.7l-5.9 3.1 1.2-6.6L2.5 9.5l6.6-.9z"/>';

export function icon(name, size = 18) {
  if (name === 'star-outline') {
    return svg(STAR_OUTLINE, size, false);
  }
  if (FILL[name]) return svg(FILL[name], size, true);
  if (STROKE[name]) return svg(STROKE[name], size, false);
  return '';
}

function svg(body, size, filled) {
  const paint = filled
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" ${paint} aria-hidden="true">${body}</svg>`;
}

// Fills every element carrying data-icon inside `root`. Called after each
// render, so markup can just declare which icon it wants.
export function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const size = Number(el.dataset.iconSize) || 18;
    el.innerHTML = icon(el.dataset.icon, size);
  });
}
