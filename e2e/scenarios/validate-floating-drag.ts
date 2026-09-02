import { execFileSync } from 'node:child_process'
import { captureLogs, screenshot } from '../driver/capture'
import { launchApp } from '../driver/launch'
import { waitReady } from '../driver/nav'

// Repro: a flutuante de gravação não pode ser movida pelo usuário (relato v0.67.0).
// Mede bounds antes/depois de: drag CDP (Playwright), drag XTest (ponteiro real,
// XDRAG=/path/xdrag), setPosition do main; e dumpa o que o mutter permite via xprop.
const XDRAG = process.env.XDRAG

type WinInfo = {
  bounds: { x: number; y: number; width: number; height: number }
  xid: string
  movable: boolean
  resizable: boolean
  scale: number
  title: string
}

async function main() {
  const { app, page } = await launchApp()
  const { logFile, stop } = captureLogs(app, page)
  try {
    await waitReady(page)
    const opened = app.waitForEvent('window', { timeout: 15000 })
    await page.evaluate(() => (window as any).api.meetings.floating('show'))
    const floating = await opened
    await floating.waitForLoadState('domcontentloaded')
    await floating.locator('header').waitFor({ timeout: 10000 })
    await floating.waitForTimeout(800)
    console.log('floating url:', floating.url())

    const info = (): Promise<WinInfo> =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.webContents.getURL().includes('floating.html'),
        )!
        const buf = w.getNativeWindowHandle()
        return {
          bounds: w.getBounds(),
          xid: '0x' + buf.readUInt32LE(0).toString(16),
          movable: w.isMovable(),
          resizable: w.isResizable(),
          scale: screen.getPrimaryDisplay().scaleFactor,
          title: w.getTitle(),
        }
      })

    const initial = await info()
    console.log('window info:', JSON.stringify(initial))

    const dom = await floating.evaluate(() => {
      const header = document.querySelector('header')!
      const r = header.getBoundingClientRect()
      const cx = r.left + 40
      const cy = r.top + r.height / 2
      const top = document.elementFromPoint(cx, cy)!
      const chain: string[] = []
      let el: Element | null = top
      while (el) {
        const cs = getComputedStyle(el) as any
        chain.push(
          `${el.tagName.toLowerCase()}[region=${cs.webkitAppRegion || cs['-webkit-app-region'] || 'none'},pe=${cs.pointerEvents}]`,
        )
        el = el.parentElement
      }
      return {
        headerRegion: (getComputedStyle(header) as any).webkitAppRegion,
        headerRect: { x: r.left, y: r.top, w: r.width, h: r.height },
        probe: { cx, cy },
        chainFromPoint: chain.join(' < '),
      }
    })
    console.log('dom:', JSON.stringify(dom))

    try {
      const props = execFileSync('xprop', [
        '-id', initial.xid,
        '_NET_WM_WINDOW_TYPE', '_NET_WM_ALLOWED_ACTIONS', '_NET_WM_STATE', '_MOTIF_WM_HINTS', 'WM_NAME',
      ]).toString()
      console.log('xprop:\n' + props)
    } catch (err) {
      console.log('xprop falhou:', String(err))
    }

    // 1) drag sintético via CDP (Playwright)
    const hx = dom.probe.cx
    const hy = dom.probe.cy
    await floating.mouse.move(hx, hy)
    await floating.mouse.down()
    for (let i = 1; i <= 10; i++) await floating.mouse.move(hx + i * 12, hy + i * 8)
    await floating.mouse.up()
    await floating.waitForTimeout(500)
    const afterCdp = (await info()).bounds
    console.log('bounds antes:', JSON.stringify(initial.bounds), 'após drag CDP:', JSON.stringify(afterCdp))

    // 2) drag REAL via XTest (ponteiro do X server) no header
    if (XDRAG) {
      const s = initial.scale
      const sx = Math.round((afterCdp.x + hx) * s)
      const sy = Math.round((afterCdp.y + hy) * s)
      try {
        const out = execFileSync(XDRAG, [initial.xid, `${sx}`, `${sy}`, `${sx + 120}`, `${sy + 80}`]).toString()
        console.log('xdrag header:', out.trim())
      } catch (err: any) {
        console.log('xdrag header falhou:', err.stdout?.toString(), err.stderr?.toString())
      }
      await floating.waitForTimeout(600)
      const afterX = (await info()).bounds
      console.log('após drag XTest (header):', JSON.stringify(afterX), 'delta=', afterX.x - afterCdp.x, afterX.y - afterCdp.y)

      // 3) resize REAL via XTest na borda inferior-direita
      const rx = Math.round((afterX.x + afterX.width - 2) * s)
      const ry = Math.round((afterX.y + afterX.height - 2) * s)
      try {
        const out = execFileSync(XDRAG, [initial.xid, `${rx}`, `${ry}`, `${rx + 60}`, `${ry + 60}`]).toString()
        console.log('xdrag corner:', out.trim())
      } catch (err: any) {
        console.log('xdrag corner falhou:', err.stdout?.toString(), err.stderr?.toString())
      }
      await floating.waitForTimeout(600)
      const afterResize = (await info()).bounds
      console.log('após resize XTest:', JSON.stringify(afterResize), 'delta=', afterResize.width - afterX.width, afterResize.height - afterX.height)
    }

    // 4) setPosition pelo main (o WM honra moves do cliente?)
    const before = (await info()).bounds
    await app.evaluate(({ BrowserWindow }, b) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('floating.html'))!
      w.setPosition(b.x + 150, b.y + 100)
    }, before)
    await floating.waitForTimeout(600)
    const afterSet = (await info()).bounds
    console.log('setPosition +150,+100 →', JSON.stringify(afterSet), 'delta=', afterSet.x - before.x, afterSet.y - before.y)

    await screenshot(floating, 'floating-drag')
    console.log('log:', logFile)
  } finally {
    stop()
    await app.close()
  }
}

main().catch((err) => {
  console.error('FALHA:', err)
  process.exit(1)
})
