import { beforeEach, describe, expect, it, vi } from 'vitest'

const createFromBuffer = vi.fn()
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: (...args: unknown[]) => createFromBuffer(...args) },
}))

import { PNG_SIGNATURE, iconPng, trayIcons, type TrayIconKind } from './tray-icons'

const KINDS: TrayIconKind[] = ['idle', 'recording', 'recordingDim', 'detected']

/** Lê largura/altura do IHDR (primeiro chunk, logo após a assinatura de 8 bytes). */
function ihdrSize(png: Buffer): { width: number; height: number; type: string } {
  return {
    type: png.subarray(12, 16).toString('ascii'),
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  }
}

describe('iconPng (gerado por scripts/gen-tray-icons.mjs)', () => {
  it('os 4 estados têm PNG válido em 22×22 (x1) e 44×44 (x2)', () => {
    for (const kind of KINDS) {
      const x1 = iconPng(kind, 1)
      const x2 = iconPng(kind, 2)
      expect(x1.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
      expect(x2.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
      expect(ihdrSize(x1)).toEqual({ type: 'IHDR', width: 22, height: 22 })
      expect(ihdrSize(x2)).toEqual({ type: 'IHDR', width: 44, height: 44 })
      expect(x1.subarray(-8).toString('ascii')).toContain('IEND')
    }
  })

  it('os estados com badge diferem do ocioso; o pisca (dim) difere do gravando', () => {
    const idle = iconPng('idle', 1)
    expect(iconPng('recording', 1).equals(idle)).toBe(false)
    expect(iconPng('detected', 1).equals(idle)).toBe(false)
    expect(iconPng('recordingDim', 1).equals(iconPng('recording', 1))).toBe(false)
  })
})

describe('trayIcons', () => {
  beforeEach(() => createFromBuffer.mockReset())

  it('cria os quatro ícones a partir de PNG 22px e anexa a representação @2x', () => {
    const reps: unknown[] = []
    createFromBuffer.mockImplementation(() => ({
      addRepresentation: (rep: unknown) => reps.push(rep),
    }))
    const icons = trayIcons()
    expect(Object.keys(icons)).toEqual(KINDS)
    expect(createFromBuffer).toHaveBeenCalledTimes(4)
    for (const call of createFromBuffer.mock.calls) {
      const buf = call[0] as Buffer
      expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
      expect(call[1]).toEqual({ scaleFactor: 1 })
    }
    expect(reps).toHaveLength(4)
    expect(reps[0]).toMatchObject({ scaleFactor: 2, width: 44, height: 44 })
    expect(ihdrSize((reps[0] as { buffer: Buffer }).buffer).width).toBe(44)
  })
})
