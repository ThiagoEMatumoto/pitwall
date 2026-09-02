// Self-correction rounds, decided from the design_screenshot PNGs of the
// previous round (ds-real-shot-<artboard>-r<n>.png). Each fix targets nodes by
// data-name — `all` hits every node carrying it (menu rows), `path` walks
// child indices for unnamed descendants — so ids are always resolved through
// design_children_get, never invented. Each fix is the smallest surgery.
import type { ArtboardKey } from './session'

export interface Fix {
  artboard: ArtboardKey
  name: string
  // Apply to every node carrying the name (menu rows, form inputs).
  all?: boolean
  // Child indices to walk down from the named node (e.g. [1, 0]).
  path?: number[]
  // Style patch (null removes a property).
  style?: Record<string, string | null>
  text?: string
  why: string
}

// Round 1 — r0: Home and Cardápio pushed the footer past the 900px edge (only
// a brown strip showed); the mobile hero visual was squeezed by flex-shrink and
// the page overflowed 844px; the first menu title wrapped to two lines and
// misaligned the three column headers; the contact form had the side-by-side
// fields at 96px and the order field at 48px (inverted), the card stretched
// below its button, and the headline left "pão." alone on the last line.
const ROUND_1: Fix[] = [
  { artboard: 'home', name: 'Hero', style: { padding: '36px 72px 28px' }, why: 'footer overflow' },
  { artboard: 'home', name: 'Hero visual', style: { height: '420px' }, why: 'footer overflow' },
  {
    artboard: 'home',
    name: 'Highlights',
    style: { padding: '0 72px 28px' },
    why: 'footer overflow',
  },

  {
    artboard: 'mobile',
    name: 'Hero visual',
    style: { 'flex-shrink': '0', height: '150px' },
    why: 'visual squeezed by flex-shrink',
  },
  {
    artboard: 'mobile',
    name: 'Hero',
    style: { padding: '20px 20px 16px', gap: '14px' },
    why: 'vertical overflow',
  },
  {
    artboard: 'mobile',
    name: 'Highlights',
    style: { padding: '16px 20px', gap: '8px' },
    why: 'vertical overflow',
  },
  {
    artboard: 'mobile',
    name: 'Highlights',
    path: [0],
    style: { padding: '10px 14px' },
    why: 'vertical overflow',
  },
  {
    artboard: 'mobile',
    name: 'Highlights',
    path: [1],
    style: { padding: '10px 14px' },
    why: 'vertical overflow',
  },
  {
    artboard: 'mobile',
    name: 'Highlights',
    path: [2],
    style: { padding: '10px 14px' },
    why: 'vertical overflow',
  },
  {
    artboard: 'mobile',
    name: 'Footer',
    style: {
      'flex-direction': 'row',
      'justify-content': 'space-between',
      gap: '16px',
      padding: '14px 20px',
    },
    why: 'two stacked lines wasted 20px',
  },
  { artboard: 'mobile', name: 'Lead', style: { 'font-size': '15px' }, why: 'vertical overflow' },

  {
    artboard: 'menu',
    name: 'Seção pães título',
    text: 'Fermentação natural',
    why: 'two-line title misaligned the columns',
  },
  { artboard: 'menu', name: 'Intro', style: { padding: '32px 72px 20px' }, why: 'footer overflow' },
  {
    artboard: 'menu',
    name: 'Menu grid',
    style: { padding: '0 72px 20px' },
    why: 'footer overflow',
  },
  {
    artboard: 'menu',
    name: 'Item',
    all: true,
    style: { padding: '12px 0' },
    why: 'footer overflow',
  },

  {
    artboard: 'contact',
    name: 'Campo telefone input',
    style: { height: '48px' },
    why: 'short field rendered 96px tall',
  },
  {
    artboard: 'contact',
    name: 'Campo data input',
    style: { height: '48px' },
    why: 'short field rendered 96px tall',
  },
  {
    artboard: 'contact',
    name: 'Campo pedido input',
    style: { height: '96px' },
    why: 'the order field is the long one',
  },
  {
    artboard: 'contact',
    name: 'Formulário de encomenda',
    style: { 'align-self': 'flex-start' },
    why: 'card stretched below its button',
  },
  {
    artboard: 'contact',
    name: 'Título',
    style: { 'font-size': '48px' },
    why: 'orphan word on the second line',
  },
]

// Round 2 — r1: everything fits; polish. Home footer was still squeezed below
// its 96px; mobile had an empty band above the footer; Cardápio wanted a bit
// more breathing room; the contact headline still broke as "…do / pão.".
const ROUND_2: Fix[] = [
  { artboard: 'home', name: 'Footer', style: { 'flex-shrink': '0' }, why: 'footer squeezed' },
  {
    artboard: 'home',
    name: 'Highlights',
    style: { padding: '0 72px 24px' },
    why: 'room for the footer',
  },
  { artboard: 'home', name: 'Hero visual', style: { height: '400px' }, why: 'room for the footer' },

  {
    artboard: 'mobile',
    name: 'Hero visual',
    style: { height: '176px' },
    why: 'empty band above the footer',
  },
  {
    artboard: 'mobile',
    name: 'Highlights',
    style: { padding: '18px 20px', gap: '10px' },
    why: 'empty band above the footer',
  },

  {
    artboard: 'menu',
    name: 'Encomendas',
    style: { margin: '0 72px 24px' },
    why: 'breathing room before the footer',
  },
  {
    artboard: 'menu',
    name: 'Intro',
    style: { padding: '36px 72px 24px' },
    why: 'breathing room after the header',
  },

  {
    artboard: 'contact',
    name: 'Título',
    text: 'Venha pelo cheiro, fique pelo pão.',
    why: 'two balanced lines',
  },
  {
    artboard: 'contact',
    name: 'Título',
    style: { 'font-size': '52px' },
    why: 'two balanced lines',
  },
  {
    artboard: 'contact',
    name: 'Contato',
    style: { padding: '48px 72px 40px' },
    why: 'rhythm with the other pages',
  },
]

export const ROUNDS: Fix[][] = [ROUND_1, ROUND_2]
