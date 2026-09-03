// Steps 1-4: the flow landing (document, tokens, artboards, HTML), the iframe
// and the persisted meta growing past 4000px, the tiled design_screenshot,
// the 4K artboard (capture 1x ok, export 4x refused) and the clamp warning.
import { screenshot } from '../../driver/capture'
import { waitForValue } from '../../driver/design'
import { FONTS, TOKENS } from '../design-breads-do-breno/brand'
import { MENU_HTML } from '../design-breads-do-breno/content-pages'
import { LANDING_HTML, LANDING_MIN_HEIGHT, LANDING_NODES, POSTER_4K_HTML } from './content'
import { fitAll, samplePng, shotViaTool, SHOT, type V2Ctx } from './ctx'

export const DOC_TITLE = 'Breads do Breno v2'
const ARTBOARD_MAX_PX = 16384
const MIN_TILED_PNG_BYTES = 100 * 1024

interface CreatedArtboard {
  artboard: {
    id: string
    width: number
    height: number
    sizing?: string
    rootId: string
  }
  warnings: string[]
}

interface DocGet {
  document: {
    pages: Array<{
      artboards: Array<{
        id: string
        name: string
        width: number
        height: number
        sizing?: string
      }>
    }>
  } | null
}

async function artboardMeta(ctx: V2Ctx, id: string) {
  const res = await ctx.mcp.call<DocGet>('design_document_get', {
    docId: ctx.docId,
    depth: 0,
  })
  return res.document?.pages.flatMap((p) => p.artboards).find((a) => a.id === id) ?? null
}

// Document + tokens + Landing (flow) + Cardápio (fixed) + HTML + the smart link.
export async function step1Build(ctx: V2Ctx): Promise<void> {
  const { mcp } = ctx
  const created = await mcp.call('design_document_create', {
    title: DOC_TITLE,
    fonts: FONTS,
  })
  ctx.docId = created.document.id
  await mcp.call('design_tokens_set', {
    docId: ctx.docId,
    tokens: TOKENS,
    fonts: FONTS,
  })

  const landing = await mcp.call<CreatedArtboard>('design_artboard_create', {
    docId: ctx.docId,
    name: 'Landing',
    width: 1440,
    sizing: 'flow',
    x: 0,
    y: 0,
  })
  ctx.ids.landing = landing.artboard.id
  ctx.check(
    '1 design_artboard_create sizing flow without height',
    landing.artboard.sizing === 'flow' && landing.warnings.length === 0,
    JSON.stringify(landing.artboard),
  )

  const menu = await mcp.call<CreatedArtboard>('design_artboard_create', {
    docId: ctx.docId,
    name: 'Cardápio',
    width: 1440,
    height: 900,
    x: 1600,
    y: 0,
    html: MENU_HTML,
  })
  ctx.ids.menu = menu.artboard.id
  ctx.check('1 Cardápio created with html', menu.warnings.length === 0, menu.warnings.join(' | '))

  const written = await mcp.call('design_write_html', {
    artboardId: ctx.ids.landing,
    html: LANDING_HTML,
    summary: 'Landing: primeira versão',
  })
  const warnings = (written.warnings ?? []) as string[]
  ctx.log(`write_html Landing → v${written.version}, ${written.nodeIds?.length} nodes`)
  ctx.check('1 write_html Landing without warnings', warnings.length === 0, warnings.join(' | '))

  const navId = await ctx.findId('landing', LANDING_NODES.navMenu)
  const link = await mcp.call('design_link_set', {
    artboardId: ctx.ids.landing,
    nodeId: navId,
    targetArtboardId: ctx.ids.menu,
    transition: 'smart',
    duration: 1000,
  })
  ctx.check('1 smart link Landing → Cardápio (1000ms)', typeof link.version === 'number')
}

// With the document open: the iframe grows with the content and the height
// the runtime measured reaches the store (coalesced persist) and the tools.
export async function step1Grow(ctx: V2Ctx): Promise<void> {
  const { page } = ctx
  const frameEl = page.locator(`[data-artboard="${ctx.ids.landing}"]`).first()
  const readHeight = () => frameEl.evaluate((el) => (el as HTMLElement).offsetHeight).catch(() => 0)
  const deadline = Date.now() + 15_000
  let height = await readHeight()
  while (height < LANDING_MIN_HEIGHT && Date.now() < deadline) {
    await page.waitForTimeout(300)
    height = await readHeight()
  }
  ctx.check(
    `1 flow iframe grew past ${LANDING_MIN_HEIGHT}px`,
    height >= LANDING_MIN_HEIGHT,
    `offsetHeight=${height}`,
  )

  const persisted = await waitForValue(
    async () => {
      const meta = await artboardMeta(ctx, ctx.ids.landing)
      return !!meta && meta.sizing === 'flow' && meta.height >= LANDING_MIN_HEIGHT
    },
    true,
    8000,
    300,
  )
  const meta = await artboardMeta(ctx, ctx.ids.landing)
  ctx.check('1 document_get shows sizing flow + measured height', persisted, JSON.stringify(meta))
  await fitAll(ctx)
  await screenshot(page, `${SHOT}-01-landing-fit`)
}

export async function step2TiledShot(ctx: V2Ctx): Promise<void> {
  const shot = await shotViaTool(ctx, 'landing', '02-tool-landing')
  ctx.check(
    '2 design_screenshot Landing composed from ≥ 2 tiles',
    (shot.meta.tiles ?? 0) >= 2 && shot.meta.sizing === 'flow',
    JSON.stringify(shot.meta),
  )
  ctx.check(
    `2 PNG > ${MIN_TILED_PNG_BYTES} bytes, height ≥ ${LANDING_MIN_HEIGHT}`,
    shot.png.length > MIN_TILED_PNG_BYTES && shot.meta.height >= LANDING_MIN_HEIGHT,
    `bytes=${shot.png.length} ${shot.meta.width}×${shot.meta.height} → ${shot.file}`,
  )
}

export async function step3Poster4k(ctx: V2Ctx): Promise<void> {
  const { mcp, page } = ctx
  const poster = await mcp.call<CreatedArtboard>('design_artboard_create', {
    docId: ctx.docId,
    name: '4K',
    width: 3840,
    height: 2160,
    sizing: 'fixed',
    x: 0,
    y: 6000,
    html: POSTER_4K_HTML,
  })
  ctx.ids.poster = poster.artboard.id
  ctx.check(
    '3 4K artboard created (3840×2160 fixed)',
    poster.artboard.width === 3840 && poster.artboard.height === 2160,
    JSON.stringify(poster.artboard),
  )
  await page.waitForTimeout(1500)

  const shot = await shotViaTool(ctx, 'poster', '03-tool-4k', { scale: 1 })
  ctx.check(
    '3 design_screenshot 4K at scale 1',
    shot.meta.width === 3840 && shot.meta.height === 2160 && shot.png.length > 0,
    `bytes=${shot.png.length} tiles=${shot.meta.tiles}`,
  )
  // The whole layout at 1x: the "Poster visual" box (x ≥ 2320) is a different
  // colour from the page background. A capture copied from the 2x surface
  // would show the top-left quarter only, all background there.
  const bg = await samplePng(ctx, shot.png, 100, 100)
  const visual = await samplePng(ctx, shot.png, 3200, 1080)
  ctx.check(
    '3 4K at 1x holds the whole layout (visual box differs from the background)',
    bg.join(',') !== visual.join(','),
    `bg=${bg.join(',')} visual=${visual.join(',')}`,
  )

  // 3840×2160 × 4² = 133 Mpx, above the 120 Mpx budget: refused before rendering.
  const viaApi = await page.evaluate(
    (id) =>
      (window as any).api.design
        .export({ artboardId: id, format: 'png', scale: 4 })
        .then(() => 'resolved')
        .catch((e: Error) => `rejected: ${e.message}`),
    ctx.ids.poster,
  )
  ctx.log(`export scale 4 via api → ${viaApi}`)
  let viaTool = 'resolved'
  try {
    await mcp.callRaw('design_export', {
      artboardId: ctx.ids.poster,
      format: 'png',
      scale: 4,
    })
  } catch (err) {
    viaTool = `rejected: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`
  }
  ctx.log(`export scale 4 via tool → ${viaTool}`)
  ctx.check(
    '3 export 4K at scale 4 refused with a message (api)',
    /^rejected: .*(Mpx|budget|scale)/i.test(viaApi),
    viaApi,
  )
  ctx.check('3 export 4K at scale 4 refused (tool)', viaTool.startsWith('rejected'), viaTool)
}

export async function step4Clamp(ctx: V2Ctx): Promise<void> {
  const { mcp, page } = ctx
  const wide = await mcp.call<CreatedArtboard>('design_artboard_create', {
    docId: ctx.docId,
    name: 'Clamp',
    width: 20000,
    height: 120,
    x: 0,
    y: 9000,
  })
  const warned = wide.warnings.some((w) => /16384/.test(w))
  ctx.check(
    `4 width 20000 → ${ARTBOARD_MAX_PX} with a warning`,
    wide.artboard.width === ARTBOARD_MAX_PX && warned,
    `width=${wide.artboard.width} warnings=${JSON.stringify(wide.warnings)}`,
  )
  await page.waitForTimeout(800)
  const toast = await page
    .getByText(/16384/)
    .first()
    .isVisible()
    .catch(() => false)
  ctx.log(`clamp toast visible in the UI: ${toast}`)
  // The 16384px frame has done its job; drop it so later shots stay readable.
  await page.evaluate((id) => (window as any).api.design.artboardDelete(id), wide.artboard.id)
  await page.waitForTimeout(500)
}
