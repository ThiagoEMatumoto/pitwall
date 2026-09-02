// Ícones do tray: PNGs pré-renderizados do glifo do Pitwall (ver
// scripts/gen-tray-icons.mjs) — 22 px + representação @2x (44 px) pra HiDPI.
import { nativeImage, type NativeImage } from 'electron'
import { TRAY_ICON_PNG, type TrayIconKind } from './tray-icons.generated'

export type { TrayIconKind }

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function iconPng(kind: TrayIconKind, scale: 1 | 2): Buffer {
  return Buffer.from(scale === 1 ? TRAY_ICON_PNG[kind].x1 : TRAY_ICON_PNG[kind].x2, 'base64')
}

function buildImage(kind: TrayIconKind): NativeImage {
  const img = nativeImage.createFromBuffer(iconPng(kind, 1), { scaleFactor: 1 })
  img.addRepresentation({ scaleFactor: 2, width: 44, height: 44, buffer: iconPng(kind, 2) })
  return img
}

export function trayIcons(): Record<TrayIconKind, NativeImage> {
  return {
    idle: buildImage('idle'),
    recording: buildImage('recording'),
    recordingDim: buildImage('recordingDim'),
    detected: buildImage('detected'),
  }
}
