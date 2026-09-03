/** @vitest-environment node */
// Scenario 3 — the v2 surface: flow artboards, clamp warnings, motion presets,
// smart links and a screenshot whose capture is mocked to return tiles (the
// real offscreen window needs Electron). Same DB/electron strategy as
// design-tools.test.ts.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-design-tools-v2-test-'))
  return {
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    BrowserWindow: { getAllWindows: () => [] },
  }
})

const captureArtboard = vi.fn()
vi.mock('../design/screenshot', () => ({
  captureArtboard: (input: unknown) => captureArtboard(input),
  computeStyles: () => Promise.reject(new Error('BrowserWindow is not a constructor')),
}))

import { app } from 'electron'
import { closeDb } from '../db'
import * as designStore from '../design/design-store'
import * as liveState from '../design/live-state'
import type { DesignMotion, DesignNodeSummary } from '../../../../shared/types/design'
import { HOME_HTML, makeHarness, type ArtboardMeta } from './design-tools-test-support'

const { call, notify } = makeHarness()

interface ArtboardMetaV2 extends ArtboardMeta {
  sizing: 'fixed' | 'flow'
}

let docId: string
let landing: ArtboardMetaV2
let cardapio: ArtboardMetaV2
let heroId: string
let menuId: string
let ctaId: string

beforeAll(async () => {
  liveState.resetLiveState()
  const { document } = await call<{ document: { id: string } }>('design_document_create', {
    title: 'Breads do Breno v2',
  })
  docId = document.id
})

afterAll(() => {
  closeDb()
  rmSync(app.getPath('userData'), { recursive: true, force: true })
})

describe('design tools v2 — flow artboards, motion and tiled screenshots', () => {
  it('design_artboard_create with sizing flow defaults the height and keeps the width', async () => {
    const result = await call<{ artboard: ArtboardMetaV2; warnings: string[] }>(
      'design_artboard_create',
      { docId, name: 'Landing', width: 1440, sizing: 'flow', html: HOME_HTML },
    )
    landing = result.artboard
    expect(landing.sizing).toBe('flow')
    expect(landing.width).toBe(1440)
    expect(landing.height).toBe(600)
    expect(result.warnings).toEqual([])

    const children = await call<{ items: DesignNodeSummary[] }>('design_children_get', {
      artboardId: landing.id,
      nodeId: null,
    })
    ;[heroId, menuId] = children.items.map((n) => n.id)
    ctaId = children.items[0].children!.find((c) => c.tag === 'a')!.id
  })

  it('a fixed artboard without height is refused by the schema', async () => {
    await expect(
      call('design_artboard_create', { docId, name: 'No height', width: 1440 }),
    ).rejects.toThrow(/height is required/)
    const fixed = await call<{ artboard: ArtboardMetaV2 }>('design_artboard_create', {
      docId,
      name: 'Cardápio',
      width: 1440,
      height: 900,
    })
    cardapio = fixed.artboard
    expect(cardapio.sizing).toBe('fixed')
  })

  it('20000 px is clamped to 16384 with a warning instead of a refusal', async () => {
    const { artboard, warnings } = await call<{ artboard: ArtboardMetaV2; warnings: string[] }>(
      'design_artboard_create',
      { docId, name: 'Wide', width: 20000, height: 900 },
    )
    expect(artboard.width).toBe(16384)
    expect(artboard.height).toBe(900)
    expect(warnings).toEqual(['width 20000 clamped to 16384 (max 16384)'])
  })

  it('design_motion_set stores normalised presets and echoes them', async () => {
    const result = await call<{
      version: number
      nodeIds: string[]
      motions: Record<string, DesignMotion | null>
    }>('design_motion_set', {
      artboardId: landing.id,
      items: [
        { id: heroId, motion: { entrance: { preset: 'fade', duration: 400 } } },
        {
          id: menuId,
          motion: { entrance: { preset: 'slide-up', trigger: 'in-view', stagger: 60 } },
        },
        { id: ctaId, motion: { hover: { preset: 'lift' }, loop: { preset: 'pulse' } } },
      ],
      summary: 'motion pass',
    })
    expect(result.nodeIds).toEqual([heroId, menuId, ctaId])
    expect(result.motions[heroId]).toEqual({
      entrance: { preset: 'fade', trigger: 'load', duration: 400, delay: 0, easing: 'ease-out' },
    })
    expect(result.motions[menuId]?.entrance).toMatchObject({
      preset: 'slide-up',
      trigger: 'in-view',
      stagger: 60,
    })
    expect(result.motions[ctaId]).toEqual({
      hover: { preset: 'lift', duration: 160, easing: 'ease-out' },
      loop: { preset: 'pulse', duration: 1800 },
    })
    const versions = designStore.listVersions(landing.id)
    expect(versions[0]).toMatchObject({ version: result.version, summary: 'motion pass' })

    const node = await call<{ node: { motion?: DesignMotion } }>('design_node_get', {
      artboardId: landing.id,
      nodeId: heroId,
    })
    expect(node.node.motion?.entrance?.preset).toBe('fade')
  })

  it('design_motion_set refuses unknown presets and out-of-range values', async () => {
    await expect(
      call('design_motion_set', {
        artboardId: landing.id,
        items: [{ id: heroId, motion: { entrance: { preset: 'wobble' } } }],
      }),
    ).rejects.toThrow()
    await expect(
      call('design_motion_set', {
        artboardId: landing.id,
        items: [{ id: heroId, motion: { entrance: { preset: 'fade', duration: 9000 } } }],
      }),
    ).rejects.toThrow()
    await expect(
      call('design_motion_set', {
        artboardId: landing.id,
        items: [{ id: heroId, motion: { parallax: { factor: 2 } } }],
      }),
    ).rejects.toThrow()
    await expect(
      call('design_motion_set', {
        artboardId: landing.id,
        items: [{ id: landing.rootId, motion: { hover: { preset: 'lift' } } }],
      }),
    ).rejects.toThrow(/root/)
    // Nothing above touched the tree.
    const node = await call<{ node: { motion?: DesignMotion } }>('design_node_get', {
      artboardId: landing.id,
      nodeId: heroId,
    })
    expect(node.node.motion?.entrance?.duration).toBe(400)
  })

  it('design_tree_summary and design_document_get show sizing, measured height and motion', async () => {
    const summary = await call<{
      sizing: string
      height: number
      measuredHeight?: number
      hasMotion: boolean
      text: string
    }>('design_tree_summary', { artboardId: landing.id })
    expect(summary.sizing).toBe('flow')
    expect(summary.measuredHeight).toBe(summary.height)
    expect(summary.hasMotion).toBe(true)
    expect(summary.text).toContain(`${heroId} section.frame "hero" [motion in: fade 400ms]`)
    expect(summary.text).toContain('[motion in: slide-up 220ms in-view +stagger 60]')
    expect(summary.text).toContain('[motion hover: lift · loop: pulse 1800ms]')

    const fixed = await call<{ measuredHeight?: number; hasMotion: boolean }>(
      'design_tree_summary',
      { artboardId: cardapio.id },
    )
    expect(fixed.measuredHeight).toBeUndefined()
    expect(fixed.hasMotion).toBe(false)

    const doc = await call<{
      document: {
        pages: Array<{
          artboards: Array<{
            id: string
            sizing: string
            measuredHeight?: number
            hasMotion: boolean
            summary: string
          }>
        }>
      }
    }>('design_document_get', { docId })
    const meta = doc.document.pages[0].artboards.find((a) => a.id === landing.id)!
    expect(meta.sizing).toBe('flow')
    expect(meta.measuredHeight).toBe(600)
    expect(meta.hasMotion).toBe(true)
    expect(meta.summary).toContain('[motion in: fade 400ms]')
  })

  it('design_link_set accepts smart with duration and easing', async () => {
    await call('design_link_set', {
      artboardId: landing.id,
      nodeId: ctaId,
      targetArtboardId: cardapio.id,
      transition: 'smart',
      duration: 400,
      easing: 'spring-gentle',
    })
    const cta = await call<{ node: { link: unknown } }>('design_node_get', {
      artboardId: landing.id,
      nodeId: ctaId,
    })
    expect(cta.node.link).toEqual({
      artboardId: cardapio.id,
      transition: 'smart',
      duration: 400,
      easing: 'spring-gentle',
    })
    await expect(
      call('design_link_set', {
        artboardId: landing.id,
        nodeId: ctaId,
        targetArtboardId: cardapio.id,
        transition: 'smart',
        easing: 'bounce',
      }),
    ).rejects.toThrow()
  })

  it('design_screenshot forwards motion, reports tiles and persists the measured height', async () => {
    captureArtboard.mockResolvedValueOnce({
      png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      width: 1440,
      height: 4200,
      tiles: 2,
      measuredHeight: 4200,
    })
    const before = designStore.getArtboard(landing.id)!
    const versionsBefore = designStore.listVersions(landing.id).length
    const shot = await call<{
      sizing: string
      motion: string
      tiles: number
      measuredHeight?: number
      warnings: string[]
      version: number
      pngBase64: string
    }>('design_screenshot', { artboardId: landing.id, motion: 'final' })
    expect(captureArtboard).toHaveBeenCalledWith(
      expect.objectContaining({
        artboardId: landing.id,
        sizing: 'flow',
        motion: 'final',
        width: 1440,
        height: 600,
        scale: 1,
      }),
    )
    expect(shot).toMatchObject({
      sizing: 'flow',
      motion: 'final',
      tiles: 2,
      measuredHeight: 4200,
      warnings: [],
    })
    expect(Buffer.from(shot.pngBase64, 'base64')[1]).toBe(0x50)

    const after = designStore.getArtboard(landing.id)!
    expect(after.height).toBe(4200)
    expect(after.sizing).toBe('flow')
    expect(after.version).toBe(before.version + 1)
    expect(shot.version).toBe(after.version)
    // Height is metadata: no named version, tree untouched.
    expect(designStore.listVersions(landing.id).length).toBe(versionsBefore)
    expect(after.tree).toEqual(before.tree)
    // A measurement is not an agent edit for the renderer to announce.
    const persisted = notify.calls
      .filter(
        ([channel, evt]) =>
          channel === 'design:artboard-updated' &&
          (evt as { artboardId: string }).artboardId === landing.id,
      )
      .at(-1)
    expect((persisted![1] as { origin: { kind: string }; version: number }).version).toBe(
      after.version,
    )
    expect((persisted![1] as { origin: { kind: string } }).origin.kind).toBe('human')

    // Same height again: nothing to persist.
    captureArtboard.mockResolvedValueOnce({
      png: Buffer.from([0x89]),
      width: 1440,
      height: 4200,
      tiles: 2,
      measuredHeight: 4200,
    })
    const again = await call<{ version: number; motion: string }>('design_screenshot', {
      artboardId: landing.id,
    })
    expect(again.version).toBe(after.version)
    expect(again.motion).toBe('final')
  })

  it('design_screenshot at the initial pose reports the measure but never persists it', async () => {
    captureArtboard.mockResolvedValueOnce({
      png: Buffer.from([0x89]),
      width: 1440,
      height: 900,
      tiles: 2,
      measuredHeight: 900,
    })
    const before = designStore.getArtboard(landing.id)!
    const shot = await call<{ measuredHeight?: number; version: number }>('design_screenshot', {
      artboardId: landing.id,
      motion: 'initial',
    })
    expect(shot.measuredHeight).toBe(900)
    const after = designStore.getArtboard(landing.id)!
    expect(after.height).toBe(before.height)
    expect(after.version).toBe(before.version)
    expect(shot.version).toBe(before.version)
  })

  it('design_screenshot warns when the content hits the height limit', async () => {
    captureArtboard.mockResolvedValueOnce({
      png: Buffer.from([0x89]),
      width: 1440,
      height: 16384,
      tiles: 4,
      measuredHeight: 16384,
    })
    const shot = await call<{ warnings: string[]; tiles: number }>('design_screenshot', {
      artboardId: landing.id,
    })
    expect(shot.tiles).toBe(4)
    expect(shot.warnings[0]).toMatch(/16384px limit/)
  })
})
