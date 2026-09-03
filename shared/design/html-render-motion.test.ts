import { describe, expect, it } from 'vitest'
import type { DesignArtboard, DesignNode } from '../types/design'
import { buildArtboardDocument, renderNode, renderStandaloneHtml } from './html-render'

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
  sizing: 'fixed',
  tree,
  version: 1,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
})

describe('motion render', () => {
  const doc = { tokens: {}, fonts: [], globalCss: '' }
  const entrance = {
    preset: 'slide-up' as const,
    trigger: 'in-view' as const,
    duration: 240,
    delay: 40,
    easing: 'linear' as const,
    distance: 32,
  }

  it('emits data-pw-m-* after the user attrs and the --pw-* vars AFTER the user style', () => {
    const n = node({
      id: 'hero',
      tag: 'section',
      attrs: { class: 'hero' },
      style: { opacity: '0.5', transform: 'rotate(1deg)' },
      motion: {
        entrance,
        hover: { preset: 'scale', duration: 100, easing: 'ease-in-out', intensity: 2 },
        loop: { preset: 'float', duration: 3000, direction: 'alternate' },
        parallax: { factor: 0.25 },
      },
    })
    expect(renderNode(n)).toBe(
      '<section class="hero" style="opacity:0.5;transform:rotate(1deg);--pw-dur:240ms;--pw-delay:40ms;--pw-ease:linear;--pw-dist:32px;--pw-hdur:100ms;--pw-hease:cubic-bezier(0.65, 0, 0.35, 1);--pw-int:2;--pw-loop-dur:3000ms;--pw-loop-dir:alternate;--pw-par:0.25"' +
        ' data-pw-m-in="slide-up" data-pw-m-trigger="in-view" data-pw-m-hover="scale" data-pw-m-loop="float" data-pw-m-par="0.25" data-pw-id="hero"></section>',
    )
    // node.style itself is untouched by the projection.
    expect(n.style).toEqual({ opacity: '0.5', transform: 'rotate(1deg)' })
  })

  it('stagger on the parent indexes the children; the export keeps the motion attrs', () => {
    const list = node({
      id: 'list',
      tag: 'ul',
      motion: { entrance: { ...entrance, stagger: 60 } },
      children: [
        node({ id: 'a', tag: 'li' }),
        node({ id: 'b', tag: 'li', style: { color: 'red' } }),
      ],
    })
    const html = renderNode(list, { ids: false })
    expect(html).toBe(
      '<ul data-pw-m-stagger="60">' +
        '<li style="--pw-dur:240ms;--pw-delay:40ms;--pw-ease:linear;--pw-dist:32px;--pw-i:0;--pw-stagger:60ms" data-pw-m-in="slide-up" data-pw-m-trigger="in-view"></li>' +
        '<li style="color:red;--pw-dur:240ms;--pw-delay:40ms;--pw-ease:linear;--pw-dist:32px;--pw-i:1;--pw-stagger:60ms" data-pw-m-in="slide-up" data-pw-m-trigger="in-view"></li>' +
        '</ul>',
    )
    // A child rendered alone (runtime insert) gets the same through the ctx.
    expect(
      renderNode(list.children[1], { ids: true }, false, {
        index: 1,
        stagger: 60,
        parentEntrance: list.motion!.entrance,
      }),
    ).toContain('--pw-i:1;--pw-stagger:60ms')
  })

  it('link duration/easing become data-pw-t-dur / data-pw-t-ease (edit only)', () => {
    const n = node({
      id: 'l',
      tag: 'a',
      link: { artboardId: 'ab2', transition: 'smart', duration: 350.4, easing: 'spring-quick' },
    })
    expect(renderNode(n)).toBe(
      '<a data-pw-id="l" data-pw-link="ab2" data-pw-transition="smart" data-pw-t-dur="350" data-pw-t-ease="spring-quick"></a>',
    )
    expect(renderNode(n, { ids: false })).toBe('<a></a>')
    const odd = node({
      id: 'l',
      tag: 'a',
      link: { artboardId: 'ab2', transition: 'fade', easing: 'ease' as never },
    })
    expect(renderNode(odd)).not.toContain('data-pw-t-ease')
  })

  it('artboard document: motion sheet always present, html[data-pw-motion] defaults to final', () => {
    const tree = node({ id: 'root', tag: 'div', kind: 'frame' })
    const html = buildArtboardDocument({
      doc,
      artboard: artboard(tree),
      runtimeJs: '',
      nonce: 'n',
      mode: 'edit',
    })
    expect(html).toContain(
      '<html data-pw-mode="edit" data-pw-sizing="fixed" data-pw-motion="final">',
    )
    expect(html).toContain('<style id="pw-motion">[data-pw-m-in]{')
    const initial = buildArtboardDocument({
      doc,
      artboard: artboard(tree),
      runtimeJs: '',
      nonce: 'n',
      mode: 'shot',
      motion: 'initial',
    })
    expect(initial).toContain('data-pw-motion="initial">')
  })

  it('standalone: sheet + script + final pose only when the tree has motion', () => {
    const plain = node({
      id: 'root',
      tag: 'div',
      kind: 'frame',
      children: [node({ id: 'p', tag: 'p', text: 'hi' })],
    })
    const still = renderStandaloneHtml(doc, artboard(plain))
    expect(still).not.toContain('pw-motion')
    expect(still).not.toContain('<script')
    expect(still).not.toContain('data-pw-')

    const animated = {
      ...plain,
      children: [node({ id: 'p', tag: 'p', text: 'hi', motion: { entrance } })],
    }
    const html = renderStandaloneHtml(doc, artboard(animated))
    expect(html).toContain('<!doctype html><html data-pw-motion="final"><head>')
    expect(html).toContain('<style id="pw-motion">')
    expect(html).toContain(
      '<p style="--pw-dur:240ms;--pw-delay:40ms;--pw-ease:linear;--pw-dist:32px" data-pw-m-in="slide-up" data-pw-m-trigger="in-view">hi</p>',
    )
    expect(html).toContain('<script>(function(){var d=document,h=d.documentElement;')
    expect(html).not.toContain('data-pw-id')
  })
})
