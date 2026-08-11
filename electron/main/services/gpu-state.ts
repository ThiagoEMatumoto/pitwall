// Estado de GPU decidido no boot, ANTES do app.whenReady (disableHardwareAcceleration
// e switches de ozone só valem pré-ready). O IPC gpu:status lê daqui o que está EM
// VIGOR neste processo — as prefs podem já ter mudado e só aplicam no próximo relaunch.

export const OZONE_PREF_KEY = 'gpu.ozoneWayland'
// Wayland nativo é o default no Linux: o hint `auto` usa Wayland quando há
// compositor e cai para X11 quando não há, então serve em qualquer sessão. Boot
// e gpu:status leem o default daqui pra não divergirem — divergência viraria um
// "requer reiniciar" fantasma na UI.
export const OZONE_PREF_DEFAULT = true

export interface GpuState {
  hwAccelDisabled: boolean
  ozoneWayland: boolean
}

let state: GpuState = { hwAccelDisabled: false, ozoneWayland: false }

export function setGpuState(next: GpuState): void {
  state = next
}

export function getGpuState(): GpuState {
  return state
}
