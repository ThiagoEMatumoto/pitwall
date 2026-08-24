// Validação combinada: bibliotecas Excalidraw (install por JSON e por URL real
// do catálogo) + UX de sync (chip de estado, botão Salvar, toast com Abrir).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../driver/launch'
import { screenshot, captureLogs } from '../driver/capture'
import { goToArea, waitReady } from '../driver/nav'

const log = (...a: unknown[]) => console.log('[libsync]', ...a)
const { app, page, userDataCopy } = await launchApp()
const { stop } = captureLogs(app, page)
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })

let rpcId = 0; let mcpUrl = ''; let headers: Record<string, string> = {}
async function callTool(name: string, args: Record<string, unknown>) {
  const res = await fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) })
  const text = await res.text()
  const jsonLine = text.includes('\ndata: ') ? text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('') : text
  const parsed = JSON.parse(jsonLine)
  if (parsed.error) throw new Error(`${name}: ${JSON.stringify(parsed.error)}`)
  const content = parsed.result?.content?.[0]?.text
  if (parsed.result?.isError) throw new Error(`${name}: ${content}`)
  return content ? JSON.parse(content) : parsed.result
}

const fixtureLib = {
  type: 'excalidrawlib', version: 2, source: 'e2e',
  libraryItems: [
    { id: 'lib-card', status: 'unpublished', created: 1700000000000, name: 'Card', elements: [{ id: 'c1', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, angle: 0, strokeColor: '#9D8CFF', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0', roundness: { type: 3 }, seed: 3, version: 1, versionNonce: 3, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false }] },
    { id: 'lib-dec', status: 'unpublished', created: 1700000000001, name: 'Decisão', elements: [{ id: 'd1', type: 'diamond', x: 0, y: 0, width: 100, height: 80, angle: 0, strokeColor: '#f5a623', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a1', roundness: null, seed: 4, version: 1, versionNonce: 4, isDeleted: false, boundElements: [], updated: 1, link: null, locked: false }] },
  ],
}

try {
  await waitReady(page)
  // O mcp.json copiado ainda aponta pro app REAL até o servidor da cópia
  // reescrevê-lo (corrida) — esperar o pid bater com o Electron lançado
  // evita mandar writes pro banco de verdade.
  const appPid = app.process().pid
  let cfg: { url: string; token: string; pid?: number } | null = null
  for (let i = 0; i < 60; i++) {
    try {
      const c = JSON.parse(readFileSync(join(userDataCopy, 'mcp.json'), 'utf8'))
      if (c.pid === appPid) { cfg = c; break }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!cfg) throw new Error(`mcp.json nunca apontou pro app lançado (pid ${appPid}) — abortando pra não tocar o app real`)
  mcpUrl = cfg.url
  headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${cfg.token}` }

  // ── bibliotecas ──
  const inst1 = await callTool('diagram_library_install', { library_json: fixtureLib })
  log('install json →', JSON.stringify(inst1.items?.map((i: any) => i.name) ?? inst1))
  let urlOk = false
  try {
    const inst2 = await callTool('diagram_library_install', { url: 'https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/BjoernKW/UML-ER-library.excalidrawlib' })
    urlOk = true
    log('install URL real →', inst2.items?.length, 'itens no total')
  } catch (e) { log('install URL real FALHOU:', String(e).slice(0, 160)) }
  const listed = await callTool('diagram_library_list', {})
  log('library_list →', listed.items?.length, 'itens:', JSON.stringify(listed.items?.slice(0, 4).map((i: any) => i.name)))

  // criar diagrama e abrir
  const d1 = await callTool('diagram_create', { title: 'Sync UX test', kind: 'flow', summary: 'seed', elements: [ { id: 'n1', type: 'rectangle', label: { text: 'Início' } }, { id: 'n2', type: 'rectangle', label: { text: 'Fim' } }, { id: 'a1', type: 'arrow', start: { id: 'n1' }, end: { id: 'n2' } } ] })
  await goToArea(page, 'diagrams')
  await page.getByText('Sync UX test').first().click()
  await page.locator('.excalidraw canvas').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(2000)

  // painel Library do excalidraw
  await page.locator('.excalidraw').getByRole('button', { name: /library/i }).first().click().catch(async () => {
    await page.locator('.excalidraw .library-button, .excalidraw [title*="Library" i]').first().click()
  })
  await page.waitForTimeout(1500)
  await screenshot(page, 'ls-01-library-panel')
  const panelText = await page.locator('.excalidraw').innerText()
  log('painel mostra itens da fixture?', /Card|Decis/.test(panelText) || 'texto não achado (itens são thumbnails — ver screenshot)')

  // ── chip de estado + salvar manual ──
  const mainText = async () => await page.getByRole('main').innerText()
  log('chip inicial:', JSON.stringify((await mainText()).match(/Salvo · v\d+|Salvando…|Não salvo/)?.[0]))
  await page.locator('.excalidraw').click({ position: { x: 300, y: 300 } })
  await page.keyboard.press('Control+a')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)  // antes do debounce de 800ms
  log('chip pós-edição:', JSON.stringify((await mainText()).match(/Salvo · v\d+|Salvando…|Não salvo/)?.[0]))
  await screenshot(page, 'ls-02-dirty')
  await page.getByRole('main').getByTitle(/Salvar/).click()
  await page.waitForTimeout(1200)
  log('chip pós-salvar:', JSON.stringify((await mainText()).match(/Salvo · v\d+|Salvando…|Não salvo/)?.[0]))

  // ── update remoto com diagrama aberto: chip accent ──
  await callTool('diagram_patch', { id: d1.diagram?.id ?? d1.id, summary: 'remoto', ops: [{ op: 'update', id: 'n2', label: { text: 'Fim (v2)' } }] })
  await page.waitForTimeout(1500)
  log('chip pós-remoto:', JSON.stringify((await mainText()).match(/Atualizado pelo Claude · v\d+|Salvo · v\d+/)?.[0]))
  await screenshot(page, 'ls-03-remote-chip')

  // ── toast global para diagrama NÃO aberto ──
  const d2 = await callTool('diagram_create', { title: 'Outro fluxo', kind: 'flow', summary: 'seed', elements: [{ id: 'x1', type: 'rectangle', label: { text: 'Nó' } }] })
  await page.waitForTimeout(500)
  await callTool('diagram_patch', { id: d2.diagram?.id ?? d2.id, summary: 'patch em outro', ops: [{ op: 'add', element: { id: 'x2', type: 'ellipse', label: { text: 'Novo' } } }] })
  await page.waitForTimeout(1500)
  const bodyText = await page.locator('body').innerText()
  log('toast "Claude atualizou Outro fluxo"?', /atualizou.*Outro fluxo/i.test(bodyText))
  await screenshot(page, 'ls-04-toast-other')
  const abrir = page.getByRole('button', { name: 'Abrir', exact: true }).first()
  if (await abrir.count()) {
    await abrir.click()
    await page.waitForTimeout(1500)
    const title = await page.getByRole('main').innerText()
    log('Abrir navegou pro "Outro fluxo"?', /Outro fluxo/.test(title))
    await screenshot(page, 'ls-05-opened-via-toast')
  } else log('botão Abrir não encontrado')

  log('URL real funcionou?', urlOk, '| console errors:', errors.length, JSON.stringify([...new Set(errors)].slice(0, 3)))
} finally { stop(); await app.close() }
