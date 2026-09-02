import { useEffect } from 'react'
import { AppWindow, Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { useMeetingsStore } from '@/store/meetingsStore'
import type { MeetingLiveState, MeetingSetupStatus } from '../../../shared/types/ipc'
import { MeetingDetail } from './MeetingDetail'
import { MeetingList } from './MeetingList'
import { SetupBanner, setupProblems } from './SetupBanner'
import { formatDuration } from './format'
import { useElapsed } from './useElapsed'

const SHORTCUT_HINT = 'Ctrl+Shift+R'

function LevelMeter({ label, level, accent }: { label: string; level: number; accent: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, level)) * 100)
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-dim)]" title={`${label}: ${pct}%`}>
      <span className="w-20 truncate">{label}</span>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
        <span
          className="block h-full rounded-full transition-[width] duration-100"
          style={{ width: `${pct}%`, background: accent ? 'var(--color-accent)' : 'var(--color-text-dim)' }}
        />
      </span>
    </span>
  )
}

function startBlockedReason(setup: MeetingSetupStatus | null, live: MeetingLiveState | null): string | null {
  if (!setup) return null
  const problems = setupProblems(setup, live?.captureMode === 'fixture')
  return problems.length > 0 ? problems[0] : null
}

export function MeetingsArea() {
  const meetings = useMeetingsStore((s) => s.meetings)
  const selectedId = useMeetingsStore((s) => s.selectedId)
  const live = useMeetingsStore((s) => s.live)
  const setup = useMeetingsStore((s) => s.setup)
  const loading = useMeetingsStore((s) => s.loading)
  const error = useMeetingsStore((s) => s.error)
  const refresh = useMeetingsStore((s) => s.refresh)
  const select = useMeetingsStore((s) => s.select)
  const loadLive = useMeetingsStore((s) => s.loadLive)
  const checkSetup = useMeetingsStore((s) => s.checkSetup)
  const start = useMeetingsStore((s) => s.start)
  const stop = useMeetingsStore((s) => s.stop)
  const rename = useMeetingsStore((s) => s.rename)
  const remove = useMeetingsStore((s) => s.remove)
  const toggleFloating = useMeetingsStore((s) => s.toggleFloating)
  const clearError = useMeetingsStore((s) => s.clearError)
  const startEventWatch = useMeetingsStore((s) => s.startEventWatch)

  // Sem stopEventWatch no unmount: o RecordingPill da barra superior é o dono
  // da assinatura pela vida do app — parar aqui mataria o indicador global.
  useEffect(() => {
    void refresh()
    void loadLive()
    void checkSetup()
    startEventWatch()
  }, [refresh, loadLive, checkSetup, startEventWatch])

  const active = live?.active ?? null
  const elapsedMs = useElapsed(active, live?.elapsedMs ?? 0)
  const blocked = startBlockedReason(setup, live)
  const startDisabled = blocked !== null || loading

  return (
    <div className="flex h-full w-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border)] px-6 py-4">
        {active ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 animate-pulse rounded-full"
                style={{ background: 'var(--color-danger)' }}
              />
              <span className="text-lg font-semibold">
                Gravando <span className="tabular-nums">{formatDuration(elapsedMs)}</span>
              </span>
              <span className="truncate text-sm text-[var(--color-text-dim)]">· {active.title}</span>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <LevelMeter label="Eu" level={live?.levels.me ?? 0} accent />
              <LevelMeter label={active.themLabel} level={live?.levels.them ?? 0} accent={false} />
              {live && !live.sttOk && (
                <span className="text-[11px] text-[var(--color-warning)]">
                  Transcrição com erro{live.lastError ? `: ${live.lastError}` : ''}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">Reuniões</h1>
            <p className="text-sm text-[var(--color-text-dim)]">
              Grave, anote o essencial — resumo e tarefas saem sozinhos.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          {active ? (
            <Button variant="danger" onClick={() => void stop()}>
              <Icon as={Square} size={14} />
              Parar
            </Button>
          ) : (
            <span className="flex items-center gap-2" title={blocked ?? `Atalho: ${SHORTCUT_HINT}`}>
              <Button onClick={() => void start()} disabled={startDisabled}>
                <Icon as={Mic} size={14} />
                Iniciar gravação
              </Button>
              <kbd className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-dim)]">
                {SHORTCUT_HINT}
              </kbd>
            </span>
          )}
          <Button variant="ghost" onClick={() => void toggleFloating()}>
            <Icon as={AppWindow} size={14} />
            Janela flutuante
          </Button>
        </div>
      </header>

      {setup && <SetupBanner setup={setup} ignorePipewire={live?.captureMode === 'fixture'} />}

      {error && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-2 text-xs text-[var(--color-danger)]">
          <span className="truncate">{error}</span>
          <button type="button" onClick={clearError} className="shrink-0 hover:underline">
            Fechar
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
          <MeetingList
            meetings={meetings}
            selectedId={selectedId}
            activeElapsedMs={elapsedMs}
            loading={loading}
            startDisabled={startDisabled}
            onSelect={(id) => void select(id)}
            onStart={() => void start()}
            onRename={(id, title) => void rename(id, title)}
            onDelete={(id) => void remove(id)}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedId ? (
            <MeetingDetail activeElapsedMs={elapsedMs} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-sm text-[var(--color-text-dim)]">
              <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                <Icon as={Mic} size={32} />
                <p className="text-[var(--color-text)]">Selecione uma reunião ou inicie uma gravação.</p>
                <p>
                  O microfone vira “Eu” e o áudio do sistema vira o participante. A transcrição aparece ao
                  vivo; o resumo e as tarefas chegam quando você parar.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
