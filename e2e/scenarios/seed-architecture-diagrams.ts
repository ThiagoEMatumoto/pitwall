// Dogfood real: cria a ARQUITETURA DO PITWALL como diagramas, via MCP HTTP
// (mesmo caminho de uma sessão Claude). Serve de teste de conteúdo denso do
// auto-layout e de seeder reutilizável pós-merge.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../driver/launch'
import { screenshot } from '../driver/capture'
import { goToArea, waitReady } from '../driver/nav'

const log = (...a: unknown[]) => console.log('[arch]', ...a)

const { app, page, userDataCopy } = await launchApp()
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })

let rpcId = 0
let mcpUrl = ''
let headers: Record<string, string> = {}
async function callTool(name: string, args: Record<string, unknown>) {
  const res = await fetch(mcpUrl, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  })
  const text = await res.text()
  const jsonLine = text.includes('\ndata: ') || text.startsWith('event:')
    ? text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
    : text
  const parsed = JSON.parse(jsonLine)
  if (parsed.error) throw new Error(`${name}: ${JSON.stringify(parsed.error)}`)
  const content = parsed.result?.content?.[0]?.text
  if (parsed.result?.isError) throw new Error(`${name}: ${content}`)
  return content ? JSON.parse(content) : parsed.result
}

// ── D1: processos e camadas ─────────────────────────────────────────────
const ACCENT = '#9D8CFF'
const d1 = {
  title: 'Pitwall — processos e camadas',
  kind: 'architecture',
  summary: 'Visão geral: renderer, preload, main, SQLite, MCP e sessões',
  elements: [
    { id: 'areas', type: 'rectangle', label: { text: 'UI Areas (React)\nsrc/features/*' } },
    { id: 'stores', type: 'rectangle', label: { text: 'Zustand stores\nsrc/store/*' } },
    { id: 'libipc', type: 'rectangle', label: { text: 'src/lib/ipc.ts\n(re-export da bridge)' } },
    { id: 'preload', type: 'rectangle', strokeColor: ACCENT, label: { text: 'preload\ncontextBridge "api"' } },
    { id: 'handlers', type: 'rectangle', label: { text: 'ipcMain handlers\nelectron/main/ipc/*' } },
    { id: 'services', type: 'rectangle', label: { text: 'services (*-store)\nelectron/main/services' } },
    { id: 'db', type: 'rectangle', strokeColor: ACCENT, label: { text: 'SQLite app.db\nmigrations 001–038' } },
    { id: 'notify', type: 'rectangle', label: { text: 'notify.broadcast\n(canal espelhado)' } },
    { id: 'mcp', type: 'rectangle', strokeColor: ACCENT, label: { text: 'MCP server HTTP\n127.0.0.1 + bearer' } },
    { id: 'claude', type: 'ellipse', label: { text: 'Sessões Claude\n(MCP client)' } },
    { id: 'pty', type: 'rectangle', label: { text: 'node-pty\nterminais das sessões' } },
    { id: 'a1', type: 'arrow', start: { id: 'areas' }, end: { id: 'stores' }, label: { text: 'estado' } },
    { id: 'a2', type: 'arrow', start: { id: 'stores' }, end: { id: 'libipc' }, label: { text: 'invoke' } },
    { id: 'a3', type: 'arrow', start: { id: 'libipc' }, end: { id: 'preload' } },
    { id: 'a4', type: 'arrow', start: { id: 'preload' }, end: { id: 'handlers' }, label: { text: 'ipcRenderer.invoke' } },
    { id: 'a5', type: 'arrow', start: { id: 'handlers' }, end: { id: 'services' } },
    { id: 'a6', type: 'arrow', start: { id: 'services' }, end: { id: 'db' }, label: { text: 'better-sqlite3' } },
    { id: 'a7', type: 'arrow', start: { id: 'handlers' }, end: { id: 'notify' }, label: { text: 'pós-write' } },
    { id: 'a8', type: 'arrow', start: { id: 'notify' }, end: { id: 'preload' }, label: { text: 'subscribe' } },
    { id: 'a9', type: 'arrow', start: { id: 'claude' }, end: { id: 'mcp' }, label: { text: 'HTTP + token' } },
    { id: 'a10', type: 'arrow', start: { id: 'mcp' }, end: { id: 'services' }, label: { text: 'tools' } },
    { id: 'a11', type: 'arrow', start: { id: 'mcp' }, end: { id: 'notify' }, label: { text: 'espelha IPC' } },
    { id: 'a12', type: 'arrow', start: { id: 'handlers' }, end: { id: 'pty' }, label: { text: 'sessões' } },
  ],
}

// ── D2: fluxo write MCP → UI ao vivo ────────────────────────────────────
const d2 = {
  title: 'Fluxo: write MCP → UI ao vivo',
  kind: 'flow',
  summary: 'Caminho de um diagram_create até o editor atualizar com toast',
  elements: [
    { id: 'sess', type: 'ellipse', label: { text: 'Sessão Claude' } },
    { id: 'tool', type: 'rectangle', label: { text: 'diagram_create\n(mcp/tools.ts)' } },
    { id: 'zod', type: 'diamond', label: { text: 'zod parse ok?' } },
    { id: 'conv', type: 'rectangle', label: { text: 'skeletonToElements\n(shared/diagram-skeleton)' } },
    { id: 'store', type: 'rectangle', label: { text: 'diagram-store.create\n(transação)' } },
    { id: 'sqlite', type: 'rectangle', label: { text: 'SQLite\ndiagrams + versions' } },
    { id: 'bcast', type: 'rectangle', label: { text: "broadcast\n'diagram:updated'" } },
    { id: 'zstore', type: 'rectangle', label: { text: 'diagramsStore\nupsert + remoteScene' } },
    { id: 'editor', type: 'rectangle', label: { text: 'DiagramEditor\napplyRemote + enquadra' } },
    { id: 'toast', type: 'ellipse', strokeColor: '#2f9e44', label: { text: 'Toast\n"Atualizado pelo Claude"' } },
    { id: 'err', type: 'ellipse', strokeColor: '#e03131', label: { text: 'Erro de validação\npro agente' } },
    { id: 'f1', type: 'arrow', start: { id: 'sess' }, end: { id: 'tool' }, label: { text: 'skeleton JSON' } },
    { id: 'f2', type: 'arrow', start: { id: 'tool' }, end: { id: 'zod' } },
    { id: 'f3', type: 'arrow', start: { id: 'zod' }, end: { id: 'conv' }, label: { text: 'sim' } },
    { id: 'f4', type: 'arrow', start: { id: 'zod' }, end: { id: 'err' }, label: { text: 'não' } },
    { id: 'f5', type: 'arrow', start: { id: 'conv' }, end: { id: 'store' }, label: { text: 'elements' } },
    { id: 'f6', type: 'arrow', start: { id: 'store' }, end: { id: 'sqlite' } },
    { id: 'f7', type: 'arrow', start: { id: 'store' }, end: { id: 'bcast' } },
    { id: 'f8', type: 'arrow', start: { id: 'bcast' }, end: { id: 'zstore' }, label: { text: 'preload subscribe' } },
    { id: 'f9', type: 'arrow', start: { id: 'zstore' }, end: { id: 'editor' }, label: { text: 'remoteScene' } },
    { id: 'f10', type: 'arrow', start: { id: 'editor' }, end: { id: 'toast' }, label: { text: 'aplicou' } },
  ],
}

// ── D3: modelo de dados de diagramas ────────────────────────────────────
const d3 = {
  title: 'Diagramas — modelo de dados',
  kind: 'er',
  summary: 'Tabelas da migration 038 e vínculos polimórficos',
  elements: [
    { id: 'dg', type: 'rectangle', strokeColor: ACCENT, label: { text: 'diagrams\nid · title · kind · status\nscene JSON · version' } },
    { id: 'dv', type: 'rectangle', label: { text: 'diagram_versions\nappend-only · cap 30\nauthor · summary · scene' } },
    { id: 'dl', type: 'rectangle', label: { text: 'diagram_links\n(parent_type, parent_id)\nPK composta' } },
    { id: 'feat', type: 'rectangle', label: { text: 'features' } },
    { id: 'task', type: 'rectangle', label: { text: 'tasks' } },
    { id: 'proj', type: 'rectangle', label: { text: 'projects · repos\ndossiers · meetings …' } },
    { id: 'e1', type: 'arrow', start: { id: 'dv' }, end: { id: 'dg' }, label: { text: 'FK CASCADE' } },
    { id: 'e2', type: 'arrow', start: { id: 'dl' }, end: { id: 'dg' }, label: { text: 'FK CASCADE' } },
    { id: 'e3', type: 'arrow', start: { id: 'dl' }, end: { id: 'feat' }, label: { text: 'polimórfico' } },
    { id: 'e4', type: 'arrow', start: { id: 'dl' }, end: { id: 'task' }, label: { text: 'polimórfico' } },
    { id: 'e5', type: 'arrow', start: { id: 'dl' }, end: { id: 'proj' }, label: { text: 'polimórfico' } },
  ],
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
  await goToArea(page, 'diagrams')
  for (const [i, d] of [d1, d2, d3].entries()) {
    const created = await callTool('diagram_create', d)
    log(`create "${d.title}" →`, created.diagram?.id ?? created.id, '| skeleton:', created.skeleton?.length)
    await page.waitForTimeout(800)
    await page.getByText(d.title).first().click()
    await page.locator('.excalidraw canvas').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(2500)
    await screenshot(page, `arch-0${i + 1}`)
  }
  const listed = await callTool('diagram_list', {})
  log('list final:', JSON.stringify(listed.items?.map((x: any) => x.title)))
  log('console errors:', errors.length, JSON.stringify([...new Set(errors)].slice(0, 3)))
} finally { await app.close() }
