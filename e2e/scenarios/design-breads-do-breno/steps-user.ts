// The human side of the Breads do Breno run: what the designer sees after
// Claude finished — canvas overview, Home at 100%, Preview navigation through
// the prototype links, inspector, layers, Ask Claude chips and the versions panel.
import type { Page } from 'playwright'
import type { McpClient } from '../../driver/mcp'
import { screenshot } from '../../driver/capture'
import {
  clickAt,
  nodeCenterOnScreen,
  pwSelector,
  waitForArtboardFrame,
  waitForValue,
} from '../../driver/design'
import type { ArtboardKey } from './session'

export interface UserCtx {
  page: Page
  mcp: McpClient
  docId: string
  ids: Record<ArtboardKey, string>
  widths: Record<ArtboardKey, number>
  findId: (key: ArtboardKey, name: string) => Promise<string>
  check: (name: string, ok: boolean, detail?: string) => boolean
  log: (...a: unknown[]) => void
}

const SHOT = 'ds-real'

async function selectedTag(ctx: UserCtx): Promise<string> {
  const sel = await ctx.mcp.call<{
    nodes?: Array<{ tag: string; name?: string }>
  }>('design_selection_get', { docId: ctx.docId })
  return sel.nodes?.[0] ? `${sel.nodes[0].tag}:${sel.nodes[0].name ?? ''}` : 'none'
}

// Clicks a node (by data-name) inside the edit frame of an artboard.
async function clickNode(
  ctx: UserCtx,
  key: ArtboardKey,
  name: string,
  opts: { ctrl?: boolean } = {},
): Promise<void> {
  const frame = await waitForArtboardFrame(ctx.page, ctx.ids[key])
  const id = await ctx.findId(key, name)
  const p = await nodeCenterOnScreen(
    ctx.page,
    frame,
    `[data-artboard="${ctx.ids[key]}"]`,
    ctx.widths[key],
    pwSelector(id),
  )
  await clickAt(ctx.page, p, opts)
  await ctx.page.waitForTimeout(400)
}

export async function stepCanvasOverview(ctx: UserCtx): Promise<void> {
  await ctx.page.getByTitle('Ajustar à tela (Ctrl+0)').click()
  await ctx.page.waitForTimeout(1200)
  await screenshot(ctx.page, `${SHOT}-10-canvas-fit`)
  const count = await ctx.page.locator('[data-artboard]').count()
  ctx.check('user: 4 artboards on the canvas', count === 4, `count=${count}`)
}

export async function stepHomeAt100(ctx: UserCtx): Promise<void> {
  await clickNode(ctx, 'home', 'Headline')
  // Frame the artboard through the composer's "Enquadrar artboard", then 100%
  // zooms around the stage center, which is now the artboard center.
  await ctx.page.getByTitle('Ask Claude (/)').click()
  await ctx.page.getByTitle('Enquadrar artboard').click()
  await ctx.page.keyboard.press('Escape')
  await ctx.page.waitForTimeout(300)
  await ctx.page.getByTitle('Zoom 100% (Ctrl+1)').click()
  await ctx.page.waitForTimeout(1000)
  await screenshot(ctx.page, `${SHOT}-11-home-100`)
  const zoomLabel = await ctx.page.getByTitle('Zoom 100% (Ctrl+1)').textContent()
  ctx.check('user: Home at 100%', zoomLabel?.trim() === '100%', `label=${zoomLabel}`)
}

export async function stepPreviewFlow(ctx: UserCtx): Promise<void> {
  const { page } = ctx
  await clickNode(ctx, 'home', 'Headline')
  await page.getByTestId('design-preview').click()
  const root = page.getByTestId('design-preview-root')
  await root.waitFor({ state: 'visible', timeout: 5000 })
  const select = page.getByTestId('design-preview-artboard-select')

  const go = async (from: ArtboardKey, fromTitle: string, nodeName: string, to: ArtboardKey) => {
    const frame = await waitForArtboardFrame(page, ctx.ids[from], {
      mode: 'preview',
    })
    await page.waitForTimeout(500)
    const id = await ctx.findId(from, nodeName)
    const p = await nodeCenterOnScreen(
      page,
      frame,
      `iframe[title="Preview: ${fromTitle}"]`,
      ctx.widths[from],
      pwSelector(id),
    )
    await clickAt(page, p)
    const current = await waitForValue(() => select.inputValue(), ctx.ids[to], 3000)
    await page.waitForTimeout(700)
    return current === ctx.ids[to]
  }

  await page.waitForTimeout(600)
  await screenshot(page, `${SHOT}-12-preview-home`)
  const toMenu = await go('home', 'Home', 'Nav Cardápio', 'menu')
  await screenshot(page, `${SHOT}-13-preview-cardapio`)
  const toContact = await go('menu', 'Cardápio', 'Nav Contato', 'contact')
  await screenshot(page, `${SHOT}-14-preview-contato`)
  const toHome = await go('contact', 'Contato', 'Logo', 'home')
  ctx.check(
    'user: preview Home → Cardápio → Contato → Home via links',
    toMenu && toContact && toHome,
    `menu=${toMenu} contact=${toContact} home=${toHome}`,
  )
  await page.getByTestId('design-preview-close').click()
  await root.waitFor({ state: 'hidden', timeout: 3000 })
}

export async function stepInspectorCard(ctx: UserCtx): Promise<void> {
  await clickNode(ctx, 'home', 'Destaque forno', { ctrl: true })
  const tag = await selectedTag(ctx)
  await ctx.page.waitForTimeout(400)
  await screenshot(ctx.page, `${SHOT}-15-inspector-card`)
  const inspector = ctx.page.locator('aside').last()
  const showsLayout = await inspector
    .getByText(/Layout|Preenchimento|Tipografia/)
    .first()
    .isVisible()
    .catch(() => false)
  ctx.check(
    'user: Ctrl+click selects the card, inspector shows sections',
    tag.startsWith('article') && showsLayout,
    `selected=${tag} sections=${showsLayout}`,
  )
}

export async function stepLayersExpanded(ctx: UserCtx): Promise<void> {
  const aside = ctx.page.locator('aside').first()
  const expand = async (label: string) => {
    const row = aside.locator(`span[title="${label}"]`).first().locator('xpath=..')
    await row.locator('button').first().click()
    await ctx.page.waitForTimeout(150)
  }
  await expand('Page')
  await expand('Highlights')
  await expand('Hero')
  await ctx.page.waitForTimeout(400)
  await screenshot(ctx.page, `${SHOT}-16-layers`)
  const rows = await aside.locator('span[title]').count()
  ctx.check('user: layers panel expanded', rows > 12, `rows=${rows}`)
}

export async function stepAskClaude(ctx: UserCtx): Promise<void> {
  await clickNode(ctx, 'home', 'Destaque forno', { ctrl: true })
  await ctx.page.keyboard.press('/')
  const textarea = ctx.page.locator('textarea').last()
  const opened = await textarea
    .waitFor({ state: 'visible', timeout: 2000 })
    .then(() => true)
    .catch(() => false)
  const chips = await ctx.page.locator('[title*="#"]').count()
  await ctx.page.waitForTimeout(300)
  await screenshot(ctx.page, `${SHOT}-17-ask-claude`)
  ctx.check(
    "user: '/' opens Ask Claude with a selection chip",
    opened && chips >= 1,
    `opened=${opened} chips=${chips}`,
  )
  await ctx.page.keyboard.press('Escape')
}

export async function stepVersions(ctx: UserCtx): Promise<number> {
  await clickNode(ctx, 'home', 'Headline')
  await ctx.page.getByTestId('design-versions-button').click()
  const rows = ctx.page.locator('[data-version]')
  await rows
    .first()
    .waitFor({ state: 'visible', timeout: 4000 })
    .catch(() => undefined)
  const count = await rows.count()
  await screenshot(ctx.page, `${SHOT}-18-versions`)
  await ctx.page.keyboard.press('Escape')
  return count
}
