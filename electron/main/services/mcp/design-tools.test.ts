/** @vitest-environment node */
// design_* tools against a real better-sqlite3 DB (tmp dir), electron mocked
// and notify spied — same strategy as tools.test.ts. The offscreen screenshot
// window needs Electron, so that module is mocked to fail like a headless run.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-design-tools-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

vi.mock('../design/screenshot', () => ({
  captureArtboard: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
  computeStyles: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
}))

import { app } from 'electron'
import { closeDb } from '../db'
import { designTools } from './design-tools'
import { type McpNotify, type ToolDef } from './tools'
import * as designStore from '../design/design-store'
import * as liveState from '../design/live-state'
import type { DesignAgentActivity, DesignNodeSummary } from '../../../../shared/types/design'

interface NotifySpy extends McpNotify {
  calls: Array<[string, unknown]>
}

function makeNotify(): NotifySpy {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    broadcast: (channel, payload) => calls.push([channel, payload]),
    affectedObjectives: () => {},
    affectedObjectivesForFeatureLinks: () => {},
  }
}

const notify = makeNotify()
const tools: ToolDef[] = designTools(notify, {
  motherSessionId: 'session-mother',
})

function tool(name: string): ToolDef {
  const def = tools.find((t) => t.name === name)
  if (!def) throw new Error(`tool not registered: ${name}`)
  return def
}

async function call<T>(name: string, args: unknown): Promise<T> {
  const result = await tool(name).handler(args)
  return result.structuredContent as T
}

function activities(toolName: string): DesignAgentActivity[] {
  return notify.calls
    .filter(([channel]) => channel === 'design:agent-activity')
    .map(([, payload]) => payload as DesignAgentActivity)
    .filter((a) => a.tool === toolName)
}

const HOME_HTML = `
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&display=swap">
<section id="hero" style="display:flex;flex-direction:column;align-items:center;gap:24px;padding:96px 64px;background:var(--color-primary);color:#fff">
  <h1 style="font-family:'Fraunces',serif;font-size:56px;margin:0">Breads do Breno</h1>
  <p style="font-size:20px;max-width:560px;text-align:center;margin:0">Pão de fermentação natural, todo dia às 7h.</p>
  <a href="#cardapio" style="padding:14px 28px;border-radius:999px;background:#fff;color:var(--color-primary)">Ver cardápio</a>
</section>
<section id="cardapio" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:64px">
  <div style="display:flex;flex-direction:column;gap:8px;padding:24px;border-radius:16px;background:#f6efe6">
    <h3 style="margin:0">Pão de fermentação natural</h3>
    <p style="margin:0">R$ 28</p>
  </div>
  <div style="display:flex;flex-direction:column;gap:8px;padding:24px;border-radius:16px;background:#f6efe6">
    <h3 style="margin:0">Focaccia de alecrim</h3>
    <p style="margin:0">R$ 22</p>
  </div>
</section>
<section id="sobre" style="display:flex;gap:48px;padding:64px">
  <p style="font-size:18px;line-height:1.6">O Breno acorda às 4h para a primeira fornada.</p>
</section>
<section id="contato" style="display:flex;justify-content:space-between;padding:48px 64px;background:#2b1d12;color:#fff">
  <span>Rua das Flores, 120</span>
  <a href="https://wa.me/5511999999999" style="color:#fff">WhatsApp</a>
</section>
`

interface ArtboardMeta {
  id: string
  name: string
  width: number
  height: number
  x: number
  version: number
  rootId: string
}

let docId: string
let home: ArtboardMeta
let cardapio: ArtboardMeta
let rootId: string
let heroId: string
let menuId: string
let sobreId: string
let firstCardId: string

beforeAll(() => {
  liveState.resetLiveState()
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('design tools — Breads do Breno', () => {
  it('registers the 24 tools from F10', () => {
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'design_document_list',
        'design_document_get',
        'design_selection_get',
        'design_node_get',
        'design_children_get',
        'design_tree_summary',
        'design_screenshot',
        'design_html_get',
        'design_computed_styles',
        'design_document_create',
        'design_artboard_create',
        'design_write_html',
        'design_text_set',
        'design_nodes_rename',
        'design_nodes_duplicate',
        'design_nodes_move',
        'design_styles_update',
        'design_nodes_delete',
        'design_tokens_set',
        'design_asset_upload',
        'design_link_set',
        'design_export',
        'design_guide',
        'design_nodes_finish',
      ].sort(),
    )
    for (const t of tools) {
      if (t.name !== 'design_guide') expect(t.description).toMatch(/design_guide §\d/)
    }
  })

  it('design_document_create + 4 artboards', async () => {
    const { document } = await call<{
      document: { id: string; pages: unknown[] }
    }>('design_document_create', { title: 'Breads do Breno' })
    docId = document.id
    expect(docId).toMatch(/^[0-9a-f-]{36}$/)
    expect(document.pages).toHaveLength(1)

    const created: ArtboardMeta[] = []
    for (const [name, width, height] of [
      ['Home', 1440, 900],
      ['Home mobile', 390, 844],
      ['Cardápio', 1440, 900],
      ['Contato', 1440, 900],
    ] as const) {
      const { artboard } = await call<{ artboard: ArtboardMeta }>('design_artboard_create', {
        docId,
        name,
        width,
        height,
      })
      created.push(artboard)
    }
    home = created[0]
    cardapio = created[2]
    rootId = home.rootId
    expect(created.map((a) => a.name)).toEqual(['Home', 'Home mobile', 'Cardápio', 'Contato'])
    // Auto-placed left→right with a gap.
    expect(created[1].x).toBeGreaterThan(created[0].x + created[0].width)
    expect(created[2].x).toBeGreaterThan(created[1].x + created[1].width)

    const list = await call<{ items: Array<{ id: string }> }>('design_document_list', {})
    expect(list.items.some((d) => d.id === docId)).toBe(true)
  })

  it('design_write_html fills Home with 4 sections and reports activity', async () => {
    const before = notify.calls.length
    const result = await call<{
      version: number
      nodeIds: string[]
      warnings: string[]
    }>('design_write_html', {
      artboardId: home.id,
      html: HOME_HTML,
      mode: 'replace',
      summary: 'first draft of Home',
    })
    expect(result.warnings).toEqual([])
    expect(result.nodeIds).toHaveLength(4)
    expect(result.version).toBe(home.version + 1)

    const children = await call<{ items: DesignNodeSummary[] }>('design_children_get', {
      artboardId: home.id,
      nodeId: null,
    })
    expect(children.items.filter((n) => n.tag === 'section')).toHaveLength(4)
    ;[heroId, menuId, sobreId] = children.items.map((n) => n.id)
    firstCardId = children.items[1].children![0].id

    const recent = notify.calls.slice(before)
    const phases = recent
      .filter(([c]) => c === 'design:agent-activity')
      .map(([, p]) => (p as DesignAgentActivity).phase)
    expect(phases).toEqual(['start', 'end'])
    const startActivity = activities('design_write_html')[0]
    expect(startActivity.sessionId).toBe('session-mother')
    expect(startActivity.docId).toBe(docId)
    const updated = recent.find(([c]) => c === 'design:artboard-updated')
    expect(updated).toBeDefined()
    expect((updated![1] as { full: boolean; origin: { kind: string } }).full).toBe(true)
    expect((updated![1] as { origin: { kind: string } }).origin.kind).toBe('claude')

    // The Google Font link moved to the document.
    const doc = designStore.getDocument(docId)!
    expect(doc.fonts).toHaveLength(1)
    expect(doc.fonts[0]).toContain('fonts.googleapis.com')
    expect(
      notify.calls.some(
        ([c, p]) => c === 'design:document-updated' && (p as { docId: string }).docId === docId,
      ),
    ).toBe(true)
  })

  it('design_write_html drops <script> with a warning', async () => {
    const result = await call<{ warnings: string[] }>('design_write_html', {
      artboardId: home.id,
      html: '<div style="padding:8px"><script>alert(1)</script><p onclick="x()">safe text</p></div>',
      mode: 'insert',
      summary: 'insert a box',
    })
    expect(result.warnings.join(' ')).toMatch(/script/i)
    const summary = await call<{ text: string }>('design_tree_summary', {
      artboardId: home.id,
      depth: 6,
    })
    expect(summary.text).not.toMatch(/script/)
    expect(summary.text).toContain('safe text')
  })

  it('design_styles_update patches only the hero', async () => {
    const before = designStore.getArtboard(home.id)!
    const sobreBefore = await call<{ node: unknown }>('design_node_get', {
      artboardId: home.id,
      nodeId: sobreId,
    })
    const result = await call<{ version: number }>('design_styles_update', {
      artboardId: home.id,
      items: [{ id: heroId, style: { background: '#7a3e12', color: null } }],
    })
    expect(result.version).toBe(before.version + 1)
    const hero = await call<{ node: { style: Record<string, string> } }>('design_node_get', {
      artboardId: home.id,
      nodeId: heroId,
    })
    expect(hero.node.style.background).toBe('#7a3e12')
    expect(hero.node.style.color).toBeUndefined()
    expect(hero.node.style.display).toBe('flex')
    const sobreAfter = await call<{ node: unknown }>('design_node_get', {
      artboardId: home.id,
      nodeId: sobreId,
    })
    expect(sobreAfter.node).toEqual(sobreBefore.node)
  })

  it('design_tree_summary lists ids', async () => {
    const summary = await call<{ text: string; version: number }>('design_tree_summary', {
      artboardId: home.id,
    })
    expect(summary.text).toContain(rootId)
    expect(summary.text).toContain(heroId)
    expect(summary.text).toContain('Breads do Breno')
  })

  it('duplicate → text_set → move → delete', async () => {
    const dup = await call<{
      idMap: Record<string, string>
      nodeIds: string[]
    }>('design_nodes_duplicate', { artboardId: home.id, ids: [firstCardId] })
    const copyId = dup.idMap[firstCardId]
    expect(copyId).toBeDefined()
    expect(copyId).not.toBe(firstCardId)
    expect(dup.nodeIds).toEqual([copyId])

    const menu = await call<{ items: DesignNodeSummary[] }>('design_children_get', {
      artboardId: home.id,
      nodeId: menuId,
    })
    expect(menu.items.map((n) => n.id).indexOf(copyId)).toBe(1)

    const copyTitleId = menu.items[1].children![0].id
    await call('design_text_set', {
      artboardId: home.id,
      nodeId: copyTitleId,
      text: 'Croissant',
    })
    const title = await call<{ node: { text: string } }>('design_node_get', {
      artboardId: home.id,
      nodeId: copyTitleId,
    })
    expect(title.node.text).toBe('Croissant')

    await call('design_nodes_move', {
      artboardId: home.id,
      ids: [copyId],
      parentId: menuId,
      index: 0,
    })
    const reordered = await call<{ items: DesignNodeSummary[] }>('design_children_get', {
      artboardId: home.id,
      nodeId: menuId,
    })
    expect(reordered.items[0].id).toBe(copyId)

    await call('design_nodes_rename', {
      artboardId: home.id,
      items: [{ id: copyId, name: 'Card Croissant' }],
    })

    await call('design_nodes_delete', { artboardId: home.id, ids: [copyId] })
    const afterDelete = await call<{ items: DesignNodeSummary[] }>('design_children_get', {
      artboardId: home.id,
      nodeId: menuId,
    })
    expect(afterDelete.items.some((n) => n.id === copyId)).toBe(false)
    await expect(call('design_node_get', { artboardId: home.id, nodeId: copyId })).rejects.toThrow(
      /not found/,
    )
  })

  it('design_tokens_set merges tokens and design_link_set sets a prototype link', async () => {
    await call('design_tokens_set', {
      docId,
      tokens: { color: { primary: '#7a3e12' } },
    })
    const merged = await call<{ tokens: { color: Record<string, string> } }>('design_tokens_set', {
      docId,
      tokens: { color: { accent: '#e0a458' } },
    })
    expect(merged.tokens.color).toEqual({
      primary: '#7a3e12',
      accent: '#e0a458',
    })

    const hero = await call<{ children: DesignNodeSummary[] }>('design_node_get', {
      artboardId: home.id,
      nodeId: heroId,
    })
    const ctaId = hero.children.find((c) => c.tag === 'a')!.id
    await call('design_link_set', {
      artboardId: home.id,
      nodeId: ctaId,
      targetArtboardId: cardapio.id,
      transition: 'push',
    })
    const cta = await call<{
      node: { link: { artboardId: string; transition: string } }
    }>('design_node_get', { artboardId: home.id, nodeId: ctaId })
    expect(cta.node.link).toEqual({
      artboardId: cardapio.id,
      transition: 'push',
    })
  })

  it('design_selection_get reads the live selection', async () => {
    liveState.setActiveDoc(docId)
    liveState.setSelection({ docId, artboardId: home.id, nodeIds: [heroId] })
    const selection = await call<{
      docId: string
      nodeIds: string[]
      nodes: DesignNodeSummary[]
    }>('design_selection_get', {})
    expect(selection.docId).toBe(docId)
    expect(selection.nodeIds).toEqual([heroId])
    expect(selection.nodes[0].tag).toBe('section')
  })

  it('design_export html is standalone: doctype, no ids, no script', async () => {
    const exported = await call<{ data: string; width: number }>('design_export', {
      artboardId: home.id,
      format: 'html',
    })
    expect(exported.data.toLowerCase()).toContain('<!doctype')
    expect(exported.data).not.toContain('data-pw-id')
    expect(exported.data).not.toMatch(/<script/i)
    expect(exported.data).toContain('--color-primary:#7a3e12')
    expect(exported.width).toBe(1440)

    const jsx = await call<{ data: string }>('design_export', {
      artboardId: home.id,
      format: 'jsx',
    })
    expect(jsx.data).toContain('export default function Home()')
    expect(jsx.data).toContain('style={{')

    const html = await call<{ code: string }>('design_html_get', {
      artboardId: home.id,
    })
    expect(html.code).toContain(`data-pw-id="${heroId}"`)
  })

  it('design_nodes_finish clears activity, snapshots and broadcasts finish', async () => {
    expect(liveState.listActivity(docId).length).toBeGreaterThan(0)
    const before = designStore.getArtboard(home.id)!
    const result = await call<{ version: number; snapshotted: boolean }>('design_nodes_finish', {
      artboardId: home.id,
      summary: 'Home first pass',
    })
    expect(result.snapshotted).toBe(true)
    expect(result.version).toBe(before.version + 1)
    expect(liveState.listActivity(docId)).toEqual([])
    const finish = activities('design_nodes_finish')
    expect(finish.at(-1)?.phase).toBe('finish')
    const versions = designStore.listVersions(home.id)
    expect(versions[0].version).toBe(result.version)
    expect(versions[0].summary).toBe('Home first pass')
    expect(versions[0].author).toBe('claude')

    // Second finish at the same head does not pile up versions.
    const again = await call<{ snapshotted: boolean }>('design_nodes_finish', {
      artboardId: home.id,
    })
    expect(again.snapshotted).toBe(false)
  })

  it('design_guide returns the whole guide or one section', async () => {
    const all = await call<{ guide: string }>('design_guide', {})
    for (let n = 1; n <= 9; n++) expect(all.guide).toContain(`## §${n} `)
    expect(all.guide).toContain('1440×900')
    const one = await call<{ guide: string }>('design_guide', { section: 4 })
    expect(one.guide).toContain('§4')
    expect(one.guide).not.toContain('§5')
  })

  it('design_screenshot fails with a friendly error without Electron', async () => {
    expect(tool('design_screenshot')).toBeDefined()
    await expect(call('design_screenshot', { artboardId: home.id })).rejects.toThrow(
      /design_screenshot unavailable/,
    )
  })
})
