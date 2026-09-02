// Steps 1-4 (Claude builds the document, canvas renders it, read tools) and
// 12-14 (versions, export, DB) of the Design Studio E2E.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../driver/launch'
import { screenshot } from '../../driver/capture'
import { goToArea, waitReady } from '../../driver/nav'
import { connectMcp } from '../../driver/mcp'
import { queryDb } from '../../driver/inspect'
import { waitForArtboardFrame } from '../../driver/design'
import { SHOT, byName, findNode, type Ctx } from './ctx'
import {
  BREADS_FONTS,
  BREADS_TOKENS,
  CONTACT_HTML,
  HOME_HTML,
  HOME_MOBILE_HTML,
  MENU_HTML,
  ROOT_STYLE,
} from './content'

export async function step1DesignArea(ctx: Ctx): Promise<void> {
  const { page, checker } = ctx
  await waitReady(page)
  await goToArea(page, 'design')
  await page.waitForTimeout(800)
  await screenshot(page, `${SHOT}-01-empty`)
  const aside = await page.locator('aside').first().isVisible()
  checker.check(
    '1 design area opens without console errors',
    aside && ctx.consoleErrors.length === 0,
    `errors=${JSON.stringify(ctx.consoleErrors)}`,
  )
}

export async function step2McpBuild(ctx: Ctx): Promise<void> {
  const { ids, checker } = ctx
  ctx.mcp = await connectMcp(ctx.userDataCopy)
  const mcp = ctx.mcp
  const guide = await mcp.call<{ guide?: string }>('design_guide')
  const guideText = typeof guide === 'string' ? guide : (guide.guide ?? '')
  const created = await mcp.call('design_document_create', {
    title: 'Breads do Breno',
  })
  ids.doc = created.document.id
  await mcp.call('design_tokens_set', {
    docId: ids.doc,
    tokens: BREADS_TOKENS,
    fonts: BREADS_FONTS,
  })
  const mk = async (name: string, width: number, height: number): Promise<string> =>
    (
      await mcp.call('design_artboard_create', {
        docId: ids.doc,
        name,
        width,
        height,
      })
    ).artboard.id
  ids.home = await mk('Home', 1440, 900)
  ids.mobile = await mk('Home mobile', 390, 844)
  ids.menu = await mk('Cardápio', 1440, 900)
  ids.contact = await mk('Contato', 1440, 900)
  const pages: Array<[string, string, string]> = [
    [ids.home, HOME_HTML, 'Home'],
    [ids.mobile, HOME_MOBILE_HTML, 'Home mobile'],
    [ids.menu, MENU_HTML, 'Cardápio'],
    [ids.contact, CONTACT_HTML, 'Contato'],
  ]
  const writes: Array<{ nodeIds?: string[]; warnings?: string[] }> = []
  for (const [artboardId, html, summary] of pages) {
    writes.push(await mcp.call('design_write_html', { artboardId, html, summary }))
    // The artboard root carries the page background/typography (no wrapper).
    const root = await mcp.call<{ parentId: string }>('design_children_get', { artboardId })
    await mcp.call('design_styles_update', {
      artboardId,
      items: [{ id: root.parentId, style: ROOT_STYLE }],
      summary: 'Root style',
    })
  }
  const warnings = writes.flatMap((w) => w.warnings ?? [])
  const cta = await findNode(ctx, ids.home, byName('CTA'))
  const navMenu = await findNode(ctx, ids.home, byName('Nav Cardápio'))
  for (const nodeId of [cta.id, navMenu.id]) {
    await mcp.call('design_link_set', {
      artboardId: ids.home,
      nodeId,
      targetArtboardId: ids.menu,
      transition: 'push',
    })
  }
  const nodes = writes.map((w) => w.nodeIds?.length ?? 0)
  checker.check(
    '2 guide + doc + tokens + 4 artboards + html + links',
    guideText.includes('#') && Object.values(ids).every(Boolean) && nodes.every((n) => n >= 3),
    `nodes=${nodes.join('/')} warnings=${JSON.stringify(warnings)}`,
  )
}

export async function step3Canvas(ctx: Ctx): Promise<void> {
  const { page, ids, checker } = ctx
  const docRow = page.getByText('Breads do Breno').first()
  await page.waitForTimeout(1500)
  if (!(await docRow.isVisible().catch(() => false))) {
    checker.log('UX: new doc not listed without navigation; re-entering the area')
    await goToArea(page, 'projects')
    await goToArea(page, 'design')
  }
  await docRow.waitFor({ state: 'visible', timeout: 10_000 })
  await docRow.click()
  await page.getByTitle('Ajustar à tela (Ctrl+0)').click()
  await page.waitForTimeout(2500)
  await screenshot(page, `${SHOT}-02-canvas-4-artboards`)
  const artboards = await page.locator('[data-artboard]').count()
  const counts: number[] = []
  for (const id of [ids.home, ids.mobile, ids.menu, ids.contact]) {
    const f = await waitForArtboardFrame(page, id)
    counts.push(await f.locator('[data-pw-id]').count())
  }
  const clean = ctx.consoleErrors.length === 0 && ctx.failedRequests.length === 0
  checker.check(
    '3 four artboards rendered, >10 nodes each, no errors/requestfailed',
    artboards === 4 && counts.every((c) => c > 10) && clean,
    `artboards=${artboards} nodes=${counts.join('/')} errors=${JSON.stringify(ctx.consoleErrors)} failed=${JSON.stringify(ctx.failedRequests.slice(0, 3))}`,
  )
}

export async function step4ReadTools(ctx: Ctx): Promise<void> {
  const { mcp, ids, checker } = ctx
  const dir = join(REPO_ROOT, '.cm-drive', 'screenshots')
  mkdirSync(dir, { recursive: true })
  const sizes: string[] = []
  let allPng = true
  const shots: Array<[string, string]> = [
    ['home', ids.home],
    ['home-mobile', ids.mobile],
    ['cardapio', ids.menu],
    ['contato', ids.contact],
  ]
  for (const [name, id] of shots) {
    const raw = await mcp.callRaw('design_screenshot', { artboardId: id })
    const image = raw.content?.find((c) => c.type === 'image')
    const png = image?.data ? Buffer.from(image.data, 'base64') : Buffer.alloc(0)
    writeFileSync(join(dir, `${SHOT}-03-shot-${name}.png`), png)
    allPng &&= png.subarray(1, 4).toString() === 'PNG' && png.length > 10 * 1024
    sizes.push(`${name}=${png.length}`)
  }
  const hero = await findNode(ctx, ids.home, byName('Hero'))
  const summary = await mcp.call<{ text: string }>('design_tree_summary', {
    artboardId: ids.home,
  })
  const jsx = await mcp.call<{ code: string }>('design_html_get', {
    artboardId: ids.home,
    format: 'jsx',
  })
  const hasHero = summary.text.includes(hero.id)
  const hasJsx = jsx.code.includes('style={{')
  checker.check(
    '4 design_screenshot ×4 >10KB, tree_summary has ids, html_get jsx',
    allPng && hasHero && hasJsx,
    `${sizes.join(' ')} summaryHasHero=${hasHero} jsx=${hasJsx}`,
  )
}

export async function step12Versions(ctx: Ctx): Promise<void> {
  const { page, checker } = ctx
  await page.getByTestId('design-versions-button').click()
  const rows = page.locator('[data-version]')
  await rows.first().waitFor({ state: 'visible', timeout: 3000 })
  const n = await rows.count()
  await screenshot(page, `${SHOT}-08-versions`)
  // Scoped to the dialog: the frameless titlebar has its own "Fechar".
  await page.locator('div.fixed', { has: rows.first() }).getByLabel('Fechar').click()
  await rows.first().waitFor({ state: 'hidden', timeout: 2000 })
  checker.check('12 history lists ≥ 2 versions', n >= 2, `versions=${n}`)
}

export async function step13Export(ctx: Ctx): Promise<void> {
  const res = await ctx.mcp.call<{ data: string }>('design_export', {
    artboardId: ctx.ids.home,
    format: 'html',
  })
  const html = res.data ?? ''
  ctx.checker.check(
    '13 design_export html is a standalone document without data-pw-id',
    html.toLowerCase().startsWith('<!doctype') &&
      !html.includes('data-pw-id') &&
      html.includes('Breads do Breno'),
    `len=${html.length} head=${JSON.stringify(html.slice(0, 30))}`,
  )
}

// After app.close(): the WAL is checkpointed, so sql.js sees everything.
export async function step14Db(ctx: Ctx): Promise<void> {
  const { ids, userDataCopy, checker } = ctx
  const q = async (sql: string): Promise<number> =>
    Number((await queryDb<{ n: number }>(userDataCopy, sql))[0]?.n ?? 0)
  const docs = await q(`SELECT COUNT(*) AS n FROM design_documents WHERE id = '${ids.doc}'`)
  const artboards = await q(
    `SELECT COUNT(*) AS n FROM design_artboards a JOIN design_pages p ON p.id = a.page_id WHERE p.document_id = '${ids.doc}'`,
  )
  const versions = await q(
    `SELECT COUNT(*) AS n FROM design_versions v JOIN design_artboards a ON a.id = v.artboard_id JOIN design_pages p ON p.id = a.page_id WHERE p.document_id = '${ids.doc}'`,
  )
  checker.check(
    '14 DB: 1 document, 4 artboards, ≥ 4 versions',
    docs === 1 && artboards === 4 && versions >= 4,
    `docs=${docs} artboards=${artboards} versions=${versions}`,
  )
}
