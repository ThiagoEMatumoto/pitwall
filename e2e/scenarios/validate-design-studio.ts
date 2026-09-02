// Deterministic E2E of the Design Studio ("Breads do Breno"): Claude builds
// the document over MCP HTTP, the user edits it on the canvas, an agent edits
// it live, and the DB is checked after the app closes. Every step prints
// PASS/FAIL; exit 1 if any failed. Steps live in ./design-studio/*.
// Run (after `npm run rebuild:native && npm run build`):
//   npx tsx e2e/scenarios/validate-design-studio.ts
import { launchApp } from '../driver/launch'
import { captureLogs } from '../driver/capture'
import { newCtx } from './design-studio/ctx'
import {
  step1DesignArea,
  step2McpBuild,
  step3Canvas,
  step4ReadTools,
  step12Versions,
  step13Export,
  step14Db,
} from './design-studio/steps-build'
import {
  step5SelectInspector,
  step6UndoRedo,
  step7Drag,
  step8Layers,
  step9RectTool,
  step10Preview,
  step11AgentLive,
} from './design-studio/steps-canvas'

const { app, page, userDataCopy } = await launchApp()
const { logFile, stop } = captureLogs(app, page)
const ctx = newCtx(page, userDataCopy)
const { checks, log, check, step } = ctx.checker

page.on('console', (m) => {
  if (m.type() === 'error') ctx.consoleErrors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => ctx.consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`))
page.on('requestfailed', (r) =>
  ctx.failedRequests.push(`${r.failure()?.errorText ?? '?'} ${r.url()}`),
)

const LIVE_STEPS: Array<[string, (c: typeof ctx) => Promise<void>]> = [
  ['1 design area', step1DesignArea],
  ['2 mcp build', step2McpBuild],
  ['3 canvas', step3Canvas],
  ['4 read tools', step4ReadTools],
  ['5 select + inspector', step5SelectInspector],
  ['6 undo/redo', step6UndoRedo],
  ['7 drag', step7Drag],
  ['8 layers', step8Layers],
  ['9 rect tool', step9RectTool],
  ['10 preview', step10Preview],
  ['11 agent live', step11AgentLive],
  ['12 versions', step12Versions],
  ['13 export', step13Export],
]

try {
  for (const [name, fn] of LIVE_STEPS) {
    await step(name, () => fn(ctx))
    // Nothing downstream makes sense without the document.
    if (name === '2 mcp build' && !ctx.ids.doc) break
  }
  const unique = [...new Set(ctx.consoleErrors)]
  check(
    '(final) no renderer console errors during the run',
    unique.length === 0,
    `${unique.length}: ${JSON.stringify(unique.slice(0, 5))}`,
  )
} catch (err) {
  check('scenario', false, String(err).slice(0, 800))
} finally {
  stop()
  await app.close()
}

await step('14 db', () => step14Db(ctx))

log('log file:', logFile)
const failed = checks.filter((c) => !c.ok)
log(`${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
