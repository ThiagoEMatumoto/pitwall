// Easing names → CSS. Springs cannot be expressed as a cubic-bezier, so they
// are sampled into linear() (Chromium 113+); the curve is normalised to the
// animation's own duration, which the user keeps choosing.

import type { DesignEasing } from '../types/design'

// Under-damped spring position over t ∈ [0,1] (settled at t=1), sampled into
// a CSS linear() easing. zeta < 1 overshoots; omega sets how many wobbles fit.
export function springLinear(zeta: number, omega: number, samples = 24): string {
  const wd = omega * Math.sqrt(1 - zeta * zeta)
  const points: string[] = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const decay = Math.exp(-zeta * omega * t)
    const x = 1 - decay * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t))
    const value = i === samples ? 1 : Math.round(x * 1000) / 1000
    points.push(i === 0 || i === samples ? String(value) : `${value} ${Math.round(t * 100)}%`)
  }
  return `linear(${points.join(', ')})`
}

export const EASING_CSS: Record<DesignEasing, string> = {
  'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'ease-in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
  linear: 'linear',
  back: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  'spring-gentle': springLinear(0.85, 9),
  'spring-quick': springLinear(0.7, 14),
  'spring-bouncy': springLinear(0.42, 12),
}
