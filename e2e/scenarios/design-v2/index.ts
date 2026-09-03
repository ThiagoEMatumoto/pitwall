// Design Studio v2 in the built app against a copy of the real data: the
// long Breads do Breno landing as a 1440 × flow artboard (iframe and meta
// growing past 4000px, tiled design_screenshot), a 4K artboard (1x capture,
// 4x export refused), the clamp warning, motion presets through
// design_motion_set + inspector + Interagir + preview (in-view on scroll,
// smart transition Landing → Cardápio), and the standalone export.
//
//   npm run rebuild:native && npm run build
//   npx tsx e2e/scenarios/design-v2/index.ts
import { execFileSync } from 'node:child_process'
import { launchApp, REPO_ROOT } from '../../driver/launch'
import { captureLogs } from '../../driver/capture'
import { goToArea, waitReady } from '../../driver/nav'
import { connectMcp } from '../../driver/mcp'
import { makeChecker } from '../../driver/design'
import { makeFindId, SHOT, type V2Ctx, type V2Key } from './ctx'
import {
  DOC_TITLE,
  step1Build,
  step1Grow,
  step2TiledShot,
  step3Poster4k,
  step4Clamp,
} from './steps-sizes'
import { step10Export, step5MotionSet, step6InitialVsFinal } from './steps-motion'
import { step7Inspector, step8Interact, step9Preview } from './steps-ui'

// The v1 scenarios this one sits next to: they must stay byte-for-byte as committed.
const V1_SCENARIOS = [
  'e2e/scenarios/validate-design-smoke.ts',
  'e2e/scenarios/validate-design-studio.ts',
  'e2e/scenarios/design-studio',
  'e2e/scenarios/validate-design-final.ts',
  'e2e/scenarios/validate-design-final',
  'e2e/scenarios/design-breads-do-breno.ts',
  'e2e/scenarios/design-breads-do-breno',
]

const { checks, log, check, step } = makeChecker(SHOT)
const { app, page, userDataCopy } = await launchApp()
const { logFile, stop } = captureLogs(app, page)
const consoleErrors: string[] = []
const failedRequests: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`))
page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText ?? '?'} ${r.url()}`))

try {
  await waitReady(page)
  await goToArea(page, 'design')
  await page.waitForTimeout(800)
  const mcp = await connectMcp(userDataCopy)

  const ids = {} as Record<V2Key, string>
  const widths: Record<V2Key, number> = {
    landing: 1440,
    menu: 1440,
    poster: 3840,
  }
  const ctx: V2Ctx = {
    page,
    mcp,
    docId: '',
    ids,
    widths,
    check,
    log,
    findId: makeFindId(mcp, ids),
  }

  await step('1 build (doc, tokens, flow landing, cardápio, link)', () => step1Build(ctx))

  // Open the document created while nothing was open.
  const docRow = page.getByText(DOC_TITLE).first()
  await page.waitForTimeout(1200)
  if (!(await docRow.isVisible().catch(() => false))) {
    log('UX: new doc not listed without navigation; re-entering the area')
    await goToArea(page, 'projects')
    await goToArea(page, 'design')
  }
  await docRow.waitFor({ state: 'visible', timeout: 10_000 })
  await docRow.click()
  await page.waitForTimeout(2500)

  await step('1 flow grows', () => step1Grow(ctx))
  await step('2 tiled screenshot', () => step2TiledShot(ctx))
  await step('3 4K', () => step3Poster4k(ctx))
  await step('4 clamp', () => step4Clamp(ctx))
  await step('5 motion set', () => step5MotionSet(ctx))
  await step('6 initial vs final', () => step6InitialVsFinal(ctx))
  await step('7 inspector', () => step7Inspector(ctx))
  await step('8 interact', () => step8Interact(ctx))
  await step('9 preview', () => step9Preview(ctx))
  await step('10 export', () => step10Export(ctx))

  await step('11 v1 scenarios untouched', async () => {
    let dirty = ''
    try {
      dirty = execFileSync('git', ['status', '--porcelain', '--', ...V1_SCENARIOS], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim()
    } catch (err) {
      dirty = `git failed: ${String(err).slice(0, 200)}`
    }
    check('11 the 4 v1 design scenarios are untouched', dirty === '', dirty)
  })

  const unique = [...new Set(consoleErrors)]
  check(
    '12 0 console errors',
    unique.length === 0,
    `${unique.length}: ${JSON.stringify(unique.slice(0, 5))}`,
  )
  check(
    '12 0 requestfailed',
    failedRequests.length === 0,
    `${failedRequests.length}: ${JSON.stringify(failedRequests.slice(0, 5))}`,
  )
} catch (err) {
  check(
    'scenario',
    false,
    String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 1200),
  )
} finally {
  stop()
  await app.close()
}

log('log file:', logFile)
const failed = checks.filter((c) => !c.ok)
log(`${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
