import { describe, expect, it } from 'vitest'
import { MOTION_CSS, MOTION_EXPORT_JS } from './motion-css'
import { ENTRANCE_PRESETS, HOVER_PRESETS, LOOP_PRESETS } from './motion'

describe('MOTION_CSS', () => {
  it('has a rule and keyframes for every entrance preset, driven by the variables', () => {
    for (const preset of ENTRANCE_PRESETS) {
      expect(MOTION_CSS).toContain(`[data-pw-m-in="${preset}"]{animation-name:pw-in-${preset}}`)
      expect(MOTION_CSS).toContain(`@keyframes pw-in-${preset}{`)
    }
    expect(MOTION_CSS).toContain(
      '[data-pw-m-in]{animation-duration:var(--pw-dur,220ms);animation-delay:calc(var(--pw-delay,0ms) + var(--pw-i,0)*var(--pw-stagger,0ms));',
    )
    expect(MOTION_CSS).toContain('animation-fill-mode:both;animation-play-state:paused}')
    expect(MOTION_CSS).toContain('[data-pw-m-in].pw-m-play{animation-play-state:running}')
    expect(MOTION_CSS).toContain('[data-pw-m-in].pw-m-done{animation:none}')
  })

  it('covers every hover and loop preset', () => {
    for (const preset of HOVER_PRESETS) {
      expect(MOTION_CSS).toContain(`[data-pw-m-hover="${preset}"]:hover{`)
    }
    for (const preset of LOOP_PRESETS) {
      expect(MOTION_CSS).toContain(`@keyframes pw-loop-${preset}{`)
    }
    expect(MOTION_CSS).toContain(
      '[data-pw-m-loop="marquee"]>*{display:inline-block;animation:pw-loop-marquee',
    )
    expect(MOTION_CSS).toContain('var(--pw-marquee-w,100%)')
    expect(MOTION_CSS).toContain(
      '[data-pw-m-par]{will-change:translate;translate:0 calc(var(--pw-par-y,0)*1px)}',
    )
  })

  it('moves hover and parallax through translate/scale so an inline transform composes with them', () => {
    expect(MOTION_CSS).toContain('[data-pw-m-hover="lift"]:hover{translate:0 calc(-4px*var(--pw-int,1))')
    expect(MOTION_CSS).toContain('[data-pw-m-hover="scale"]:hover{scale:calc(1 + 0.04*var(--pw-int,1))}')
    expect(MOTION_CSS).not.toMatch(/\[data-pw-m-(hover|par)[^{]*\{[^}]*transform:/)
  })

  it('freezes without a runtime (final/initial), honours reduced motion, defines the view transitions', () => {
    expect(MOTION_CSS).toContain('html[data-pw-motion="final"] [data-pw-m-in]{animation:none}')
    expect(MOTION_CSS).toContain(
      'html[data-pw-motion="initial"] [data-pw-m-in]{animation-play-state:paused;animation-delay:0ms}',
    )
    expect(MOTION_CSS).toContain(
      'html[data-pw-motion] [data-pw-m-loop],html[data-pw-motion] [data-pw-m-loop]>*{animation:none}',
    )
    expect(MOTION_CSS).toContain('@media (prefers-reduced-motion:reduce){')
    for (const kind of ['fade', 'push', 'smart']) {
      expect(MOTION_CSS).toContain(`html[data-pw-vt="${kind}"]`)
    }
    expect(MOTION_CSS).toContain(
      'html[data-pw-vt="push"][data-pw-vt-dir="back"]::view-transition-old(root)',
    )
    expect(MOTION_CSS).toContain('var(--pw-vt-dur,300ms)')
    expect(MOTION_CSS).toContain('var(--pw-vt-ease,')
  })

  it('never contains "</" (it is inlined in a <style>) and matches the snapshot', () => {
    expect(MOTION_CSS).not.toContain('</')
    expect(MOTION_CSS).toMatchSnapshot()
  })
})

describe('MOTION_EXPORT_JS', () => {
  it('is a self-contained IIFE that lifts the freeze and handles the three runtime jobs', () => {
    expect(MOTION_EXPORT_JS.startsWith('(function(){')).toBe(true)
    expect(MOTION_EXPORT_JS.endsWith('})();')).toBe(true)
    expect(MOTION_EXPORT_JS).toContain("h.removeAttribute('data-pw-motion')")
    expect(MOTION_EXPORT_JS).toContain('IntersectionObserver')
    expect(MOTION_EXPORT_JS).toContain("'--pw-marquee-w'")
    expect(MOTION_EXPORT_JS).toContain("'data-pw-clone'")
    expect(MOTION_EXPORT_JS).toContain("'--pw-par-y'")
    expect(MOTION_EXPORT_JS).not.toContain('</script')
    expect(() => new Function(MOTION_EXPORT_JS)).not.toThrow()
  })
})
