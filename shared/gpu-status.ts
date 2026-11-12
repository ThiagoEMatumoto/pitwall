import type { GpuStatus } from './types/ipc'

// Desligada pelo automático e em vigor: gpu.disabled segue false e reiniciar não
// religa (o boot espera o backoff). Só desmarcar o toggle apaga o registro.
export function gpuAutoOff(status: GpuStatus): boolean {
  return status.hwAccelDisabled && !status.prefDisabled && status.autoDisabled !== null
}

export function gpuDisableChecked(status: GpuStatus): boolean {
  return status.prefDisabled || gpuAutoOff(status)
}

export function gpuRestartPending(status: GpuStatus): boolean {
  return (
    gpuDisableChecked(status) !== status.hwAccelDisabled ||
    status.prefOzone !== status.ozoneWayland
  )
}

// Espelha o gpu:set-disabled: religar pela UI também apaga o registro automático.
export function withGpuDisabled(status: GpuStatus, disabled: boolean): GpuStatus {
  return {
    ...status,
    prefDisabled: disabled,
    autoDisabled: disabled ? status.autoDisabled : null,
  }
}
