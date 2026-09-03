import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, protocol, type WebContents } from 'electron'
import {
  buildArtboardDocument,
  isMotionPose,
  type ArtboardMotionPose,
  type ArtboardRenderMode,
} from '../../../../shared/design/html-render'
import type { DesignArtboard, DesignAsset, DesignDocument } from '../../../../shared/types/design'

// pitwall-design:// serves artboard documents and asset bytes to the sandboxed
// iframes (opaque origin) and to the offscreen screenshot window. The scheme is
// registered as standard so `url.host` routes and relative URLs resolve.

export const DESIGN_SCHEME = 'pitwall-design'

const RENDER_MODES: ReadonlySet<string> = new Set(['edit', 'shot', 'preview'])

export type DesignRoute =
  | {
      kind: 'artboard'
      id: string
      docId: string
      mode: ArtboardRenderMode
      // ?motion=initial|final (omitted = final).
      motion: ArtboardMotionPose
    }
  | { kind: 'asset'; id: string }
  | { kind: 'notFound' }

function singleSegment(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null
  try {
    return decodeURIComponent(segments[0])
  } catch {
    return null
  }
}

export function routeDesignUrl(raw: string): DesignRoute {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'notFound' }
  }
  if (url.protocol !== `${DESIGN_SCHEME}:`) return { kind: 'notFound' }
  const id = singleSegment(url.pathname)
  if (!id) return { kind: 'notFound' }
  switch (url.host.toLowerCase()) {
    case 'artboard': {
      const docId = url.searchParams.get('doc')
      const mode = url.searchParams.get('mode') ?? 'edit'
      const motion = url.searchParams.get('motion') ?? 'final'
      if (!docId || !RENDER_MODES.has(mode) || !isMotionPose(motion)) return { kind: 'notFound' }
      return { kind: 'artboard', id, docId, mode: mode as ArtboardRenderMode, motion }
    }
    case 'asset':
      return { kind: 'asset', id }
    default:
      return { kind: 'notFound' }
  }
}

export function artboardUrl(
  artboardId: string,
  docId: string,
  mode: ArtboardRenderMode,
  token?: string,
  motion?: ArtboardMotionPose,
): string {
  const params = new URLSearchParams({ doc: docId, mode })
  if (token) params.set('t', token)
  if (motion && motion !== 'final') params.set('motion', motion)
  return `${DESIGN_SCHEME}://artboard/${encodeURIComponent(artboardId)}?${params.toString()}`
}

export function assetUrl(assetId: string): string {
  return `${DESIGN_SCHEME}://asset/${encodeURIComponent(assetId)}`
}

// An asset can also be navigated to (a click on <area>/<a> pointing at it):
// as a document it must not run anything, reach anywhere or be sniffed
// into something else.
export const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

export function artboardCsp(nonce: string): string {
  return (
    "default-src 'none'; " +
    "style-src 'unsafe-inline' https://fonts.googleapis.com; " +
    'font-src https://fonts.gstatic.com data:; ' +
    `img-src data: blob: ${DESIGN_SCHEME}:; ` +
    `script-src 'nonce-${nonce}'; ` +
    "connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
  )
}

type MaybePromise<T> = T | Promise<T>

export interface DesignAssetBytes {
  mime: DesignAsset['mime']
  bytes: Buffer
}

export interface DesignProtocolDeps {
  getDocument(
    docId: string,
  ): MaybePromise<Pick<DesignDocument, 'tokens' | 'fonts' | 'globalCss'> | null>
  getArtboard(artboardId: string): MaybePromise<DesignArtboard | null>
  getAsset(assetId: string): MaybePromise<DesignAssetBytes | null>
  // Test seam; defaults to the built bundle on disk.
  readRuntimeJs?: () => string
}

// Must run before app.whenReady().
export function registerDesignScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: DESIGN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

let runtimeJsCache: string | null = null

function readRuntimeJsFromDisk(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '../design-runtime/runtime.js'),
    join(app.getAppPath(), 'out/design-runtime/runtime.js'),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  console.error(
    '[design] runtime bundle not found; artboards will render without the runtime',
    candidates,
  )
  return ''
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
}

export function createDesignProtocolHandler(
  deps: DesignProtocolDeps,
): (request: Request) => Promise<Response> {
  const readRuntimeJs = deps.readRuntimeJs ?? readRuntimeJsFromDisk
  return async (request) => {
    const route = routeDesignUrl(request.url)
    if (route.kind === 'asset') {
      const asset = await deps.getAsset(route.id)
      if (!asset) return notFound()
      return new Response(new Uint8Array(asset.bytes), {
        status: 200,
        headers: {
          'Content-Type': asset.mime,
          'Content-Length': String(asset.bytes.byteLength),
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Security-Policy': ASSET_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline',
        },
      })
    }
    if (route.kind !== 'artboard') return notFound()
    const [doc, artboard] = await Promise.all([
      deps.getDocument(route.docId),
      deps.getArtboard(route.id),
    ])
    if (!doc || !artboard) return notFound()
    if (runtimeJsCache === null) runtimeJsCache = readRuntimeJs()
    const nonce = randomBytes(16).toString('base64')
    const html = buildArtboardDocument({
      doc,
      artboard,
      runtimeJs: runtimeJsCache,
      nonce,
      mode: route.mode,
      motion: route.motion,
    })
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': artboardCsp(nonce),
      },
    })
  }
}

// Must run after app.whenReady(), before any window loads an artboard.
export function installDesignProtocol(deps: DesignProtocolDeps): void {
  protocol.handle(DESIGN_SCHEME, createDesignProtocolHandler(deps))
}

// Sub-frames of the app window may only ever show artboard documents: a
// click inside a sandboxed iframe that resolves to an asset (or anything
// else on the scheme) is refused in main, whatever the runtime let through.
export function isAllowedFrameNavigation(url: string): boolean {
  return routeDesignUrl(url).kind === 'artboard'
}

export function installDesignFrameGuard(contents: WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (!isAllowedFrameNavigation(event.url)) event.preventDefault()
  })
}
