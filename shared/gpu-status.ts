import type { GpuStatus } from './types/ipc'

// Desligada pelo automático e em vigor: gpu.disabled segue false e reiniciar não
// religa (o boot espera o backoff). Só desmarcar o toggle apaga o registro. Com
// CM_DISABLE_GPU=1 quem desliga é a variável, mesmo que haja registro.
export function gpuAutoOff(status: GpuStatus): boolean {
  return (
    status.hwAccelDisabled &&
    !status.envDisabled &&
    !status.prefDisabled &&
    status.autoDisabled !== null
  )
}

export function gpuDisableChecked(status: GpuStatus): boolean {
  return status.prefDisabled || gpuAutoOff(status)
}

// Sob CM_DISABLE_GPU=1 reiniciar sobe desligado de novo, qualquer que seja a pref:
// a aceleração não entra na conta.
export function gpuRestartPending(status: GpuStatus): boolean {
  const accelPending =
    !status.envDisabled && gpuDisableChecked(status) !== status.hwAccelDisabled
  return accelPending || status.prefOzone !== status.ozoneWayland
}

// Espelha o gpu:set-disabled: religar pela UI também apaga o registro automático.
export function withGpuDisabled(status: GpuStatus, disabled: boolean): GpuStatus {
  return {
    ...status,
    prefDisabled: disabled,
    autoDisabled: disabled ? status.autoDisabled : null,
  }
}
