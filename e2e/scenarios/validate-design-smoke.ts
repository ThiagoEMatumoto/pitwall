// First real run of the Design Studio: Claude (via MCP HTTP) creates a document
// with two artboards and writes a hero into one; the canvas must render the
// sandboxed iframes, apply live style patches without reloading, answer
// design_screenshot and let the user select a node with the mouse.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame } from 'playwright'
import { launchApp, REPO_ROOT } from '../driver/launch'
import { captureLogs, screenshot } from '../driver/capture'
import { goToArea, waitReady } from '../driver/nav'
import { connectMcp } from '../driver/mcp'

const log = (...a: unknown[]) => console.log('[design-smoke]', ...a)

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const FONT_URL =
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap'
const ARTBOARD_W = 1440
const ARTBOARD_H = 900

const HERO_HTML = `
<link href="${FONT_URL}" rel="stylesheet">
<section data-name="Hero" style="display:flex;flex-direction:column;min-height:900px;background-color:#fffaf3;color:#2b1d12;font-family:'Fraunces',Georgia,serif">
  <header data-name="Header" style="display:flex;align-items:center;justify-content:space-between;padding:28px 72px;border-bottom:1px solid #e6d5c0">
    <span data-name="Logo" style="font-size:22px;font-weight:600;letter-spacing:-0.01em">Breads do Breno</span>
    <nav data-name="Nav" style="display:flex;gap:32px;font-size:15px;font-family:Inter,system-ui,sans-serif">
      <a href="#" style="color:#2b1d12;text-decoration:none">Pães</a>
      <a href="#" style="color:#2b1d12;text-decoration:none">Cardápio</a>
      <a href="#" style="color:#2b1d12;text-decoration:none">Encomendas</a>
      <a href="#" style="color:#2b1d12;text-decoration:none">Sobre</a>
    </nav>
  </header>
  <div data-name="Hero body" style="display:flex;flex:1;align-items:center;justify-content:space-between;padding:0 72px;gap:64px">
    <div data-name="Copy" style="display:flex;flex-direction:column;gap:24px;max-width:640px">
      <h1 style="margin:0;font-size:84px;line-height:1;font-weight:600;letter-spacing:-0.02em">Breads do Breno</h1>
      <p style="margin:0;font-size:20px;line-height:1.5;font-family:Inter,system-ui,sans-serif;color:#5a4633">Fermentação natural de 36 horas, forno a lenha e farinha moída na pedra. Pão de verdade, saído do forno todo dia às 7h.</p>
      <a data-name="CTA" href="#" style="display:inline-flex;align-items:center;justify-content:center;align-self:flex-start;padding:16px 28px;border-radius:999px;background-color:#b4561f;color:#fff;font-family:Inter,system-ui,sans-serif;font-size:16px;font-weight:600;text-decoration:none">Ver o cardápio de hoje</a>
    </div>
    <div data-name="Visual" style="width:520px;height:520px;border-radius:32px;background:radial-gradient(circle at 30% 30%,#e9b978,#8a4a1c 70%)"></div>
  </div>
</section>`

const { app, page, userDataCopy } = await launchApp()
const { logFile, stop } = captureLogs(app, page)
const consoleErrors: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`))

function findArtboardFrame(artboardId: string): Frame | undefined {
  const prefix = `pitwall-design://artboard/${encodeURIComponent(artboardId)}`
  return page.frames().find((f) => f.url().startsWith(prefix))
}

async function waitForArtboardFrame(artboardId: string, timeoutMs = 10_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // Fallback for when frames() lost track: resolve through the iframe element.
    const frame =
      findArtboardFrame(artboardId) ??
      (await page
        .locator(`[data-artboard="${artboardId}"]`)
        .elementHandle()
        .then((el) => el?.contentFrame())
        .catch(() => null))
    if (frame) {
      const nodes = await frame
        .locator('[data-pw-id]')
        .count()
        .catch(() => 0)
      if (nodes > 0) return frame
    }
    await page.waitForTimeout(200)
  }
  const urls = page.frames().map((f) => f.url())
  throw new Error(`artboard frame ${artboardId} not found; frames: ${JSON.stringify(urls)}`)
}

try {
  await waitReady(page)
  await goToArea(page, 'design')
  await page.waitForTimeout(800)
  await screenshot(page, 'ds-smoke-01-empty')

  const mcp = await connectMcp(userDataCopy)
  log('mcp url', mcp.url)

  const guide = await mcp.call<{ guide?: string }>('design_guide')
  const guideText = typeof guide === 'string' ? guide : (guide.guide ?? '')
  log(
    'design_guide →',
    guideText.length,
    'chars, starts with',
    JSON.stringify(guideText.slice(0, 40)),
  )
  if (!guideText.includes('#')) throw new Error('design_guide did not return markdown')

  const created = await mcp.call('design_document_create', {
    title: 'Breads do Breno',
    fonts: [FONT_URL],
  })
  const docId: string = created.document.id
  log('document →', docId)

  const home = await mcp.call('design_artboard_create', {
    docId,
    name: 'Home',
    width: ARTBOARD_W,
    height: ARTBOARD_H,
  })
  const menu = await mcp.call('design_artboard_create', {
    docId,
    name: 'Cardápio',
    width: ARTBOARD_W,
    height: ARTBOARD_H,
  })
  const homeId: string = home.artboard.id
  log('artboards →', homeId, menu.artboard.id)

  const written = await mcp.call('design_write_html', {
    artboardId: homeId,
    html: HERO_HTML,
    summary: 'Hero da padaria',
  })
  log(
    'write_html → version',
    written.version,
    'nodes',
    written.nodeIds?.length,
    'warnings',
    JSON.stringify(written.warnings),
  )

  // The docs list is loaded on mount; check whether a doc created by Claude
  // while nothing is open shows up on its own.
  const docRow = page.getByText('Breads do Breno').first()
  await page.waitForTimeout(1500)
  const appeared = await docRow.isVisible().catch(() => false)
  log('UX: new doc visible in DocsPanel without navigation?', appeared)
  if (!appeared) {
    await goToArea(page, 'projects')
    await goToArea(page, 'design')
  }
  await docRow.waitFor({ state: 'visible', timeout: 10_000 })
  await docRow.click()
  await page.getByTitle('Ajustar à tela (Ctrl+0)').click()
  await page.waitForTimeout(2000)
  await screenshot(page, 'ds-smoke-02-artboards')

  // (b) two artboards on the stage
  const artboardCount = await page.locator('[data-artboard]').count()
  check('(b) two [data-artboard] iframes', artboardCount === 2, `count=${artboardCount}`)

  // (c) the Home iframe rendered the tree
  let frame: Frame | undefined
  try {
    frame = await waitForArtboardFrame(homeId)
    const nodeCount = await frame.locator('[data-pw-id]').count()
    const h1Text =
      (await frame
        .locator('h1')
        .first()
        .textContent()
        .catch(() => '')) ?? ''
    check(
      '(c) Home iframe loaded runtime + tree',
      nodeCount > 5 && h1Text.includes('Breads do Breno'),
      `nodes=${nodeCount} h1=${JSON.stringify(h1Text)} url=${frame.url()}`,
    )
  } catch (err) {
    check('(c) Home iframe loaded runtime + tree', false, String(err).slice(0, 1500))
  }

  // (d) design_screenshot returns a real PNG
  try {
    const raw = await mcp.callRaw('design_screenshot', { artboardId: homeId })
    const image = raw.content?.find((c) => c.type === 'image')
    const png = image?.data ? Buffer.from(image.data, 'base64') : Buffer.alloc(0)
    const dir = join(REPO_ROOT, '.cm-drive', 'screenshots')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'ds-smoke-03-tool-screenshot.png')
    writeFileSync(file, png)
    const isPng = png.subarray(1, 4).toString() === 'PNG'
    check(
      '(d) design_screenshot png > 10KB',
      isPng && png.length > 10 * 1024,
      `${png.length} bytes → ${file}`,
    )
  } catch (err) {
    check('(d) design_screenshot png > 10KB', false, String(err).slice(0, 1500))
  }

  // (e) live style patch reaches the iframe without a reload
  try {
    const children = await mcp.call('design_children_get', {
      artboardId: homeId,
      nodeId: null,
    })
    const hero = (children.items as Array<{ id: string; name?: string; tag?: string }>).find(
      (i) => i.name === 'Hero' || i.tag === 'section',
    )
    if (!hero) throw new Error(`hero not found in ${JSON.stringify(children.items).slice(0, 300)}`)
    const before = await waitForArtboardFrame(homeId)
    await before.evaluate(() => {
      ;(window as unknown as { __PW_SMOKE: number }).__PW_SMOKE = 1
    })
    await mcp.call('design_styles_update', {
      artboardId: homeId,
      items: [{ id: hero.id, style: { 'background-color': '#f4e9d8' } }],
      summary: 'Hero bg',
    })
    const readBg = (id: string) =>
      before.evaluate((nodeId) => {
        const el = document.querySelector(`[data-pw-id="${CSS.escape(nodeId)}"]`)
        return el ? getComputedStyle(el).backgroundColor : 'missing'
      }, id)
    const deadline = Date.now() + 1000
    let bg = await readBg(hero.id)
    while (bg !== 'rgb(244, 233, 216)' && Date.now() < deadline) {
      await page.waitForTimeout(50)
      bg = await readBg(hero.id)
    }
    const marker = await before.evaluate(
      () => (window as unknown as { __PW_SMOKE?: number }).__PW_SMOKE,
    )
    const sameFrame = findArtboardFrame(homeId) === before
    check(
      '(e) styles_update applied live, no iframe reload',
      bg === 'rgb(244, 233, 216)' && marker === 1 && sameFrame,
      `bg=${bg} marker=${marker} sameFrame=${sameFrame}`,
    )
  } catch (err) {
    check('(e) styles_update applied live, no iframe reload', false, String(err).slice(0, 1500))
  }

  // (f) mouse click on the h1 selects it and the inspector shows typography
  try {
    const f = await waitForArtboardFrame(homeId)
    const box = await page.locator(`[data-artboard="${homeId}"]`).boundingBox()
    if (!box) throw new Error('artboard iframe has no bounding box')
    const h1 = await f.evaluate(() => {
      const r = document.querySelector('h1')!.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    const zoom = box.width / ARTBOARD_W
    const cx = box.x + (h1.x + h1.w / 2) * zoom
    const cy = box.y + (h1.y + h1.h / 2) * zoom
    log('click h1 at', Math.round(cx), Math.round(cy), 'zoom', zoom.toFixed(3))
    await page.mouse.move(cx, cy)
    await page.waitForTimeout(150)
    // Plain click selects the direct child of the scope (the Hero section);
    // Ctrl+click takes the deepest node under the pointer (the h1).
    await page.mouse.click(cx, cy)
    await page.waitForTimeout(500)
    const plain = await mcp.call('design_selection_get', { docId })
    const plainTag = plain.nodes?.[0]?.tag
    log('plain click → selected', plainTag, plain.nodeIds)
    await page.keyboard.down('Control')
    await page.mouse.click(cx, cy)
    await page.keyboard.up('Control')
    await page.waitForTimeout(600)
    const deep = await mcp.call('design_selection_get', { docId })
    const deepTag = deep.nodes?.[0]?.tag
    const typo = await page
      .getByText('Tipografia')
      .first()
      .isVisible()
      .catch(() => false)
    await screenshot(page, 'ds-smoke-04-selected')
    check(
      '(f) click selects Hero, Ctrl+click selects h1 → inspector shows Tipografia',
      plainTag === 'section' && deepTag === 'h1' && typo,
      `plain=${plainTag} deep=${deepTag} typographyVisible=${typo}`,
    )
  } catch (err) {
    check('(f) click on h1 → inspector shows Tipografia', false, String(err).slice(0, 1500))
  }

  // (a) console errors collected during the whole run
  const unique = [...new Set(consoleErrors)]
  check(
    '(a) no renderer console errors',
    unique.length === 0,
    `${unique.length}: ${JSON.stringify(unique.slice(0, 5))}`,
  )
} catch (err) {
  check('scenario', false, String(err).slice(0, 500))
} finally {
  stop()
  await app.close()
}

log('log file:', logFile)
const failed = checks.filter((c) => !c.ok)
log(`${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
