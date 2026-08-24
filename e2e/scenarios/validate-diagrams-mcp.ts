// Exercita as MCP tools de diagramas DE VERDADE contra o servidor HTTP do app
// (mesmo caminho que uma sessão Claude usa), validando autoria por skeleton,
// releitura, patch preservando layout, link, archive e delete two-step.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../driver/launch'
import { screenshot } from '../driver/capture'
import { goToArea, waitReady } from '../driver/nav'

const log = (...a: unknown[]) => console.log('[mcp-e2e]', ...a)

const { app, page, userDataCopy } = await launchApp()
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })

let rpcId = 0
let mcpUrl = ''
let headers: Record<string, string> = {}

async function callTool(name: string, args: Record<string, unknown>) {
  const body = {
    jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
    params: { name, arguments: args },
  }
  const res = await fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  // StreamableHTTP pode responder SSE ("data: {...}") ou JSON puro.
  const jsonLine = text.startsWith('event:') || text.includes('\ndata: ')
    ? text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
    : text
  const parsed = JSON.parse(jsonLine)
  if (parsed.error) throw new Error(`${name}: rpc error ${JSON.stringify(parsed.error)}`)
  const content = parsed.result?.content?.[0]?.text
  const out = content ? JSON.parse(content) : parsed.result
  if (parsed.result?.isError) throw new Error(`${name}: tool error ${content}`)
  return out
}

try {
  await waitReady(page)
  const cfg = JSON.parse(readFileSync(join(userDataCopy, 'mcp.json'), 'utf8'))
  mcpUrl = cfg.url
  headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${cfg.token}`,
  }
  // initialize (stateless: cada request cria um server novo, mas o protocolo pede)
  const init = await fetch(mcpUrl, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } }),
  })
  log('initialize status:', init.status)

  // 1. create com skeleton SEM x/y (auto-layout) — fluxo realista de 8 nós
  const created = await callTool('diagram_create', {
    title: 'Pipeline de handoff',
    kind: 'flow',
    summary: 'Fluxo do handoff entre sessão mãe e filha',
    elements: [
      { id: 'user', type: 'ellipse', label: { text: 'Usuário' } },
      { id: 'mother', type: 'rectangle', label: { text: 'Sessão mãe' } },
      { id: 'tool', type: 'rectangle', label: { text: 'session_handoff' } },
      { id: 'gate', type: 'diamond', label: { text: 'Gate humano' } },
      { id: 'child', type: 'rectangle', label: { text: 'Sessão filha' } },
      { id: 'db', type: 'rectangle', label: { text: 'SQLite (handoffs)' } },
      { id: 'events', type: 'rectangle', label: { text: 'handoff_events' } },
      { id: 'report', type: 'rectangle', label: { text: 'Report final' } },
      { id: 'a1', type: 'arrow', start: { id: 'user' }, end: { id: 'mother' }, label: { text: 'pede tarefa' } },
      { id: 'a2', type: 'arrow', start: { id: 'mother' }, end: { id: 'tool' } },
      { id: 'a3', type: 'arrow', start: { id: 'tool' }, end: { id: 'gate' } },
      { id: 'a4', type: 'arrow', start: { id: 'gate' }, end: { id: 'child' }, label: { text: 'aprova' } },
      { id: 'a5', type: 'arrow', start: { id: 'tool' }, end: { id: 'db' }, label: { text: 'persiste' } },
      { id: 'a6', type: 'arrow', start: { id: 'child' }, end: { id: 'events' }, label: { text: 'progresso' } },
      { id: 'a7', type: 'arrow', start: { id: 'child' }, end: { id: 'report' } },
    ],
  })
  const dgId = created.diagram?.id ?? created.id
  log('create →', JSON.stringify({ id: dgId, elements: created.skeleton?.length }))

  await goToArea(page, 'diagrams')
  await page.getByText('Pipeline de handoff').first().click()
  await page.locator('.excalidraw').waitFor({ timeout: 20000 })
  await page.waitForTimeout(2500)
  await screenshot(page, 'mcp-01-created-autolayout')

  // 2. get skeleton — ergonomia de releitura
  const got = await callTool('diagram_get', { id: dgId })
  log('get skeleton (primeiros 3):', JSON.stringify(got.skeleton?.slice(0, 3)))
  log('get meta:', JSON.stringify({ version: got.diagram?.version ?? got.version, versions: got.versions?.length }))

  // 3. patch: renomeia label + muda cor + adiciona nó com seta — sem tocar no resto
  const patched = await callTool('diagram_patch', {
    id: dgId,
    summary: 'Destaca o gate e adiciona timeout',
    ops: [
      { op: 'update', id: 'gate', strokeColor: '#f5a623', label: { text: 'Gate humano (aprovação)' } },
      { op: 'add', element: { id: 'timeout', type: 'rectangle', label: { text: 'Timeout 10min' }, strokeColor: '#e05555' } },
      { op: 'add', element: { id: 'a8', type: 'arrow', start: { id: 'gate' }, end: { id: 'timeout' }, label: { text: 'sem resposta' } } },
    ],
  })
  log('patch → version', patched.diagram?.version ?? patched.version)
  await page.waitForTimeout(2000)
  await screenshot(page, 'mcp-02-patched-live')

  // 4. list + link a uma feature real (se existir)
  const listed = await callTool('diagram_list', {})
  log('list →', JSON.stringify(listed.items?.map((i: any) => ({ t: i.title, v: i.version }))))
  const { queryDb } = await import('../driver/inspect')
  const feats = await queryDb(userDataCopy, 'SELECT id, title FROM features LIMIT 1')
  if (feats.length) {
    const linked = await callTool('diagram_link', { id: dgId, parentType: 'feature', parentId: String(feats[0].id) })
    log('link → feature', feats[0].title, JSON.stringify(linked.links))
    await page.waitForTimeout(1200)
    await screenshot(page, 'mcp-03-linked')
  } else log('link: sem features na cópia, pulado')

  // 5. delete sem archive → deve ERRAR; archive → delete → some
  let guarded = false
  try { await callTool('diagram_delete', { id: dgId, confirm: true }) } catch (e) { guarded = true; log('delete guard ok:', String(e).slice(0, 120)) }
  if (!guarded) throw new Error('delete sem archive NÃO foi barrado!')
  await callTool('diagram_archive', { id: dgId })
  const delRes = await callTool('diagram_delete', { id: dgId, confirm: true })
  log('archive→delete →', JSON.stringify(delRes))
  const after = await callTool('diagram_list', { status: 'all' })
  log('list pós-delete:', after.items?.length)
  await page.waitForTimeout(1200)
  await screenshot(page, 'mcp-04-after-delete')

  log('console errors:', errors.length, JSON.stringify([...new Set(errors)].slice(0, 5)))
} finally {
  await app.close()
}
