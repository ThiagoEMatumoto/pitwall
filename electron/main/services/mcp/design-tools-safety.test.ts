/** @vitest-environment node */
// Scenario 2 — limits, sanitising, live selection, export and the headless
// screenshot failure. Same DB/electron strategy as design-tools.test.ts; the
// document is seeded once in beforeAll instead of built step by step.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-design-tools-safety-test-'))
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
import * as liveState from '../design/live-state'
import type { DesignNodeSummary } from '../../../../shared/types/design'
import { HOME_HTML, makeHarness, mutateApply, type ArtboardMeta } from './design-tools-test-support'

const { tool, call } = makeHarness()

let docId: string
let home: ArtboardMeta
let heroId: string

beforeAll(async () => {
  liveState.resetLiveState()
  const { document } = await call<{ document: { id: string } }>('design_document_create', {
    title: 'Breads do Breno',
  })
  docId = document.id
  home = (
    await call<{ artboard: ArtboardMeta }>('design_artboard_create', {
      docId,
      name: 'Home',
      width: 1440,
      height: 900,
    })
  ).artboard
  await call('design_write_html', {
    artboardId: home.id,
    html: HOME_HTML,
    mode: 'replace',
    summary: 'first draft of Home',
  })
  await call('design_tokens_set', { docId, tokens: { color: { primary: '#7a3e12' } } })
  const children = await call<{ items: DesignNodeSummary[] }>('design_children_get', {
    artboardId: home.id,
    nodeId: null,
  })
  heroId = children.items[0].id
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('design tools — limits and safety', () => {
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

  it('input limits: oversized artboards are clamped with a warning; html, names and assets are refused by the schema', async () => {
    const huge = await call<{ artboard: ArtboardMeta; warnings: string[] }>(
      'design_artboard_create',
      { docId, name: 'Huge', width: 30000, height: 30000 },
    )
    expect(huge.artboard.width).toBe(16384)
    expect(huge.artboard.height).toBe(16384)
    expect(huge.warnings).toHaveLength(2)
    expect(huge.warnings[0]).toMatch(/width 30000 clamped to 16384/)
    await expect(
      call('design_artboard_create', { docId, name: 'Zero', width: 0, height: 100 }),
    ).rejects.toThrow()
    await expect(
      call('design_write_html', {
        artboardId: home.id,
        html: '<p>' + 'x'.repeat(512 * 1024) + '</p>',
        summary: 'big',
      }),
    ).rejects.toThrow()
    await expect(
      call('design_nodes_rename', {
        artboardId: home.id,
        items: [{ id: heroId, name: 'n'.repeat(201) }],
      }),
    ).rejects.toThrow()
    await expect(
      call('design_asset_upload', {
        docId,
        name: 'big.png',
        mime: 'image/png',
        dataBase64: 'A'.repeat(Math.ceil((5 * 1024 * 1024) / 3) * 4 + 4),
      }),
    ).rejects.toThrow()
  })

  it('design_asset_upload sanitizes svg and refuses bytes that do not match the mime', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://x")</script><rect/></svg>'
    const { asset } = await call<{ asset: { id: string; size: number; url: string } }>(
      'design_asset_upload',
      {
        docId,
        name: 'icon.svg',
        mime: 'image/svg+xml',
        dataBase64: Buffer.from(svg).toString('base64'),
      },
    )
    expect(asset.size).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'.length)
    await expect(
      call('design_asset_upload', {
        docId,
        name: 'fake.png',
        mime: 'image/png',
        dataBase64: Buffer.from(svg).toString('base64'),
      }),
    ).rejects.toThrow(/do not look like/)
  })

  it('a pasted subtree with a <style> child and a vbscript: url is sanitized before persisting', async () => {
    const { version } = await call<{ version: number }>('design_text_set', {
      artboardId: home.id,
      nodeId: heroId,
      text: 'x',
    })
    const evt = mutateApply({
      artboardId: home.id,
      ops: [
        {
          type: 'insert',
          parentId: heroId,
          index: 0,
          node: {
            id: 'pasted',
            tag: 'div',
            kind: 'frame',
            style: {},
            attrs: { onclick: 'x()', href: 'vbscript:x' },
            children: [
              {
                id: 'st',
                tag: 'style',
                kind: 'element',
                style: {},
                attrs: {},
                text: 'body{}',
                children: [],
              },
              { id: 'ok', tag: 'p', kind: 'text', style: {}, attrs: {}, text: 'hi', children: [] },
            ],
          },
        },
      ],
      baseVersion: version,
    })
    expect(evt.version).toBe(version + 1)
    const pasted = await call<{
      node: { attrs: Record<string, string> }
      children: Array<{ tag: string }>
    }>('design_node_get', { artboardId: home.id, nodeId: 'pasted' })
    expect(pasted.node.attrs).toEqual({})
    expect(pasted.children.map((c) => c.tag)).toEqual(['p'])
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

  it('design_screenshot fails with a friendly error without Electron', async () => {
    expect(tool('design_screenshot')).toBeDefined()
    await expect(call('design_screenshot', { artboardId: home.id })).rejects.toThrow(
      /design_screenshot unavailable/,
    )
  })
})
