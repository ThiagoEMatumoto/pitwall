// Steps 5, 6 and 10: presets set through design_motion_set and projected as
// data-pw-m-* attributes + --pw-* variables in the edit frame, the
// initial/final poses of design_screenshot differing, and the standalone
// export carrying the motion sheet and script.
import { LANDING_NODES } from './content'
import { editFrame, nodeAttrs, shotViaTool, type V2Ctx } from './ctx'

interface ChildrenGet {
  items: Array<{ id: string; name?: string }>
}

export async function step5MotionSet(ctx: V2Ctx): Promise<void> {
  const { mcp } = ctx
  const hero = await ctx.findId('landing', LANDING_NODES.hero)
  const cards = await ctx.findId('landing', LANDING_NODES.cards)
  const cta = await ctx.findId('landing', LANDING_NODES.heroCta)
  const marquee = await ctx.findId('landing', LANDING_NODES.marquee)
  const image = await ctx.findId('landing', LANDING_NODES.parallaxImage)

  const res = await mcp.call('design_motion_set', {
    artboardId: ctx.ids.landing,
    items: [
      {
        id: hero,
        motion: {
          entrance: { preset: 'fade', trigger: 'load', duration: 600 },
        },
      },
      {
        id: cards,
        motion: {
          entrance: {
            preset: 'slide-up',
            trigger: 'in-view',
            duration: 420,
            stagger: 80,
          },
        },
      },
      { id: cta, motion: { hover: { preset: 'lift' } } },
      { id: marquee, motion: { loop: { preset: 'marquee', duration: 12000 } } },
      { id: image, motion: { parallax: { factor: 0.15 } } },
    ],
    summary: 'Animações da landing',
  })
  ctx.check('5 design_motion_set applied', typeof res.version === 'number', JSON.stringify(res))
  await ctx.page.waitForTimeout(700)

  const frame = await editFrame(ctx, 'landing')
  const heroEl = await nodeAttrs(frame, hero)
  ctx.check(
    '5 hero: data-pw-m-in=fade, trigger=load, --pw-dur var',
    heroEl?.attrs['data-pw-m-in'] === 'fade' &&
      heroEl?.attrs['data-pw-m-trigger'] === 'load' &&
      heroEl.style.includes('--pw-dur:600ms'),
    JSON.stringify(heroEl?.attrs),
  )

  const cardsEl = await nodeAttrs(frame, cards)
  const children = await mcp.call<ChildrenGet>('design_children_get', {
    artboardId: ctx.ids.landing,
    nodeId: cards,
  })
  const [first, second] = await Promise.all(
    children.items.slice(0, 2).map((c) => nodeAttrs(frame, c.id)),
  )
  ctx.check(
    '5 cards: list announces stagger=80, children slide-up in-view with --pw-i/--pw-stagger',
    cardsEl?.attrs['data-pw-m-stagger'] === '80' &&
      first?.attrs['data-pw-m-in'] === 'slide-up' &&
      first?.attrs['data-pw-m-trigger'] === 'in-view' &&
      first.style.includes('--pw-i:0') &&
      first.style.includes('--pw-stagger:80ms') &&
      second?.style.includes('--pw-i:1') === true,
    `list=${JSON.stringify(cardsEl?.attrs)} first=${first?.style.slice(-160)}`,
  )

  const ctaEl = await nodeAttrs(frame, cta)
  ctx.check(
    '5 button: data-pw-m-hover=lift with --pw-int',
    ctaEl?.attrs['data-pw-m-hover'] === 'lift' && ctaEl.style.includes('--pw-int:'),
    JSON.stringify(ctaEl?.attrs),
  )

  const marqueeEl = await nodeAttrs(frame, marquee)
  const clones = await frame
    .locator(`[data-pw-id="${marquee}"] [data-pw-clone]`)
    .count()
    .catch(() => 0)
  ctx.log(`marquee clones in the edit frame: ${clones}`)
  ctx.check(
    '5 strip: data-pw-m-loop=marquee with --pw-loop-dur',
    marqueeEl?.attrs['data-pw-m-loop'] === 'marquee' &&
      marqueeEl.style.includes('--pw-loop-dur:12000ms'),
    JSON.stringify(marqueeEl?.attrs),
  )

  const imageEl = await nodeAttrs(frame, image)
  ctx.check(
    '5 image: data-pw-m-par=0.15 with --pw-par',
    imageEl?.attrs['data-pw-m-par'] === '0.15' && imageEl.style.includes('--pw-par:0.15'),
    JSON.stringify(imageEl?.attrs),
  )

  // The user's style is never touched: the variables live after it.
  const userStyleFirst =
    !!heroEl && heroEl.style.indexOf('display:flex') < heroEl.style.indexOf('--pw-dur')
  ctx.check('5 --pw-* variables appended after the user style', userStyleFirst)

  const summary = await mcp.call<{ text?: string }>('design_tree_summary', {
    artboardId: ctx.ids.landing,
    depth: 2,
  })
  const text = typeof summary === 'string' ? summary : (summary.text ?? JSON.stringify(summary))
  ctx.check(
    '5 tree_summary names the motion',
    /fade|slide-up|lift|marquee/.test(text),
    text.split('\n').find((l) => /fade|slide-up/.test(l)) ?? text.slice(0, 200),
  )
}

export async function step6InitialVsFinal(ctx: V2Ctx): Promise<void> {
  const initial = await shotViaTool(ctx, 'landing', '06-motion-initial', {
    motion: 'initial',
  })
  const final = await shotViaTool(ctx, 'landing', '06-motion-final', {
    motion: 'final',
  })
  ctx.check(
    "6 design_screenshot motion:'initial' vs 'final' differ",
    initial.png.length > 0 && final.png.length > 0 && !initial.png.equals(final.png),
    `initial=${initial.png.length}B final=${final.png.length}B`,
  )
}

export async function step10Export(ctx: V2Ctx): Promise<void> {
  const res = await ctx.mcp.call<{
    data: string
    width: number
    height: number
  }>('design_export', { artboardId: ctx.ids.landing, format: 'html' })
  const html = res.data ?? ''
  const standalone = html.toLowerCase().startsWith('<!doctype') && !html.includes('data-pw-id')
  const motion =
    html.includes('id="pw-motion"') &&
    html.includes('data-pw-m-in="fade"') &&
    html.includes('data-pw-m-loop="marquee"') &&
    /<script>[^<]*pw-m-play[^<]*<\/script>/.test(html)
  ctx.check(
    '10 export html: standalone, pw-motion sheet + minimal script, no data-pw-id',
    standalone && motion,
    `len=${html.length} standalone=${standalone} motion=${motion} size=${res.width}×${res.height}`,
  )
}
