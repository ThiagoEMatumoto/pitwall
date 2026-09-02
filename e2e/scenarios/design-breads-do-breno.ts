// Real use of the Design Studio: Claude (through the MCP HTTP tools, the same
// path a session uses) designs the Breads do Breno site — brand tokens, four
// artboards, prototype links — then self-corrects from design_screenshot and
// finishes each artboard. The second half plays the designer looking at the
// result in the app (canvas, preview, inspector, layers, Ask Claude, versions).
//
//   npm run rebuild:native && npm run build
//   DS_REAL_PAUSE=1 npx tsx e2e/scenarios/design-breads-do-breno.ts   # pause for ad-hoc rounds
//   npx tsx e2e/scenarios/design-breads-do-breno.ts                   # full run
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launchApp, REPO_ROOT } from '../driver/launch'
import { captureLogs, screenshot } from '../driver/capture'
import { goToArea, waitReady } from '../driver/nav'
import { connectMcp, type McpClient } from '../driver/mcp'
import { makeChecker } from '../driver/design'
import { FONTS, TOKENS } from './design-breads-do-breno/brand'
import { HOME_DESKTOP_HTML, HOME_MOBILE_HTML } from './design-breads-do-breno/content-home'
import { CONTACT_HTML, MENU_HTML } from './design-breads-do-breno/content-pages'
import { ROUNDS, type Fix } from './design-breads-do-breno/fixes'
import { CONTINUE_FILE, SESSION_FILE, type ArtboardKey } from './design-breads-do-breno/session'
import {
  stepAskClaude,
  stepCanvasOverview,
  stepHomeAt100,
  stepInspectorCard,
  stepLayersExpanded,
  stepPreviewFlow,
  stepVersions,
  type UserCtx,
} from './design-breads-do-breno/steps-user'

const SHOT = 'ds-real'
const SHOTS_DIR = join(REPO_ROOT, '.cm-drive', 'screenshots')
const PAUSE_TIMEOUT_MS = 45 * 60_000

interface ArtboardSpec {
  name: string
  width: number
  height: number
  x: number
  y: number
  html: string
}

const SPECS: Record<ArtboardKey, ArtboardSpec> = {
  home: {
    name: 'Home',
    width: 1440,
    height: 900,
    x: 0,
    y: 0,
    html: HOME_DESKTOP_HTML,
  },
  mobile: {
    name: 'Home mobile',
    width: 390,
    height: 844,
    x: 1520,
    y: 0,
    html: HOME_MOBILE_HTML,
  },
  menu: {
    name: 'Cardápio',
    width: 1440,
    height: 900,
    x: 0,
    y: 1000,
    html: MENU_HTML,
  },
  contact: {
    name: 'Contato',
    width: 1440,
    height: 900,
    x: 1520,
    y: 1000,
    html: CONTACT_HTML,
  },
}
const KEYS = Object.keys(SPECS) as ArtboardKey[]

// Prototype links: node data-name → target artboard.
const LINKS: Record<ArtboardKey, Array<[string, ArtboardKey]>> = {
  home: [
    ['Logo', 'home'],
    ['Nav Cardápio', 'menu'],
    ['Nav Contato', 'contact'],
    ['Nav CTA', 'contact'],
    ['CTA', 'menu'],
    ['CTA secundário', 'contact'],
  ],
  mobile: [
    ['Logo', 'mobile'],
    ['CTA', 'menu'],
  ],
  menu: [
    ['Logo', 'home'],
    ['Nav Cardápio', 'menu'],
    ['Nav Contato', 'contact'],
    ['Nav CTA', 'contact'],
    ['CTA encomenda', 'contact'],
  ],
  contact: [
    ['Logo', 'home'],
    ['Nav Cardápio', 'menu'],
    ['Nav Contato', 'contact'],
    ['Nav CTA', 'contact'],
  ],
}

interface NodeItem {
  id: string
  name?: string
  tag: string
  childCount: number
}

const { checks, log, check, step } = makeChecker('ds-real')
const { app, page, userDataCopy } = await launchApp()
const { logFile, stop } = captureLogs(app, page)
const consoleErrors: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`))

let mcp: McpClient
const ids = {} as Record<ArtboardKey, string>
let docId = ''

// BFS through design_children_get: ids always come from a read, never invented.
const nameCache = new Map<string, string>()
async function findId(key: ArtboardKey, name: string): Promise<string> {
  const cacheKey = `${key}:${name}`
  const hit = nameCache.get(cacheKey)
  if (hit) return hit
  const queue: Array<string | null> = [null]
  while (queue.length) {
    const parent = queue.shift() ?? null
    const res = await mcp.call<{ items: NodeItem[] }>('design_children_get', {
      artboardId: ids[key],
      nodeId: parent,
    })
    for (const it of res.items) {
      if (it.name === name) {
        nameCache.set(cacheKey, it.id)
        return it.id
      }
      if (it.childCount > 0) queue.push(it.id)
    }
  }
  throw new Error(`node "${name}" not found in ${SPECS[key].name}`)
}

async function shotArtboard(key: ArtboardKey, tag: string): Promise<string> {
  const raw = await mcp.callRaw('design_screenshot', { artboardId: ids[key] })
  const image = raw.content?.find((c) => c.type === 'image')
  const png = image?.data ? Buffer.from(image.data, 'base64') : Buffer.alloc(0)
  mkdirSync(SHOTS_DIR, { recursive: true })
  const file = join(SHOTS_DIR, `${SHOT}-shot-${key}-${tag}.png`)
  writeFileSync(file, png)
  log(`design_screenshot ${SPECS[key].name} (${tag}) → ${png.length} bytes ${file}`)
  return file
}

async function applyFixes(fixes: Fix[], round: number): Promise<void> {
  const byArtboard = new Map<ArtboardKey, Fix[]>()
  for (const f of fixes) byArtboard.set(f.artboard, [...(byArtboard.get(f.artboard) ?? []), f])
  for (const [key, list] of byArtboard) {
    const styleItems: Array<{
      id: string
      style: Record<string, string | null>
    }> = []
    for (const f of list) {
      const id = await findId(key, f.name)
      if (f.style) styleItems.push({ id, style: f.style })
      if (f.text !== undefined) {
        await mcp.call('design_text_set', {
          artboardId: ids[key],
          nodeId: id,
          text: f.text,
        })
      }
    }
    if (styleItems.length) {
      await mcp.call('design_styles_update', {
        artboardId: ids[key],
        items: styleItems,
        summary: `Auto-correção ${round}: ${SPECS[key].name}`,
      })
    }
    log(`round ${round}: ${list.length} fixes on ${SPECS[key].name}`)
  }
}

async function waitForContinue(): Promise<void> {
  log(`PAUSED — session in ${SESSION_FILE}; create ${CONTINUE_FILE} to go on`)
  const deadline = Date.now() + PAUSE_TIMEOUT_MS
  while (!existsSync(CONTINUE_FILE) && Date.now() < deadline) {
    await page.waitForTimeout(1000)
  }
  if (!existsSync(CONTINUE_FILE)) throw new Error('pause timed out')
}

try {
  await waitReady(page)
  await goToArea(page, 'design')
  await page.waitForTimeout(800)
  await screenshot(page, `${SHOT}-01-empty`)

  mcp = await connectMcp(userDataCopy)

  // 1. guide → document → tokens
  await step('1 guide + document + tokens', async () => {
    const guide = await mcp.call<{ guide: string }>('design_guide')
    check(
      '1a design_guide is markdown',
      guide.guide.includes('## §1'),
      `${guide.guide.length} chars`,
    )
    const created = await mcp.call('design_document_create', {
      title: 'Breads do Breno',
      fonts: FONTS,
    })
    docId = created.document.id
    const tokens = await mcp.call('design_tokens_set', {
      docId,
      tokens: TOKENS,
      fonts: FONTS,
    })
    check('1b document + tokens', !!docId && !!tokens, `doc=${docId}`)
  })

  // 2. artboards + html + links
  await step('2 artboards + html + links', async () => {
    for (const key of KEYS) {
      const s = SPECS[key]
      const ab = await mcp.call('design_artboard_create', {
        docId,
        name: s.name,
        width: s.width,
        height: s.height,
        x: s.x,
        y: s.y,
      })
      ids[key] = ab.artboard.id
    }
    for (const key of KEYS) {
      const written = await mcp.call('design_write_html', {
        artboardId: ids[key],
        html: SPECS[key].html,
        summary: `Primeira versão: ${SPECS[key].name}`,
      })
      const warnings = (written.warnings ?? []) as string[]
      log(`write_html ${SPECS[key].name} → v${written.version}, ${written.nodeIds?.length} nodes`)
      check(
        `2 write_html ${SPECS[key].name} without warnings`,
        warnings.length === 0,
        warnings.join(' | ').slice(0, 300),
      )
    }
    let links = 0
    for (const key of KEYS) {
      for (const [name, target] of LINKS[key]) {
        const nodeId = await findId(key, name)
        await mcp.call('design_link_set', {
          artboardId: ids[key],
          nodeId,
          targetArtboardId: ids[target],
          transition: key === 'mobile' ? 'push' : 'fade',
        })
        links++
      }
    }
    check('2 prototype links set', links === 17, `links=${links}`)
  })

  mkdirSync(dirname(SESSION_FILE), { recursive: true })
  writeFileSync(
    SESSION_FILE,
    JSON.stringify({ userDataCopy, mcpUrl: mcp.url, docId, artboards: ids }, null, 2),
  )

  // Open the document in the UI (created while nothing was open).
  const docRow = page.getByText('Breads do Breno').first()
  await page.waitForTimeout(1200)
  if (!(await docRow.isVisible().catch(() => false))) {
    log('UX: new doc not listed without navigation; re-entering the area')
    await goToArea(page, 'projects')
    await goToArea(page, 'design')
  }
  await docRow.waitFor({ state: 'visible', timeout: 10_000 })
  await docRow.click()
  await page.waitForTimeout(2500)
  await page.getByTitle('Ajustar à tela (Ctrl+0)').click()
  await page.waitForTimeout(1500)
  await screenshot(page, `${SHOT}-02-artboards`)

  // 3. self-correction rounds
  await step('3 self-correction', async () => {
    for (const key of KEYS) await shotArtboard(key, 'r0')
    for (let i = 0; i < ROUNDS.length; i++) {
      await applyFixes(ROUNDS[i], i + 1)
      await page.waitForTimeout(400)
      for (const key of KEYS) await shotArtboard(key, `r${i + 1}`)
    }
    check(
      '3 rounds applied',
      ROUNDS.every((r) => r.length > 0),
      ROUNDS.map((r) => r.length).join('/'),
    )
  })

  if (process.env.DS_REAL_PAUSE === '1') await waitForContinue()

  // 4. finish + versions
  await step('4 finish + versions', async () => {
    for (const key of KEYS) {
      const res = await mcp.call('design_nodes_finish', {
        artboardId: ids[key],
        summary: `${SPECS[key].name}: layout, copy e links revisados`,
      })
      log(`finish ${SPECS[key].name} → v${res.version} snapshotted=${res.snapshotted}`)
    }
    const versions = await page.evaluate(
      (id) => (window as any).api.design.versionsList(id),
      ids.home,
    )
    log('versions (Home) via IPC:', JSON.stringify(versions).slice(0, 600))
    check(
      '4 Home has ≥ 3 named versions',
      Array.isArray(versions) && versions.length >= 3,
      `count=${versions?.length}`,
    )
  })

  // 5. the designer looks at it
  const widths = Object.fromEntries(KEYS.map((k) => [k, SPECS[k].width])) as Record<
    ArtboardKey,
    number
  >
  const ctx: UserCtx = { page, mcp, docId, ids, widths, findId, check, log }
  await step('5a canvas overview', () => stepCanvasOverview(ctx))
  await step('5b home at 100%', () => stepHomeAt100(ctx))
  await step('5c preview flow', () => stepPreviewFlow(ctx))
  await step('5d inspector card', () => stepInspectorCard(ctx))
  await step('5e layers', () => stepLayersExpanded(ctx))
  await step('5f ask claude', () => stepAskClaude(ctx))
  await step('5g versions panel', async () => {
    const n = await stepVersions(ctx)
    check('5g versions panel lists rows', n >= 3, `rows=${n}`)
  })

  const unique = [...new Set(consoleErrors)]
  check(
    '0 console errors',
    unique.length === 0,
    `${unique.length}: ${JSON.stringify(unique.slice(0, 5))}`,
  )
} catch (err) {
  check('scenario', false, String(err).slice(0, 800))
} finally {
  stop()
  await app.close()
}

log('log file:', logFile)
const failed = checks.filter((c) => !c.ok)
log(`${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
