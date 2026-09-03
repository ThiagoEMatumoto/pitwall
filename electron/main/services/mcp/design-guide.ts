import { ARTBOARD_PRESETS } from '../../../../shared/types/design'

// What an agent reads before touching a design. Served whole or by section by
// design_guide; every design_* description points at a section number.

export interface GuideSection {
  n: number
  title: string
  body: string
}

const presetLines = ARTBOARD_PRESETS.map((p) =>
  p.sizing === 'flow'
    ? `- ${p.label}: ${p.width} × flow (height follows the content)`
    : `- ${p.label}: ${p.width}×${p.height}`,
).join('\n')

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
- An artboard is a canvas rendered in an isolated iframe. Its tree is real HTML: a root frame (div) with children.
- sizing "fixed": width × height in px, content past the bottom is clipped. sizing "flow": the width is fixed and the height follows the content — reads return it as measuredHeight (updated by the runtime and by design_screenshot). Max 16384 px per side; larger values are clamped and reported in warnings.
- Node = { id, tag, kind (frame|text|image|svg|element), style (inline CSS), attrs, text?, children, name? }.
- Ids are stable 10-char strings assigned on insert. Duplicating gives new ids; moving/styling keeps them.
- Every write bumps the artboard version. Versions with a summary are snapshots the human can roll back to; design_nodes_finish creates one.
- The human edits the same tree live. Read before you write when time has passed: their changes are in the tree, not in your memory.

Artboard sizes (use these unless asked otherwise):
${presetLines}
Mobile and desktop are separate artboards; @media is allowed but a dedicated mobile artboard is what the human reviews.

Landing pages and other long pages: create the artboard with sizing "flow" (Landing preset) and stack the sections in a flex column on the root — display:flex;flex-direction:column on the root, each <section> with its own padding. Never position:absolute the root or the sections; height comes from the content. A flow artboard taller than 4096 px is screenshotted in tiles (see the tiles count) — that is normal.`,
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
| animate a node (entrance, hover, loop, parallax) | design_motion_set (§10) |

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
    body: `- Inline styles, flex/grid, gap, px and % units. The root frame is width:100% of the artboard (height:100% when fixed, auto when flow); sections stack inside it.
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
Then fix with design_styles_update / design_text_set and screenshot again. Use scale 2 only when checking fine detail.
A flow artboard is captured whole; check measuredHeight in the result and the section rhythm along the page. With motion, the default capture is the final pose (every entrance done); pass motion "initial" to see where things start.`,
  },
  {
    n: 8,
    title: 'Prototype links',
    body: `design_link_set({ artboardId, nodeId, targetArtboardId, transition, duration?, easing? }) makes a node (usually an <a> or <button>) navigate to another artboard in Preview mode. transition: none | push | fade | smart. duration in ms and easing (§10) are optional. Pass targetArtboardId null to remove. Links do not change the HTML export.
"smart" morphs the nodes that exist in both artboards: pairing is by layer name (design_nodes_rename), so give the header, the logo, the hero image the same name on both sides and they glide into place; unnamed or unpaired nodes cross-fade.`,
  },
  {
    n: 9,
    title: 'Common mistakes',
    body: `- Inventing node ids or artboard ids instead of reading them.
- Rewriting an artboard for a one-line change (kills the human's edits).
- Putting <style> blocks with selectors in fragments: they become document-global CSS and leak into other artboards.
- Forgetting design_nodes_finish — the UI keeps "Claude is editing" on.
- Lorem ipsum and "Image here" boxes: write real content, upload or draw real imagery.
- Cramming a long landing page into a fixed 1440×900: use sizing "flow" (§2).
- Relying on @media alone for mobile: it works inside the iframe, but the human reviews a separate mobile artboard.
- Fixed pixel heights on text containers: let flex/gap size them so copy changes do not overflow.
- Hand-written animation/transition/@keyframes in inline styles when a preset does the job (§10).`,
  },
  {
    n: 10,
    title: 'Animation',
    body: `design_motion_set({ artboardId, items: [{ id, motion }] }) attaches presets to nodes; motion null clears. One node can combine the four sections:
- entrance: { preset: fade | slide-up | slide-down | slide-left | slide-right | scale | blur, trigger: load | in-view, duration (ms, default 220), delay, easing, distance (px, slides), stagger (ms) }
- hover: { preset: lift | scale | glow | color, duration (default 160), easing, intensity 0.1..3 }
- loop: { preset: pulse | marquee | float | spin, duration (ms per cycle, default 1800), direction: normal | reverse | alternate }
- parallax: { factor -1..1 } — the node drifts against the scroll by that fraction.
Easings: ease-out (default) | ease-in-out | linear | back | spring-gentle | spring-quick | spring-bouncy.

When to use what:
- Hero title/subtitle: entrance fade or slide-up on load, 300-500 ms, delay the subtitle 80-120 ms after the title.
- Sections below the fold: trigger "in-view" so they play when the reader scrolls to them.
- Lists and card grids: put ONE entrance with stagger (40-80 ms) on the container — each child then plays in turn. Do not set an entrance on every card.
- Buttons and cards: hover lift or scale; links: hover color.
- Badges, "new" pills, testimonial strips: loop pulse or marquee (marquee needs the container to be a row of items; it clones them for the seamless scroll).
- Background shapes and images: parallax with a small factor (0.1-0.3).
Keep it quiet: 2-4 animated elements per screen, durations under 600 ms except loops, and the same easing across a page.

Smart Animate between artboards: give the nodes that persist across the two screens the same layer name (design_nodes_rename), then design_link_set with transition "smart" (duration 300-500 ms). Named pairs morph; everything else cross-fades.

Never write animation, transition or @keyframes by hand (inline or in globalCss) when a preset covers it: presets are inspectable and editable by the human, keyframes in globalCss leak into every artboard. Check the result with design_screenshot: motion "initial" shows the pose before the entrances, the default "final" the settled page. design_tree_summary marks animated nodes with [motion …].`,
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
