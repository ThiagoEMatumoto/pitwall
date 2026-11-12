import type { GpuStatus } from './types/ipc'

export function gpuDisableChecked(status: GpuStatus): boolean {
  return status.prefDisabled
}

export function gpuRestartPending(status: GpuStatus): boolean {
  return (
    gpuDisableChecked(status) !== status.hwAccelDisabled ||
    status.prefOzone !== status.ozoneWayland
  )
}

export function withGpuDisabled(status: GpuStatus, disabled: boolean): GpuStatus {
  return { ...status, prefDisabled: disabled }
}
