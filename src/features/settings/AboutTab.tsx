import { useEffect, useState } from 'react'
import { Code, Bug, MessageSquarePlus, Tag } from 'lucide-react'
import { PitwallLogo } from '@/features/brand'
import { appApi, shellApi } from '@/lib/ipc'
import type { AppInfo } from '../../../shared/types/ipc'

const REPO_URL = 'https://github.com/ThiagoEMatumoto/pitwall'
const RELEASES_URL = `${REPO_URL}/releases/latest`

function issueUrl(title: string, body: string): string {
  const params = `title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  return `${REPO_URL}/issues/new?${params}`
}

function envBlock(info: AppInfo): string {
  return [
    `- App: ${info.version}`,
    `- Plataforma: ${info.platform} (${info.arch})`,
    `- Electron: ${info.electron} / Chrome: ${info.chrome} / Node: ${info.node}`,
  ].join('\n')
}

function bugBody(info: AppInfo): string {
  return [
    '## Ambiente',
    envBlock(info),
    '',
    '## Passos para reproduzir',
    '1. ',
    '',
    '## Comportamento esperado',
    '',
    '## Comportamento atual',
    '',
  ].join('\n')
}

function feedbackBody(info: AppInfo): string {
  return [
    '## Descrição da sugestão',
    '',
    '## Contexto',
    envBlock(info),
    '',
  ].join('\n')
}

export function AboutTab({ open }: { open: boolean }) {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    if (!open) return
    void appApi.getInfo().then(setInfo)
  }, [open])

  const openExternal = (url: string) => () => void shellApi.openExternal(url)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-4">
        <PitwallLogo state="box-aberto" size={40} className="shrink-0 text-[var(--color-text)]" />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-[-0.02em] text-[var(--color-text)]">
              Pitwall
            </span>
            <span className="text-sm text-[var(--color-text-dim)]">
              v{info?.version ?? '…'}
            </span>
          </div>
          {info && (
            <div className="mt-2 space-y-0.5 text-xs text-[var(--color-text-dim)]">
              <div>
                {info.platform} · {info.arch}
              </div>
              <div>
                Electron {info.electron} · Chrome {info.chrome} · Node {info.node}
              </div>
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Projeto
        </div>
        <div className="space-y-1">
          <LinkRow icon={Code} label="Repositório no GitHub" onClick={openExternal(REPO_URL)} />
          <LinkRow icon={Tag} label="Ver releases" onClick={openExternal(RELEASES_URL)} />
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Feedback
        </div>
        <div className="space-y-1">
          <LinkRow
            icon={Bug}
            label="Reportar um bug"
            disabled={!info}
            onClick={info ? openExternal(issueUrl('[bug] ', bugBody(info))) : undefined}
          />
          <LinkRow
            icon={MessageSquarePlus}
            label="Enviar feedback / sugestão"
            disabled={!info}
            onClick={info ? openExternal(issueUrl('[sugestão] ', feedbackBody(info))) : undefined}
          />
        </div>
      </div>
    </div>
  )
}

function LinkRow({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: typeof Code
  label: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
        disabled
          ? 'cursor-not-allowed text-[var(--color-text-dim)] opacity-40'
          : 'text-[var(--color-text)] hover:bg-[var(--color-bg)]/40 hover:text-[var(--color-accent)]'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}
