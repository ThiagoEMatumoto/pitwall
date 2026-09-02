// What an uploaded asset may contain. Raster types are sniffed by magic
// bytes (the caller's mime is a claim, not a fact); SVG is text that the
// artboard iframe can navigate to, so script-bearing constructs are stripped
// and anything still executable after that is refused.

import type { DesignAssetMime } from '../../../../shared/types/design'

const MAGIC: Record<Exclude<DesignAssetMime, 'image/svg+xml'>, (b: Buffer) => boolean> = {
  'image/png': (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47,
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8',
  'image/webp': (b) =>
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP',
}

const SVG_HEAD_BYTES = 4096
const SVG_STRIP: RegExp[] = [
  /<script\b[\s\S]*?<\/script\s*>/gi,
  /<script\b[^>]*\/?>/gi,
  /<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi,
  /<foreignObject\b[^>]*\/?>/gi,
  // on* handlers, quoted or bare.
  /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
  // Executable / document hrefs; fragments, data:image and https survive.
  /\s(?:xlink:)?href\s*=\s*("\s*(?:javascript|vbscript|data:text)[^"]*"|'\s*(?:javascript|vbscript|data:text)[^']*')/gi,
]
// Entity-obfuscated hrefs (&#106;avascript:) are refused rather than decoded.
const SVG_STILL_UNSAFE =
  /<script\b|<foreignObject\b|\son[a-z]+\s*=|javascript:|vbscript:|href\s*=\s*["'][^"']*&#/i

export function sniffsAs(mime: DesignAssetMime, bytes: Buffer): boolean {
  if (mime === 'image/svg+xml') {
    const head = bytes
      .toString('utf8', 0, Math.min(bytes.length, SVG_HEAD_BYTES))
      .replace(/^\uFEFF/, '')
    return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg\b/i.test(head)
  }
  return MAGIC[mime](bytes)
}

export function sanitizeSvg(bytes: Buffer): Buffer {
  let svg = bytes.toString('utf8')
  for (const re of SVG_STRIP) svg = svg.replace(re, '')
  if (SVG_STILL_UNSAFE.test(svg)) throw new Error('svg asset contains executable content')
  return Buffer.from(svg, 'utf8')
}

// Verifies the claimed mime against the bytes and returns the bytes to store.
export function prepareAssetBytes(mime: DesignAssetMime, bytes: Buffer): Buffer {
  if (!sniffsAs(mime, bytes)) throw new Error(`asset bytes do not look like ${mime}`)
  return mime === 'image/svg+xml' ? sanitizeSvg(bytes) : bytes
}
