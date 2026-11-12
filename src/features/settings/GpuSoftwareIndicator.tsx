import { useEffect, useState } from 'react'
import { RotateCw, ZapOff } from 'lucide-react'
import { gpuApi } from '@/lib/ipc'
import { Icon, ICON_SIZE_HEADER } from '@/components/ui/Icon'
import { gpuAutoOff, gpuDisableChecked } from '../../../shared/gpu-status'
import { describeGpuAutoOff } from './gpu-auto-off-text'
import { GPU_STATUS_RETRY_MS, useGpuStatusStore } from './gpu-status-store'

// Aviso fixo no rail enquanto a GPU está desligada pelo automático: o toast do
// desligamento some e o app segue em modo software sem dizer nada. Quem desligou
// de propósito (Configurações ou CM_DISABLE_GPU=1) não vê aviso nenhum.
export function GpuSoftwareIndicator() {
  const status = useGpuStatusStore((s) => s.status)
  // Religou por aqui nesta execução: a GPU só volta depois de reiniciar.
  const [reenabled, setReenabled] = useState(false)

  // Uma escrita e a releitura que falham deixam o store em null com a GPU ainda
  // desligada no main: sem insistir, o aviso sumiria sem nada ter mudado.
  const unknown = status === null
  useEffect(() => {
    if (!unknown) return
    const load = (): void => {
      useGpuStatusStore
        .getState()
        .load()
        .catch((err) => console.warn('[gpu] o aviso do rail não leu o status:', String(err)))
    }
    load()
    const timer = setInterval(load, GPU_STATUS_RETRY_MS)
    return () => clearInterval(timer)
  }, [unknown])

  if (status === null) return null
  const record = gpuAutoOff(status) ? status.autoDisabled : null
  const restartToApply = reenabled && !gpuDisableChecked(status)
  if (record === null && !restartToApply) return null

  const label =
    record === null
      ? 'GPU religada. Clique para reiniciar o app e aplicar.'
      : `GPU desligada automaticamente ${describeGpuAutoOff(record)}. Os terminais estão mais lentos. Clique para religar.`

  async function handleClick() {
    if (record === null) {
      void gpuApi.relaunch()
      return
    }
    await useGpuStatusStore.getState().setDisabled(false)
    // A escrita pode ter falhado: só religou se o registro saiu do status.
    const after = useGpuStatusStore.getState().status
    if (after !== null && !gpuDisableChecked(after)) setReenabled(true)
  }

  return (
    <button
      type="button"
      data-testid="gpu-software-indicator"
      onClick={() => void handleClick()}
      title={label}
      aria-label={label}
      className="flex h-[38px] w-[38px] items-center justify-center rounded-[11px] text-[var(--color-warning)] transition hover:bg-[var(--color-surface-2)]/60"
    >
      <Icon as={record === null ? RotateCw : ZapOff} size={ICON_SIZE_HEADER} />
    </button>
  )
}
