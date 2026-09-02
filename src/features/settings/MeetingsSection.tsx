import { useEffect, useState } from 'react'
import { prefsApi } from '@/lib/ipc'

const AUTO_DETECT_KEY = 'meeting_auto_detect'
const AUTO_RECORD_KEY = 'meeting_auto_record'
const DIARIZATION_KEY = 'meeting_diarization'
const SUMMARY_MODEL_KEY = 'meeting_summary_model'
const AUTO_CREATE_TASKS_KEY = 'meeting_auto_create_tasks'
const MY_NAME_KEY = 'meeting_my_name'

const SUMMARY_MODELS = [
  { id: 'sonnet', label: 'Sonnet (padrão)' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
] as const
type SummaryModel = (typeof SUMMARY_MODELS)[number]['id']

function isSummaryModel(v: unknown): v is SummaryModel {
  return SUMMARY_MODELS.some((m) => m.id === v)
}

interface ToggleRowProps {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  divider?: boolean
  onChange: (v: boolean) => void
}

function ToggleRow({ label, hint, checked, disabled, divider = true, onChange }: ToggleRowProps) {
  return (
    <label
      className={`flex items-start justify-between gap-3 ${divider ? 'mt-3 border-t border-[var(--color-border)] pt-3' : ''} ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="text-sm text-[var(--color-text)]">{label}</div>
        <div className="text-xs text-[var(--color-text-dim)]">{hint}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
      />
    </label>
  )
}

export function MeetingsSection({ open }: { open: boolean }) {
  const [autoDetect, setAutoDetect] = useState(true)
  const [autoRecord, setAutoRecord] = useState(false)
  const [diarization, setDiarization] = useState(true)
  const [summaryModel, setSummaryModel] = useState<SummaryModel>('sonnet')
  const [autoCreateTasks, setAutoCreateTasks] = useState(false)
  const [myName, setMyName] = useState('')

  useEffect(() => {
    if (!open) return
    void prefsApi.get<boolean>(AUTO_DETECT_KEY).then((v) => setAutoDetect(v ?? true))
    void prefsApi.get<boolean>(AUTO_RECORD_KEY).then((v) => setAutoRecord(v ?? false))
    void prefsApi.get<boolean>(DIARIZATION_KEY).then((v) => setDiarization(v ?? true))
    void prefsApi.get<string>(SUMMARY_MODEL_KEY).then((v) => setSummaryModel(isSummaryModel(v) ? v : 'sonnet'))
    void prefsApi.get<boolean>(AUTO_CREATE_TASKS_KEY).then((v) => setAutoCreateTasks(v ?? false))
    void prefsApi.get<string>(MY_NAME_KEY).then((v) => setMyName(typeof v === 'string' ? v : ''))
  }, [open])

  function persist<T>(key: string, set: (v: T) => void) {
    return (v: T) => {
      set(v)
      void prefsApi.set(key, v)
    }
  }

  const updateAutoDetect = persist(AUTO_DETECT_KEY, setAutoDetect)
  const updateAutoRecord = persist(AUTO_RECORD_KEY, setAutoRecord)
  const updateDiarization = persist(DIARIZATION_KEY, setDiarization)
  const updateSummaryModel = persist(SUMMARY_MODEL_KEY, setSummaryModel)
  const updateAutoCreateTasks = persist(AUTO_CREATE_TASKS_KEY, setAutoCreateTasks)

  const commitMyName = () => {
    const next = myName.trim()
    setMyName(next)
    void prefsApi.set(MY_NAME_KEY, next)
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">Reuniões</div>
      <ToggleRow
        label="Detectar reuniões automaticamente (PipeWire)"
        hint="Avisa quando um app começa a usar o microfone, com a opção de gravar. Ligado por padrão."
        checked={autoDetect}
        divider={false}
        onChange={updateAutoDetect}
      />
      <ToggleRow
        label="Gravar automaticamente ao detectar"
        hint="Começa a gravação sem perguntar assim que a reunião é detectada. Desligado por padrão."
        checked={autoRecord}
        disabled={!autoDetect}
        onChange={updateAutoRecord}
      />
      <ToggleRow
        label="Diarização (identificar vozes)"
        hint="Separa quem fala no áudio do sistema e lembra vozes nomeadas entre reuniões. Ligado por padrão."
        checked={diarization}
        onChange={updateDiarization}
      />
      <ToggleRow
        label="Criar tarefas automaticamente (só as minhas)"
        hint="Cria as tarefas cujo dono sou eu sem passar pela confirmação. Desligado por padrão."
        checked={autoCreateTasks}
        onChange={updateAutoCreateTasks}
      />

      <label className="mt-3 flex items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--color-text)]">Modelo do resumo</div>
          <div className="text-xs text-[var(--color-text-dim)]">
            Modelo usado ao gerar as notas da reunião. Sonnet por padrão.
          </div>
        </div>
        <select
          value={summaryModel}
          onChange={(e) => updateSummaryModel(e.target.value as SummaryModel)}
          className="mt-0.5 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        >
          {SUMMARY_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-3 flex items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3">
        <div className="min-w-0">
          <div className="text-sm text-[var(--color-text)]">Meu nome</div>
          <div className="text-xs text-[var(--color-text-dim)]">
            Como o resumo se refere a você (no lugar de "Eu") e como reconhece as suas tarefas.
          </div>
        </div>
        <input
          type="text"
          value={myName}
          placeholder="Eu"
          onChange={(e) => setMyName(e.target.value)}
          onBlur={commitMyName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitMyName()
          }}
          className="mt-0.5 w-40 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </label>
    </div>
  )
}
