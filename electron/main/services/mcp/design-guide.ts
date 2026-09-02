import { ARTBOARD_PRESETS } from '../../../../shared/types/design'

// What an agent reads before touching a design. Served whole or by section by
// design_guide; every design_* description points at a section number.

export interface GuideSection {
  n: number
  title: string
  body: string
}

const presetLines = ARTBOARD_PRESETS.map((p) => `- ${p.label}: ${p.width}×${p.height}`).join('\n')

export const DESIGN_GUIDE_SECTIONS: readonly GuideSection[] = [
  {
    n: 1,
    title: 'Required flow',
    body: `1. design_guide (this) once per session.
2. design_document_list → design_document_get(docId) or design_tree_summary(artboardId) to see what exists. Never invent ids: every id you pass must come from a previous read.
3. Edit with the smallest tool that does the job (§3).
4. design_screenshot(artboardId) after each artboard you touched; fix what the image shows (§7).
5. design_nodes_finish(artboardId, summary) when the artboard is done. It clears the "Claude is editing" badge in the UI and records a named version. Skipping it leaves the badge on for 5 minutes.

If the human asked from inside the Design Studio, the prompt carries docId/artboardId/selected node ids — use them, do not create a new document.`,
  },
  {
    n: 2,
    title: 'Mental model',
    body: `document > pages > artboards > nodes.
- An artboard is a fixed-size canvas (width × height in px) rendered in an isolated iframe. Its tree is real HTML: a root frame (div) with children.
- Node = { id, tag, kind (frame|text|image|svg|element), style (inline CSS), attrs, text?, children, name? }.
- Ids are stable 10-char strings assigned on insert. Duplicating gives new ids; moving/styling keeps them.
- Every write bumps the artboard version. Versions with a summary are snapshots the human can roll back to; design_nodes_finish creates one.
- The human edits the same tree live. Read before you write when time has passed: their changes are in the tree, not in your memory.

Artboard sizes (use these unless asked otherwise):
${presetLines}
Mobile and desktop are separate artboards — never try to make one artboard responsive.`,
  },
  {
    n: 3,
    title: 'Pick the smallest surgery',
    body: `| Want to | Use |
|---|---|
| change a color, spacing, font, size | design_styles_update (patch; null removes a property) |
| change copy | design_text_set |
| rename a layer for the human | design_nodes_rename |
| add a block/section/card | design_write_html mode "insert" with parentId + index |
| repeat an item (card, list row) | design_nodes_duplicate, then design_text_set on the copies |
| reorder / reparent | design_nodes_move |
| remove | design_nodes_delete |
| rebuild ≥ 50% of an artboard | design_write_html mode "replace" |
| brand colors/fonts for the whole document | design_tokens_set |
| navigation between artboards | design_link_set (§8) |

Never replace a whole artboard to change one style — the human's manual tweaks live in that tree.`,
  },
  {
    n: 4,
    title: 'Accepted HTML',
    body: `design_write_html takes an HTML fragment (or a full document — <style> in <head> becomes document CSS, Google Fonts <link> tags become document fonts).
Allowed tags: div section header footer nav main article aside h1-h6 p span a ul ol li img button input label form strong em small br hr svg (+ path, circle, rect, g, line, polygon, text, defs, linearGradient, stop).
Dropped with a warning: script iframe object embed meta base template, any on*= attribute, javascript: URLs. The write still succeeds; read \`warnings\` in the result.
Attributes: style class id data-* href src alt width height viewBox and the usual SVG ones.
Prefer inline styles on each element. Tags map to kinds: div/section/header/... → frame; h1-h6/p/span/a/button/li → text; img → image; svg → svg.

Example of a good fragment (hero with a Google Font and a token):
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap">
<section id="hero" style="display:flex;flex-direction:column;align-items:center;gap:24px;padding:96px 64px;background:var(--color-primary);color:#fff">
  <h1 style="font-family:'Fraunces',serif;font-size:56px;margin:0">Breads do Breno</h1>
  <p style="font-size:20px;max-width:560px;text-align:center;margin:0">Pão de fermentação natural, todo dia às 7h.</p>
  <a href="#cardapio" style="padding:14px 28px;border-radius:999px;background:#fff;color:var(--color-primary);font-weight:600">Ver cardápio</a>
</section>`,
  },
  {
    n: 5,
    title: 'Style, tokens and fonts',
    body: `- Inline styles, flex/grid, gap, px and % units. The root frame is width:100%;height:100% of the artboard; sections stack inside it.
- Tokens: design_tokens_set({ docId, tokens: { color: { primary: '#7a3e12' }, radius: { md: '12px' } } }) exposes var(--color-primary), var(--radius-md) to every artboard. When a token exists, reference it — never paste the hex again.
- Fonts: pass Google Fonts stylesheet URLs in design_tokens_set({ fonts: [...] }) or as a <link> inside design_write_html, then use font-family in styles. Only https://fonts.googleapis.com/ URLs load; anything else is ignored.
- Global CSS (design_tokens_set({ globalCss })) is for resets and keyframes, not for per-node styling — the inspector shows inline styles, not selectors.
- design_computed_styles returns what the browser actually resolved (final font-size, computed color) when a value comes from CSS variables or inheritance.`,
  },
  {
    n: 6,
    title: 'Assets',
    body: `design_asset_upload({ docId, name, mime, dataBase64 }) stores an image (png/jpeg/webp/gif/svg, ≤ 5 MB) and returns a URL like pitwall-design://asset/<id>. Use that URL in src. External http(s) image URLs do not load inside the artboard (CSP) — upload instead, or use an inline <svg>. Exports inline the bytes as data: URIs.`,
  },
  {
    n: 7,
    title: 'Self-correction by screenshot',
    body: `After editing an artboard call design_screenshot(artboardId) and check, in this order:
1. Overflow: content cut at the artboard edge, horizontal scrollbars, text wrapping into one word per line.
2. Hierarchy: one clear headline, secondary text visibly smaller, consistent spacing rhythm (8/16/24/32…).
3. Contrast: text over images or colored backgrounds must stay legible.
4. Alignment: things that should line up do; gaps are consistent.
5. Placeholders: no lorem ipsum, no empty boxes — write real copy for the brief.
Then fix with design_styles_update / design_text_set and screenshot again. Use scale 2 only when checking fine detail.`,
  },
  {
    n: 8,
    title: 'Prototype links',
    body: `design_link_set({ artboardId, nodeId, targetArtboardId, transition }) makes a node (usually an <a> or <button>) navigate to another artboard in Preview mode. transition: none | push | fade. Pass targetArtboardId null to remove. Links do not change the HTML export.`,
  },
  {
    n: 9,
    title: 'Common mistakes',
    body: `- Inventing node ids or artboard ids instead of reading them.
- Rewriting an artboard for a one-line change (kills the human's edits).
- Putting <style> blocks with selectors in fragments: they become document-global CSS and leak into other artboards.
- Forgetting design_nodes_finish — the UI keeps "Claude is editing" on.
- Lorem ipsum and "Image here" boxes: write real content, upload or draw real imagery.
- Making one artboard responsive with media queries: create a mobile artboard instead.
- Fixed pixel heights on text containers: let flex/gap size them so copy changes do not overflow.`,
  },
]

function renderSection(section: GuideSection): string {
  return `## §${section.n} ${section.title}\n\n${section.body}`
}

export const DESIGN_GUIDE = `# Design Studio — agent guide\n\n${DESIGN_GUIDE_SECTIONS.map(renderSection).join('\n\n')}\n`

export function guideSection(n: number): string | null {
  const section = DESIGN_GUIDE_SECTIONS.find((s) => s.n === n)
  return section ? renderSection(section) : null
}
