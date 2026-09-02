import { describe, expect, it } from 'vitest'
import type { DesignNode } from '../../../../shared/types/design'
import { parseHtml, parseStyleAttr, sanitizeTree } from './html-parse'

const byTag = (nodes: DesignNode[], tag: string): DesignNode => {
  const found = nodes.find((n) => n.tag === tag)
  if (!found) throw new Error(`no <${tag}> among ${nodes.map((n) => n.tag).join(',')}`)
  return found
}

describe('parseHtml — fragment', () => {
  const html = `
    <section id="hero" style="display:flex; gap: 24px; background: var(--color-bg)">
      <nav><a href="/docs">Docs</a><a href="/pricing">Pricing</a></nav>
      <h1 data-name="Headline">Ship designs faster than ever before today</h1>
      <p>Read the <strong>docs</strong> now</p>
      <img src="https://x.test/a.png" alt="hero">
      <svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>
        <text x="1">Hi</text>
      </svg>
    </section>`

  const { nodes, globalCss, fonts, warnings } = parseHtml(html)
  const hero = nodes[0]

  it('maps tags to kinds and keeps the hierarchy', () => {
    expect(nodes).toHaveLength(1)
    expect(hero.kind).toBe('frame')
    expect(hero.name).toBe('hero')
    expect(hero.attrs).toEqual({ id: 'hero' })
    expect(hero.style).toEqual({ display: 'flex', gap: '24px', background: 'var(--color-bg)' })
    expect(hero.children.map((n) => [n.tag, n.kind])).toEqual([
      ['nav', 'frame'],
      ['h1', 'text'],
      ['p', 'element'],
      ['img', 'image'],
      ['svg', 'svg'],
    ])
    expect(warnings).toEqual([])
    expect(globalCss).toBe('')
    expect(fonts).toEqual([])
  })

  it('turns text-only elements into text nodes with derived names', () => {
    const nav = byTag(hero.children, 'nav')
    expect(nav.children.map((n) => ({ kind: n.kind, text: n.text, href: n.attrs.href }))).toEqual([
      { kind: 'text', text: 'Docs', href: '/docs' },
      { kind: 'text', text: 'Pricing', href: '/pricing' },
    ])
    const h1 = byTag(hero.children, 'h1')
    expect(h1.text).toBe('Ship designs faster than ever before today')
    expect(h1.name).toBe('Headline')
  })

  it('uses heading text (max 24 chars) as name when there is no id/data-name', () => {
    const [h2] = parseHtml('<h2>  Ship designs faster than ever  </h2>').nodes
    expect(h2.name).toBe('Ship designs faster than')
    expect(h2.text).toBe(' Ship designs faster than ever ')
  })

  it('names every text node by its text and landmarks by their capitalised tag', () => {
    const nav = byTag(hero.children, 'nav')
    expect(nav.name).toBe('Nav')
    expect(nav.children.map((n) => n.name)).toEqual(['Docs', 'Pricing'])
    const p = byTag(hero.children, 'p')
    expect(p.name).toBe('p')
    expect(p.children.map((n) => n.name)).toEqual(['Read the', 'docs', 'now'])
    expect(parseHtml('<header><div></div></header>').nodes[0].name).toBe('Header')
  })

  it('wraps loose text between elements in text spans, keeping inline spaces', () => {
    const p = byTag(hero.children, 'p')
    expect(p.children.map((n) => [n.tag, n.kind, n.text])).toEqual([
      ['span', 'text', 'Read the '],
      ['strong', 'text', 'docs'],
      ['span', 'text', ' now'],
    ])
  })

  it('drops source indentation around text but keeps preformatted content', () => {
    const [h1, pre] = parseHtml('<h1>\n  Title\n</h1><pre>\n  a\n b</pre>').nodes
    expect(h1.text).toBe('Title')
    // The newline right after <pre> is dropped by the HTML spec, not by us.
    expect(pre.text).toBe('  a\n b')
  })

  it('preserves case inside svg and hangs loose svg text on its element', () => {
    const svg = byTag(hero.children, 'svg')
    expect(svg.attrs.viewBox).toBe('0 0 10 10')
    const defs = byTag(svg.children, 'defs')
    expect(defs.children[0].tag).toBe('linearGradient')
    expect(defs.children[0].kind).toBe('element')
    const text = byTag(svg.children, 'text')
    expect(text.text).toBe('Hi')
    expect(text.children).toEqual([])
  })

  it('assigns unique ids everywhere', () => {
    const ids: string[] = []
    const walk = (n: DesignNode): void => {
      ids.push(n.id)
      n.children.forEach(walk)
    }
    walk(hero)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^[0-9a-z]{10}$/.test(id))).toBe(true)
  })

  it('decodes entities', () => {
    const [p] = parseHtml('<p>Tom &amp; Jerry &copy; &lt;3</p>').nodes
    expect(p.text).toBe('Tom & Jerry © <3')
  })
})

describe('parseHtml — full document', () => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Landing</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">
    <link rel="stylesheet" href="https://cdn.test/site.css">
    <style>body { margin: 0 } .hero { color: red }</style>
  </head>
  <body>
    <main class="hero"><h1>Hello</h1></main>
    <style>.late { color: blue }</style>
  </body>
</html>`

  const result = parseHtml(html)

  it('collects style blocks and google fonts, drops the rest of head', () => {
    expect(result.globalCss).toBe('body { margin: 0 } .hero { color: red }\n.late { color: blue }')
    expect(result.fonts).toEqual([
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap',
    ])
    expect(result.warnings).toEqual([
      'dropped <meta>',
      'dropped <link> (only Google Fonts stylesheets are kept): https://cdn.test/site.css',
    ])
  })

  it('returns body children as nodes', () => {
    expect(result.nodes.map((n) => n.tag)).toEqual(['main'])
    expect(result.nodes[0].attrs).toEqual({ class: 'hero' })
    expect(result.nodes[0].children[0]).toMatchObject({
      tag: 'h1',
      kind: 'text',
      text: 'Hello',
      name: 'Hello',
    })
  })

  it('also recognises documents that start with <html>', () => {
    const { nodes } = parseHtml('<html><body><div>x</div></body></html>')
    expect(nodes.map((n) => n.tag)).toEqual(['div'])
  })
})

describe('parseHtml — sanitizing', () => {
  it('drops script/iframe with warnings', () => {
    const { nodes, warnings } = parseHtml(
      '<div><script>alert(1)</script><iframe src="x"></iframe><p>ok</p></div>',
    )
    expect(nodes[0].children.map((n) => n.tag)).toEqual(['p'])
    expect(warnings).toEqual(['dropped <script>', 'dropped <iframe>'])
  })

  it('removes on* handlers', () => {
    const { nodes, warnings } = parseHtml(
      '<button onclick="steal()" onMouseOver="x()" class="cta">Go</button>',
    )
    expect(nodes[0].attrs).toEqual({ class: 'cta' })
    expect(warnings).toEqual([
      'dropped attribute onclick on <button>',
      'dropped attribute onmouseover on <button>',
    ])
  })

  it('removes javascript: urls', () => {
    const { nodes, warnings } = parseHtml(
      '<a href=" JavaScript:alert(1)">x</a><img src="javascript:1"><a href="https://ok.test">y</a>',
    )
    expect(nodes[0].attrs).toEqual({})
    expect(nodes[1].attrs).toEqual({})
    expect(nodes[2].attrs).toEqual({ href: 'https://ok.test' })
    expect(warnings).toEqual(['dropped unsafe href on <a>', 'dropped unsafe src on <img>'])
  })

  it('strips data-pw-* marks from pasted exports', () => {
    const { nodes } = parseHtml('<div data-pw-id="abc" data-name="Card"></div>')
    expect(nodes[0].attrs).toEqual({ 'data-name': 'Card' })
    expect(nodes[0].name).toBe('Card')
  })

  it('ignores whitespace-only text and comments', () => {
    const { nodes } = parseHtml('<div>\n  <!-- c -->\n  <span>a</span>\n</div>')
    expect(nodes[0].children.map((n) => n.tag)).toEqual(['span'])
  })
})

describe('parseStyleAttr', () => {
  it('splits on ; outside parentheses and quotes, lowercases keys', () => {
    expect(
      parseStyleAttr(
        `Background-Image: url("a;b.png"); content: 'x;y'; Padding:8px 16px ; --Brand-Color: #f00; broken; color: red !important`,
      ),
    ).toEqual({
      'background-image': 'url("a;b.png")',
      content: "'x;y'",
      padding: '8px 16px',
      '--Brand-Color': '#f00',
      color: 'red !important',
    })
  })

  it('handles url() without quotes containing ;', () => {
    expect(parseStyleAttr('background:url(data:image/svg+xml;base64,AAA);color:blue')).toEqual({
      background: 'url(data:image/svg+xml;base64,AAA)',
      color: 'blue',
    })
  })
})

describe('sanitizeTree', () => {
  const node = (partial: Partial<DesignNode> & { id: string; tag: string }): DesignNode => ({
    kind: 'element',
    style: {},
    attrs: {},
    children: [],
    ...partial,
  })

  it('drops blocked children, event handlers, unsafe urls and fixes duplicate ids', () => {
    const tree = node({
      id: 'root',
      tag: 'div',
      kind: 'frame',
      children: [
        node({ id: 'a', tag: 'script' }),
        node({ id: 'a', tag: 'a', attrs: { href: 'javascript:1', onclick: 'x', title: 't' } }),
        node({ id: '', tag: 'p' }),
      ],
    })
    const { tree: out, warnings } = sanitizeTree(tree)
    expect(out).not.toBe(tree)
    expect(out.children.map((n) => n.tag)).toEqual(['a', 'p'])
    expect(out.children[0].id).toBe('a')
    expect(out.children[0].attrs).toEqual({ title: 't' })
    expect(out.children[1].id).toMatch(/^[0-9a-z]{10}$/)
    expect(warnings).toEqual([
      'dropped <script>',
      'dropped unsafe href on <a>',
      'dropped attribute onclick on <a>',
    ])
    expect(tree.children).toHaveLength(3)
  })

  it('replaces a blocked root with an empty frame', () => {
    const { tree, warnings } = sanitizeTree(node({ id: 'r', tag: 'script' }))
    expect(tree.kind).toBe('frame')
    expect(warnings).toEqual(['root <script> replaced by an empty frame'])
  })
})

describe('sanitizeTree — renderer-grade rules', () => {
  const node = (partial: Partial<DesignNode> & { id: string; tag: string }): DesignNode => ({
    kind: 'element',
    style: {},
    attrs: {},
    children: [],
    ...partial,
  })

  it('drops style/link/meta/base/area tags, bad attribute names, obfuscated urls and bad links', () => {
    const tree = node({
      id: 'root',
      tag: 'div',
      kind: 'frame',
      children: [
        node({ id: 's', tag: 'style', text: 'body{}' }),
        node({ id: 'm', tag: 'META' }),
        node({ id: 'ar', tag: 'area', attrs: { href: 'pitwall-design://asset/x' } }),
        node({
          id: 'a',
          tag: 'a',
          attrs: {
            href: 'java\nscript:alert(1)',
            'xlink:href': 'vbscript:x',
            src: 'data:text/html,<script>',
            'bad name': '1',
            'data-pw-id': 'spoof',
            title: 'ok',
          },
          link: { artboardId: 'x', transition: '"><img src=x>' } as never,
        }),
        node({
          id: 'ok',
          tag: 'img',
          attrs: { src: 'data:image/png;base64,AA==' },
          link: { artboardId: 'ab2', transition: 'fade' },
        }),
      ],
    })
    const { tree: out, warnings } = sanitizeTree(tree)
    expect(out.children.map((n) => n.tag)).toEqual(['a', 'img'])
    expect(out.children[0].attrs).toEqual({ title: 'ok' })
    expect(out.children[0].link).toBeUndefined()
    expect(out.children[1].link).toEqual({ artboardId: 'ab2', transition: 'fade' })
    expect(warnings).toEqual([
      'dropped <style>',
      'dropped <META>',
      'dropped <area>',
      'dropped unsafe href on <a>',
      'dropped unsafe xlink:href on <a>',
      'dropped unsafe src on <a>',
      'dropped attribute bad name on <a>',
      'dropped invalid link on a',
    ])
  })

  it('refuses a tree nesting deeper than the limit', () => {
    let tree: DesignNode = node({ id: 'leaf', tag: 'span' })
    for (let i = 0; i < 400; i++) tree = node({ id: `n${i}`, tag: 'div', children: [tree] })
    expect(() => sanitizeTree(tree)).toThrow(/deeper than 256/)
  })
})

describe('parseHtml — limits', () => {
  it('refuses html nesting deeper than the limit', () => {
    const html = '<div>'.repeat(400) + 'x' + '</div>'.repeat(400)
    expect(() => parseHtml(html)).toThrow(/deeper than 256/)
  })

  it('drops <area> and attributes with invalid names', () => {
    const { nodes, warnings } = parseHtml(
      '<map><area href="/x"><img src="a.png" data-pw-id="z"></map>',
    )
    expect(nodes[0].children.map((n) => n.tag)).toEqual(['img'])
    expect(nodes[0].children[0].attrs).toEqual({ src: 'a.png' })
    expect(warnings).toEqual(['dropped <area>'])
  })
})
