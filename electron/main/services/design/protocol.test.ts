// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { DesignArtboard } from '../../../../shared/types/design'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

import {
  ASSET_CSP,
  artboardCsp,
  artboardUrl,
  assetUrl,
  createDesignProtocolHandler,
  isAllowedFrameNavigation,
  routeDesignUrl,
} from './protocol'

describe('routeDesignUrl', () => {
  it('routes artboard urls with doc and mode', () => {
    expect(routeDesignUrl('pitwall-design://artboard/ab-1?doc=doc-1&mode=shot')).toEqual({
      kind: 'artboard',
      id: 'ab-1',
      docId: 'doc-1',
      mode: 'shot',
    })
  })

  it('defaults mode to edit and decodes the id', () => {
    expect(routeDesignUrl('pitwall-design://artboard/a%20b?doc=d')).toEqual({
      kind: 'artboard',
      id: 'a b',
      docId: 'd',
      mode: 'edit',
    })
  })

  it('rejects artboard urls without doc or with an unknown mode', () => {
    expect(routeDesignUrl('pitwall-design://artboard/ab-1')).toEqual({ kind: 'notFound' })
    expect(routeDesignUrl('pitwall-design://artboard/ab-1?doc=d&mode=nope')).toEqual({
      kind: 'notFound',
    })
  })

  it('routes asset urls', () => {
    expect(routeDesignUrl('pitwall-design://asset/as-1')).toEqual({ kind: 'asset', id: 'as-1' })
  })

  it('returns notFound for other hosts, nested paths, other schemes and garbage', () => {
    expect(routeDesignUrl('pitwall-design://other/x')).toEqual({ kind: 'notFound' })
    expect(routeDesignUrl('pitwall-design://asset/a/b')).toEqual({ kind: 'notFound' })
    expect(routeDesignUrl('pitwall-design://asset/')).toEqual({ kind: 'notFound' })
    expect(routeDesignUrl('https://asset/a')).toEqual({ kind: 'notFound' })
    expect(routeDesignUrl('not a url')).toEqual({ kind: 'notFound' })
  })

  it('round-trips the url builders', () => {
    expect(routeDesignUrl(artboardUrl('a b', 'd', 'preview', 'tok'))).toEqual({
      kind: 'artboard',
      id: 'a b',
      docId: 'd',
      mode: 'preview',
    })
    expect(routeDesignUrl(assetUrl('x/y'))).toEqual({ kind: 'asset', id: 'x/y' })
  })
})

describe('createDesignProtocolHandler', () => {
  const artboard: DesignArtboard = {
    id: 'ab-1',
    pageId: 'p',
    name: 'Home',
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    tree: { id: 'root', tag: 'div', kind: 'frame', style: {}, attrs: {}, children: [] },
    version: 1,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
  }
  const handler = createDesignProtocolHandler({
    getDocument: (id) => (id === 'doc-1' ? { tokens: {}, fonts: [], globalCss: '' } : null),
    getArtboard: (id) => (id === 'ab-1' ? artboard : null),
    getAsset: (id) => (id === 'as-1' ? { mime: 'image/png', bytes: Buffer.from([1, 2, 3]) } : null),
    readRuntimeJs: () => 'console.log("rt")',
  })

  it('serves the artboard document with nonce CSP and no-store', async () => {
    const res = await handler(new Request('pitwall-design://artboard/ab-1?doc=doc-1&mode=edit'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(csp).toBe(artboardCsp(nonce!))
    const html = await res.text()
    expect(html).toContain(`<script nonce="${nonce}">console.log("rt")</script>`)
    expect(html).toContain('data-pw-artboard="ab-1"')
  })

  it('omits the runtime in shot mode', async () => {
    const res = await handler(new Request('pitwall-design://artboard/ab-1?doc=doc-1&mode=shot'))
    expect(await res.text()).not.toContain('<script')
  })

  it('serves asset bytes as immutable, sandboxed and never sniffed', async () => {
    const res = await handler(new Request('pitwall-design://asset/as-1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('Content-Security-Policy')).toBe(ASSET_CSP)
    expect(ASSET_CSP).toMatch(/default-src 'none'/)
    expect(ASSET_CSP).toMatch(/\bsandbox\b/)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Disposition')).toBe('inline')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('returns 404 for unknown ids and routes', async () => {
    expect((await handler(new Request('pitwall-design://asset/nope'))).status).toBe(404)
    expect((await handler(new Request('pitwall-design://artboard/nope?doc=doc-1'))).status).toBe(
      404,
    )
    expect((await handler(new Request('pitwall-design://artboard/ab-1?doc=nope'))).status).toBe(404)
    expect((await handler(new Request('pitwall-design://zzz/1'))).status).toBe(404)
  })
})

describe('isAllowedFrameNavigation', () => {
  it('only artboard documents may load in a sub-frame', () => {
    expect(isAllowedFrameNavigation(artboardUrl('ab', 'doc', 'preview', 't'))).toBe(true)
    expect(isAllowedFrameNavigation(assetUrl('as-1'))).toBe(false)
    expect(isAllowedFrameNavigation('https://evil.example/')).toBe(false)
    expect(isAllowedFrameNavigation('about:blank')).toBe(false)
  })
})
