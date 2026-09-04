/** @vitest-environment node */
// design_* tools against a real better-sqlite3 DB (tmp dir), electron mocked
// and notify spied — same strategy as tools.test.ts. The offscreen screenshot
// window needs Electron, so that module is mocked to fail like a headless run.
//
// Scenario 1 — the authoring flow: create, write html, patch, reorder, tokens,
// links, finish. Limits and sanitising live in design-tools-safety.test.ts.
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
import * as designStore from '../design/design-store'
import * as liveState from '../design/live-state'
import type { DesignAgentActivity, DesignNodeSummary } from '../../../../shared/types/design'
import { HOME_HTML, makeHarness, type ArtboardMeta } from './design-tools-test-support'

const { notify, tools, call, activities } = makeHarness()

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

describe('design tools — Breads do Breno authoring flow', () => {
  it('registers the 25 tools (24 from F10 + design_motion_set)', () => {
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
        'design_motion_set',
        'design_export',
        'design_pdf_export',
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

  it('design_styles_update with a summary records a named version', async () => {
    const before = designStore.listVersions(home.id).length
    const silent = await call<{ version: number }>('design_styles_update', {
      artboardId: home.id,
      items: [{ id: heroId, style: { padding: '8px' } }],
    })
    expect(designStore.listVersions(home.id).length).toBe(before)
    const named = await call<{ version: number }>('design_styles_update', {
      artboardId: home.id,
      items: [{ id: heroId, style: { padding: '16px' } }],
      summary: 'Hero spacing pass',
    })
    expect(named.version).toBe(silent.version + 1)
    const versions = designStore.listVersions(home.id)
    expect(versions.length).toBe(before + 1)
    expect(versions[0]).toMatchObject({ version: named.version, summary: 'Hero spacing pass' })
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
    for (let n = 1; n <= 10; n++) expect(all.guide).toContain(`## §${n} `)
    expect(all.guide).toContain('1440×900')
    const one = await call<{ guide: string }>('design_guide', { section: 4 })
    expect(one.guide).toContain('§4')
    expect(one.guide).not.toContain('§5')
  })
})
