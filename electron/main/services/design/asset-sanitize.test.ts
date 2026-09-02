// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { prepareAssetBytes, sanitizeSvg, sniffsAs } from './asset-sanitize'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const GIF = Buffer.from('GIF89a\0\0')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])

describe('sniffsAs', () => {
  it('matches raster magic bytes and refuses mismatches', () => {
    expect(sniffsAs('image/png', PNG)).toBe(true)
    expect(sniffsAs('image/jpeg', JPEG)).toBe(true)
    expect(sniffsAs('image/gif', GIF)).toBe(true)
    expect(sniffsAs('image/webp', WEBP)).toBe(true)
    expect(sniffsAs('image/png', JPEG)).toBe(false)
    expect(sniffsAs('image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      false,
    )
  })

  it('svg must start with an <svg> root (xml prolog, comments and BOM allowed)', () => {
    expect(
      sniffsAs('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBe(true)
    expect(
      sniffsAs('image/svg+xml', Buffer.from('﻿<?xml version="1.0"?><!-- c --><svg></svg>')),
    ).toBe(true)
    expect(sniffsAs('image/svg+xml', Buffer.from('<html><script>1</script></html>'))).toBe(false)
    expect(sniffsAs('image/svg+xml', PNG)).toBe(false)
  })
})

describe('sanitizeSvg', () => {
  it('strips script, foreignObject, on* handlers and executable hrefs', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('https://x')">
      <script>fetch('https://evil')</script>
      <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><b>x</b></body></foreignObject>
      <a xlink:href="javascript:alert(1)" href='vbscript:x'><rect onclick=alert(1) width="1"/></a>
      <a href="#anchor"><image href="data:image/png;base64,AA==" /></a>
    </svg>`
    const out = sanitizeSvg(Buffer.from(svg)).toString('utf8')
    expect(out).not.toMatch(/<script|foreignObject|onload|onclick|javascript:|vbscript:/i)
    expect(out).toContain('href="#anchor"')
    expect(out).toContain('href="data:image/png;base64,AA=="')
    expect(out).toContain('<rect width="1"/>')
  })

  it('refuses what the strip pass cannot express: entity-obfuscated hrefs', () => {
    const svg = '<svg><a href="&#106;avascript:alert(1)"><rect/></a></svg>'
    expect(() => sanitizeSvg(Buffer.from(svg))).toThrow(/executable/)
  })
})

describe('prepareAssetBytes', () => {
  it('rejects an svg declared as png and sanitizes a real svg', () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script><rect/></svg>',
    )
    expect(() => prepareAssetBytes('image/png', svg)).toThrow(/do not look like image\/png/)
    expect(prepareAssetBytes('image/svg+xml', svg).toString()).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    )
    expect(prepareAssetBytes('image/png', PNG)).toBe(PNG)
  })
})
