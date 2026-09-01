import { useEffect, useState } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import { updatesApi } from '@/lib/ipc'
import { Icon } from '@/components/ui/Icon'
import type { UpdateFormat, UpdateStatus } from '../../../shared/types/ipc'

export function UpdateToast() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  // Só os estados 'available' e 'cancelled' carregam o format; guardamos pra
  // exibir a nota de Gatekeeper (mac) também no estado 'awaiting-install', que
  // não tem format.
  const [format, setFormat] = useState<UpdateFormat | undefined>()

  useEffect(() => {
    return updatesApi.onStatus((s) => {
      setDismissed(false)
      setStatus(s)
      if (s.state === 'available' || s.state === 'cancelled') setFormat(s.format)
    })
  }, [])

  if (!status || dismissed) return null

  const showGatekeeperNote =
    format === 'dmg' && (status.state === 'available' || status.state === 'awaiting-install')

  return (
    <div
      className="pointer-events-auto flex max-w-xs items-center gap-3 rounded-lg border px-3 py-2 text-sm shadow-lg"
      style={{
        borderColor: 'var(--color-border)',
        background: 'var(--color-bg-elevated, var(--color-surface))',
        color: 'var(--color-text)',
      }}
    >
      <Icon
        as={
          status.state === 'downloaded' ||
          status.state === 'awaiting-install' ||
          status.state === 'installed'
            ? RefreshCw
            : Download
        }
        className="shrink-0 text-[var(--color-accent)]"
      />
      <div className="flex-1">
        {renderBody(status)}
        {showGatekeeperNote && (
          <span className="mt-1 block text-xs" style={{ color: 'var(--color-text-dim)' }}>
            no mac: clique com o botão direito no app → Abrir, na 1ª vez.
          </span>
        )}
      </div>
      {(status.state === 'available' || status.state === 'cancelled') && (
        <button
          onClick={() => void updatesApi.apply()}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        >
          Atualizar
        </button>
      )}
      {status.state === 'downloaded' && (
        <button
          onClick={() => void updatesApi.install()}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        >
          Reiniciar e instalar
        </button>
      )}
      {status.state === 'installed' && (
        <button
          onClick={() => void updatesApi.install()}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        >
          Reiniciar agora
        </button>
      )}
      {status.state === 'error' && (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            onClick={() => void updatesApi.apply()}
            className="rounded px-2 py-1 text-xs font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
          >
            Tentar novamente
          </button>
          <button
            onClick={() => void updatesApi.openDownloads()}
            className="text-[11px] underline"
            style={{ color: 'var(--color-text-dim)' }}
          >
            Abrir pasta do download
          </button>
        </div>
      )}
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dispensar"
        className="flex shrink-0 items-center px-1"
        style={{ color: 'var(--color-text-dim)' }}
      >
        <Icon as={X} size={14} />
      </button>
    </div>
  )
}

function renderBody(status: UpdateStatus) {
  switch (status.state) {
    case 'available':
      return <span>atualização v{status.version} disponível</span>
    case 'downloading':
      return <span>baixando atualização… ({status.percent}%)</span>
    case 'downloaded':
      return <span>atualização v{status.version} pronta</span>
    case 'installing':
      return <span>instalando atualização v{status.version}…</span>
    case 'installed':
      return <span>atualização v{status.version} instalada — reinicie pra concluir.</span>
    case 'awaiting-install':
      return <span>instalador aberto — conclua a instalação e reabra o app.</span>
    case 'cancelled':
      return (
        <span style={{ color: 'var(--color-text-dim)' }}>
          instalação da v{status.version} não concluída — autentique para instalar.
        </span>
      )
    case 'error':
      return (
        <span style={{ color: 'var(--color-text-dim)' }}>
          falha ao atualizar: {status.message}
        </span>
      )
    default:
      return null
  }
}
