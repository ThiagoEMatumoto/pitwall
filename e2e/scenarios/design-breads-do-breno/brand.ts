// Brand system for "Breads do Breno" — warm artisanal bakery. Every artboard
// references these through var(--color-*), var(--font-*), var(--radius-*).

export const FONTS = [
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Manrope:wght@400;500;600;700&display=swap',
]

export const TOKENS = {
  color: {
    bg: '#F7EFE1',
    surface: '#EFE3CC',
    'surface-strong': '#E4D3B3',
    ink: '#2B1C10',
    bread: '#6B4423',
    crust: '#C98A2E',
    'crust-soft': '#E7B96A',
    olive: '#5F6F3A',
    muted: '#7A6650',
    line: '#DCCBB0',
    white: '#FFFDF8',
  },
  font: {
    display: "'Fraunces', Georgia, serif",
    body: "'Manrope', system-ui, sans-serif",
  },
  radius: {
    sm: '10px',
    md: '18px',
    lg: '28px',
    pill: '999px',
  },
  shadow: {
    card: '0 1px 2px rgba(43,28,16,0.06), 0 12px 32px -16px rgba(43,28,16,0.25)',
  },
}

// ---- inline SVG icons (stroke inherits currentColor) ----

const icon = (body: string, size = 20): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const ICONS = {
  wheat: (size?: number) =>
    icon(
      '<path d="M12 22V9"/><path d="M12 13c-3 0-5-2-5-5 3 0 5 2 5 5z"/><path d="M12 13c3 0 5-2 5-5-3 0-5 2-5 5z"/><path d="M12 18c-3 0-5-2-5-5 3 0 5 2 5 5z"/><path d="M12 18c3 0 5-2 5-5-3 0-5 2-5 5z"/><path d="M12 9c-2 0-3.5-1.5-3.5-3.5C10.5 5.5 12 7 12 9z"/><path d="M12 9c2 0 3.5-1.5 3.5-3.5C13.5 5.5 12 7 12 9z"/>',
      size,
    ),
  fire: (size?: number) =>
    icon(
      '<path d="M12 22c4 0 7-3 7-7 0-3-2-5-3-7-1 2-2 3-3 3 0-3-1-6-4-8 0 4-4 6-4 12 0 4 3 7 7 7z"/>',
      size,
    ),
  stone: (size?: number) =>
    icon(
      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v6.5M12 14.5V21M3 12h6.5M14.5 12H21"/>',
      size,
    ),
  clock: (size?: number) => icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', size),
  pin: (size?: number) =>
    icon(
      '<path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
      size,
    ),
  phone: (size?: number) =>
    icon(
      '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
      size,
    ),
  instagram: (size?: number) =>
    icon(
      '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>',
      size,
    ),
  menu: (size?: number) => icon('<path d="M4 7h16M4 12h16M4 17h16"/>', size),
  arrow: (size?: number) => icon('<path d="M5 12h14M13 6l6 6-6 6"/>', size),
}

// Logo mark: a scored loaf.
export const LOGO_MARK = `<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><rect width="36" height="36" rx="10" fill="var(--color-bread)"/><path d="M8 22c0-6 4.5-10 10-10s10 4 10 10c0 1.7-1.3 3-3 3H11c-1.7 0-3-1.3-3-3z" fill="var(--color-crust-soft)"/><path d="M13 16l2.5 3M18 14.5l2.5 3M23 16l2.5 3" stroke="var(--color-bread)" stroke-width="1.6" stroke-linecap="round"/></svg>`

// Hero illustration: a country loaf on a board, drawn in brand colors.
export function loafIllustration(width: number): string {
  return `<svg data-name="Ilustração pão" width="${width}" viewBox="0 0 360 240" fill="none">
<ellipse cx="180" cy="200" rx="160" ry="22" fill="#4A2E16" opacity="0.35"/>
<rect x="30" y="170" width="300" height="26" rx="13" fill="#8A5A2B"/>
<path d="M60 160c0-52 54-88 120-88s120 36 120 88c0 12-9 20-20 20H80c-11 0-20-8-20-20z" fill="#B4712A"/>
<path d="M68 152c6-44 54-72 112-72s106 28 112 72c-30-24-70-34-112-34s-82 10-112 34z" fill="#D9A356"/>
<path d="M104 124l16 22M140 108l16 24M180 102l14 26M220 108l12 26M254 124l10 24" stroke="#6B4423" stroke-width="7" stroke-linecap="round"/>
<path d="M104 124l16 22M140 108l16 24M180 102l14 26M220 108l12 26M254 124l10 24" stroke="#F3D9A4" stroke-width="2.5" stroke-linecap="round" opacity="0.9"/>
<circle cx="120" cy="140" r="1.8" fill="#F7EFE1"/><circle cx="212" cy="146" r="1.8" fill="#F7EFE1"/><circle cx="168" cy="150" r="1.6" fill="#F7EFE1"/><circle cx="246" cy="156" r="1.8" fill="#F7EFE1"/>
</svg>`
}
