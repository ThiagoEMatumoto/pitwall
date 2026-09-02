import { useEffect, useState } from 'react'
import {
  Settings,
  Palette,
  Keyboard,
  Bell,
  Info,
  RefreshCw,
  Variable,
  MessageSquare,
  Mic,
  Plug,
} from 'lucide-react'
import { AboutTab } from './AboutTab'
import { SyncTab } from './SyncTab'
import { EnvVarsTab } from './EnvVarsTab'
import { IntegrationsTab } from './IntegrationsTab'
import { VoiceTab } from './VoiceTab'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { ColorSelect } from '@/components/ui/ColorSelect'
import { dialogApi, mcpApi, prefsApi, vaultApi } from '@/lib/ipc'
import type { McpStatus, NotificationPrefs } from '../../../shared/types/ipc'
import {
  COMMANDS,
  formatCombo,
  resolveCombo,
  type Combo,
  type Command,
  type ShortcutContext,
} from '@/lib/keybindings'
import { useKeybindingsStore } from '@/lib/keybindings-store'
import { TerminalSection } from './TerminalSection'
import { MeetingsSection } from './MeetingsSection'
import { useProjectsPrefsStore } from '@/lib/projects-prefs-store'
import { useSessionPrefsStore, type KeyboardSendMode } from '@/lib/session-prefs-store'
import { MODEL_OPTIONS, EFFORT_OPTIONS, ADVISOR_OPTIONS } from '@/features/sessions/spawn-options'
import { applyThemePref, loadThemePref, saveThemePref } from '@/app/useTheme'
import { DEFAULT_PRESET_ID, PRESETS, getPreset, type ThemePref } from '@/lib/themes'

interface Props {
  open: boolean
  onClose: () => void
}

type TabId =
  | 'general'
  | 'session'
  | 'voice'
  | 'appearance'
  | 'shortcuts'
  | 'notifications'
  | 'integrations'
  | 'env'
  | 'sync'
  | 'about'

const TABS: { id: TabId; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: 'Geral', icon: Settings },
  { id: 'session', label: 'Sessão/Chat', icon: MessageSquare },
  { id: 'voice', label: 'Voz', icon: Mic },
  { id: 'appearance', label: 'Aparência', icon: Palette },
  { id: 'shortcuts', label: 'Atalhos', icon: Keyboard },
  { id: 'notifications', label: 'Notificações', icon: Bell },
  { id: 'integrations', label: 'Integrações', icon: Plug },
  { id: 'env', label: 'Variáveis de ambiente', icon: Variable },
  { id: 'sync', label: 'Sincronização', icon: RefreshCw },
  { id: 'about', label: 'Sobre', icon: Info },
]

export function SettingsDialog({ open, onClose }: Props) {
  const [tab, setTab] = useState<TabId>('general')

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Configurações"
      widthClassName="w-[44rem]"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="flex min-h-[20rem] gap-5">
        <nav className="w-40 shrink-0 space-y-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                tab === id
                  ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)] shadow-[inset_2px_0_0_var(--color-accent)]'
                  : 'text-[var(--color-text-dim)] hover:bg-[var(--color-bg)]/40 hover:text-[var(--color-text)]'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {tab === 'general' && <GeneralTab open={open} />}
          {tab === 'session' && <SessionTab open={open} />}
          {tab === 'voice' && <VoiceTab open={open} />}
          {tab === 'appearance' && <AppearanceTab open={open} />}
          {tab === 'shortcuts' && <ShortcutsTab />}
          {tab === 'notifications' && <NotificationsTab open={open} />}
          {tab === 'integrations' && <IntegrationsTab open={open} />}
          {tab === 'env' && <EnvVarsTab open={open} />}
          {tab === 'sync' && <SyncTab open={open} />}
          {tab === 'about' && <AboutTab open={open} />}
        </div>
      </div>
    </Dialog>
  )
}

const SCRATCH_DIR_DEFAULT = '~/ClaudeManager/scratch'
const HANDOFFS_HEARTBEAT_TTL_DEFAULT = 2
const AUTO_PULL_INTERVAL_DEFAULT = 30

function GeneralTab({ open }: { open: boolean }) {
  const [root, setRoot] = useState('')
  const [scratchDir, setScratchDir] = useState('')
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null)
  const [mcpCopied, setMcpCopied] = useState(false)
  const showHandoffsInline = useProjectsPrefsStore((s) => s.showHandoffsInline)
  const setShowHandoffsInline = useProjectsPrefsStore((s) => s.setShowHandoffsInline)
  const [autoCloneMissing, setAutoCloneMissing] = useState(true)
  const [autoPullEnabled, setAutoPullEnabled] = useState(true)
  const [autoPullIntervalMinutes, setAutoPullIntervalMinutes] = useState(AUTO_PULL_INTERVAL_DEFAULT)
  const [requireApprovalHandoffs, setRequireApprovalHandoffs] = useState(false)
  const [heartbeatTtlHours, setHeartbeatTtlHours] = useState(HANDOFFS_HEARTBEAT_TTL_DEFAULT)

  useEffect(() => {
    if (!open) return
    void vaultApi.getRoot().then(setRoot)
    void prefsApi.get<string>('scratch_dir').then((dir) => setScratchDir(dir ?? ''))
    void prefsApi.get<boolean>('autoCloneMissing').then((v) => setAutoCloneMissing(v ?? true))
    void prefsApi.get<boolean>('autoPullEnabled').then((v) => setAutoPullEnabled(v ?? true))
    void prefsApi
      .get<number>('autoPullIntervalMinutes')
      .then((v) => setAutoPullIntervalMinutes(v ?? AUTO_PULL_INTERVAL_DEFAULT))
    void prefsApi
      .get<boolean>('handoffs.requireApproval')
      .then((v) => setRequireApprovalHandoffs(v ?? false))
    void prefsApi
      .get<number>('handoffs.heartbeatTtlHours')
      .then((v) => setHeartbeatTtlHours(v ?? HANDOFFS_HEARTBEAT_TTL_DEFAULT))
    void mcpApi.status().then(setMcpStatus)
    setMcpCopied(false)
    void useProjectsPrefsStore.getState().load()
  }, [open])

  function updateAutoCloneMissing(v: boolean) {
    setAutoCloneMissing(v)
    void prefsApi.set('autoCloneMissing', v)
  }

  function updateAutoPullEnabled(v: boolean) {
    setAutoPullEnabled(v)
    void prefsApi.set('autoPullEnabled', v)
  }

  function updateAutoPullInterval(v: number) {
    setAutoPullIntervalMinutes(v)
    if (Number.isFinite(v) && v >= 1) void prefsApi.set('autoPullIntervalMinutes', v)
  }

  function updateRequireApproval(v: boolean) {
    setRequireApprovalHandoffs(v)
    void prefsApi.set('handoffs.requireApproval', v)
  }

  function updateHeartbeatTtl(v: number) {
    setHeartbeatTtlHours(v)
    if (Number.isFinite(v) && v >= 1) void prefsApi.set('handoffs.heartbeatTtlHours', v)
  }

  function copyMcpCommand() {
    if (!mcpStatus?.addCommand) return
    void navigator.clipboard.writeText(mcpStatus.addCommand).then(() => {
      setMcpCopied(true)
      setTimeout(() => setMcpCopied(false), 2000)
    })
  }

  async function changeRoot() {
    const picked = await dialogApi.openDirectory()
    if (!picked) return
    await vaultApi.ensureDir(picked)
    await vaultApi.setRoot(picked)
    setRoot(picked)
  }

  async function changeScratchDir() {
    const picked = await dialogApi.openDirectory()
    if (!picked) return
    await prefsApi.set('scratch_dir', picked)
    setScratchDir(picked)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-[var(--color-text-dim)]">Pasta-raiz dos projetos</span>
          <button
            type="button"
            onClick={changeRoot}
            className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
          >
            Trocar
          </button>
        </div>
        <div className="truncate text-sm text-[var(--color-text)]" title={root || undefined}>
          {root || <span className="text-[var(--color-text-dim)]">carregando…</span>}
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-[var(--color-text-dim)]">Pasta das sessões avulsas</span>
          <button
            type="button"
            onClick={changeScratchDir}
            className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
          >
            Trocar
          </button>
        </div>
        <div
          className="truncate text-sm text-[var(--color-text)]"
          title={scratchDir || SCRATCH_DIR_DEFAULT}
        >
          {scratchDir || (
            <span className="text-[var(--color-text-dim)]">{SCRATCH_DIR_DEFAULT}</span>
          )}
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Servidor MCP
        </div>
        <div className="text-sm text-[var(--color-text)]">
          {mcpStatus === null ? (
            <span className="text-[var(--color-text-dim)]">carregando…</span>
          ) : mcpStatus.running ? (
            <>Rodando na porta {mcpStatus.port}</>
          ) : (
            'Parado (porta em uso por outra instância?)'
          )}
        </div>
        {mcpStatus?.running && mcpStatus.addCommand && (
          <div className="mt-2 border-t border-[var(--color-border)] pt-2">
            <div className="mb-1 text-xs text-[var(--color-text-dim)]">
              Sessões abertas pelo app já se conectam automaticamente. Para sessões externas do
              Claude Code:
            </div>
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1 font-mono text-xs text-[var(--color-text-dim)]"
                title={mcpStatus.addCommand}
              >
                {mcpStatus.addCommand}
              </code>
              <button
                type="button"
                onClick={copyMcpCommand}
                className="shrink-0 text-xs text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
              >
                {mcpCopied ? 'Copiado!' : 'Copiar'}
              </button>
            </div>
          </div>
        )}
      </div>

      <TerminalSection open={open} />
      <MeetingsSection open={open} />

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Projetos
        </div>
        <label className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Mostrar delegações nos projetos</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Exibe uma seção "Delegações" dentro de cada projeto na barra lateral, com os handoffs
              cujo repo-alvo pertence ao projeto. Desligado por padrão — os handoffs continuam na
              área dedicada.
            </div>
          </div>
          <input
            type="checkbox"
            checked={showHandoffsInline}
            onChange={(e) => void setShowHandoffsInline(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          />
        </label>

        <label className="mt-3 flex items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">
              Clonar repos faltantes automaticamente
            </div>
            <div className="text-xs text-[var(--color-text-dim)]">
              No boot, clona os repositórios registrados (sincronizados de outra máquina) que ainda
              não existem no disco desta, usando a origin do git. Ligado por padrão.
            </div>
          </div>
          <input
            type="checkbox"
            checked={autoCloneMissing}
            onChange={(e) => updateAutoCloneMissing(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          />
        </label>

        <label className="mt-3 flex items-start justify-between gap-3 border-t border-[var(--color-border)] pt-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Atualizar repos automaticamente</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Periodicamente busca o estado do remote (`git fetch`) de todos os repos locais e dá
              `git pull --ff-only` nos que estão limpos, pulando os que têm alterações
              não-commitadas ou commits locais adiante. Ligado por padrão.
            </div>
          </div>
          <input
            type="checkbox"
            checked={autoPullEnabled}
            onChange={(e) => updateAutoPullEnabled(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          />
        </label>

        {autoPullEnabled && (
          <label className="mt-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-[var(--color-text)]">Intervalo (minutos)</div>
              <div className="text-xs text-[var(--color-text-dim)]">
                A cada quantos minutos rodar o auto-pull.
              </div>
            </div>
            <input
              type="number"
              min={1}
              value={autoPullIntervalMinutes}
              onChange={(e) => updateAutoPullInterval(Number(e.target.value))}
              className="w-20 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]"
            />
          </label>
        )}
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Handoffs
        </div>
        <label className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">
              Exigir aprovação humana em handoffs
            </div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Desligado (padrão): a sessão-filha delegada nasce direto, e você é avisado por toast.
              Ligue para voltar ao gate — cada delegação abre um modal com o prompt editável antes
              de a filha subir.
            </div>
          </div>
          <input
            type="checkbox"
            checked={requireApprovalHandoffs}
            onChange={(e) => updateRequireApproval(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          />
        </label>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">TTL de heartbeat (horas)</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Sem progresso por mais que isto, a sessão-filha é marcada como sem heartbeat no inbox.
              (1–48)
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={48}
            step={1}
            value={heartbeatTtlHours}
            onChange={(e) => updateHeartbeatTtl(Number(e.target.value))}
            className="w-24 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-2 py-1 text-right text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      </div>
    </div>
  )
}

const SESSION_PERMISSION_OPTIONS = [
  { value: 'default', label: 'Padrão' },
  { value: 'plan', label: 'Plano' },
  { value: 'acceptEdits', label: 'Aceitar edições' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass' },
  { value: 'dontAsk', label: 'Não perguntar' },
] as const

const PANE_MODE_OPTIONS = [
  { value: 'terminal', label: 'Terminal' },
  { value: 'chat', label: 'Chat' },
] as const

const KEYBOARD_OPTIONS: { value: KeyboardSendMode; label: string; hint: string }[] = [
  { value: 'enter-sends', label: 'Enter envia', hint: 'Shift+Enter quebra linha' },
  { value: 'enter-newline', label: 'Enter quebra linha', hint: 'Cmd/Ctrl+Enter envia' },
]

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex max-w-full flex-wrap overflow-hidden rounded-md border border-[var(--color-border)]">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`shrink-0 px-3 py-1.5 text-xs transition ${
            value === opt.value
              ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)]'
              : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function SessionTab({ open }: { open: boolean }) {
  const defaultModel = useSessionPrefsStore((s) => s.defaultModel)
  const defaultEffort = useSessionPrefsStore((s) => s.defaultEffort)
  const defaultPermission = useSessionPrefsStore((s) => s.defaultPermission)
  const defaultAdvisor = useSessionPrefsStore((s) => s.defaultAdvisor)
  const keyboardMode = useSessionPrefsStore((s) => s.keyboardMode)
  const defaultPaneMode = useSessionPrefsStore((s) => s.defaultPaneMode)
  const setDefaultPaneMode = useSessionPrefsStore((s) => s.setDefaultPaneMode)
  const setDefaultModel = useSessionPrefsStore((s) => s.setDefaultModel)
  const setDefaultEffort = useSessionPrefsStore((s) => s.setDefaultEffort)
  const setDefaultPermission = useSessionPrefsStore((s) => s.setDefaultPermission)
  const setDefaultAdvisor = useSessionPrefsStore((s) => s.setDefaultAdvisor)
  const setKeyboardMode = useSessionPrefsStore((s) => s.setKeyboardMode)
  const [disableAutoCompact, setDisableAutoCompact] = useState(false)

  useEffect(() => {
    if (!open) return
    void useSessionPrefsStore.getState().load()
    void prefsApi
      .get<boolean>('session.disableAutoCompact')
      .then((v) => setDisableAutoCompact(v ?? false))
  }, [open])

  function updateDisableAutoCompact(v: boolean) {
    setDisableAutoCompact(v)
    void prefsApi.set('session.disableAutoCompact', v)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Defaults de novas sessões
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Modelo padrão</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Pré-selecionado ao abrir "Nova sessão". Padrão = sem --model.
            </div>
          </div>
          <Segmented
            options={MODEL_OPTIONS}
            value={defaultModel}
            onChange={(v) => void setDefaultModel(v)}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--color-border)] pt-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Esforço padrão</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Nível de raciocínio (--effort) pré-selecionado. Padrão = sem --effort.
            </div>
          </div>
          <Segmented
            options={EFFORT_OPTIONS}
            value={defaultEffort}
            onChange={(v) => void setDefaultEffort(v)}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--color-border)] pt-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Permissão padrão</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Modo de permissão (--permission-mode) pré-selecionado. Padrão = pergunta tudo.
            </div>
          </div>
          <Segmented
            options={SESSION_PERMISSION_OPTIONS}
            value={defaultPermission}
            onChange={(v) => void setDefaultPermission(v)}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--color-border)] pt-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Advisor padrão</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Segunda opinião (--advisor) pré-selecionada. Experimental — só Anthropic API direta.
            </div>
          </div>
          <Segmented
            options={ADVISOR_OPTIONS}
            value={defaultAdvisor}
            onChange={(v) => void setDefaultAdvisor(v)}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--color-border)] pt-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Modo padrão do painel</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Como cada sessão abre. Sessões que você já alternou manualmente mantêm a escolha.
            </div>
          </div>
          <Segmented
            options={PANE_MODE_OPTIONS}
            value={defaultPaneMode}
            onChange={(v) => void setDefaultPaneMode(v)}
          />
        </div>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Contexto
        </div>
        <label className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-[var(--color-text)]">Desabilitar auto-compact</div>
            <div className="text-xs text-[var(--color-text-dim)]">
              Impede o Claude Code de compactar o contexto sozinho quando ele enche. Vale só para
              sessões abertas a partir de agora; use `/compact` quando quiser compactar.
            </div>
          </div>
          <input
            type="checkbox"
            checked={disableAutoCompact}
            onChange={(e) => updateDisableAutoCompact(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
          />
        </label>
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Teclado do chat
        </div>
        <div className="mb-2 text-xs text-[var(--color-text-dim)]">
          Como a tecla Enter se comporta no composer (aplicado a partir do chat nativo).
        </div>
        <div className="space-y-1">
          {KEYBOARD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => void setKeyboardMode(opt.value)}
              className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition ${
                keyboardMode === opt.value
                  ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-text-dim)]'
              }`}
            >
              <span className="text-sm text-[var(--color-text)]">{opt.label}</span>
              <span className="text-xs text-[var(--color-text-dim)]">{opt.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const SWATCH_KEYS = ['bg', 'surface-2', 'accent', 'text', 'border'] as const

function AppearanceTab({ open }: { open: boolean }) {
  const [pref, setPref] = useState<ThemePref>({ presetId: DEFAULT_PRESET_ID })
  const showIntroOnBoot = useSessionPrefsStore((s) => s.showIntroOnBoot)
  const setShowIntroOnBoot = useSessionPrefsStore((s) => s.setShowIntroOnBoot)

  useEffect(() => {
    if (!open) return
    void loadThemePref().then((p) => {
      if (p) setPref(p)
    })
    void useSessionPrefsStore.getState().load()
  }, [open])

  function update(next: ThemePref) {
    setPref(next)
    applyThemePref(next)
    void saveThemePref(next)
  }

  const accent = pref.accent ?? getPreset(pref.presetId).tokens.accent

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Tema
        </div>
        <div className="grid grid-cols-2 gap-2">
          {PRESETS.map((preset) => {
            const selected = preset.id === pref.presetId
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => update({ presetId: preset.id, accent: pref.accent })}
                className={`flex items-center gap-3 rounded-md border p-3 text-left transition-colors ${
                  selected
                    ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]'
                    : 'border-[var(--color-border)] hover:border-[var(--color-text-dim)]'
                }`}
                style={{ background: preset.tokens.surface }}
              >
                <div className="flex gap-1">
                  {SWATCH_KEYS.map((k) => (
                    <span
                      key={k}
                      className="h-5 w-5 rounded-full"
                      style={{ background: preset.tokens[k] }}
                    />
                  ))}
                </div>
                <span className="text-sm" style={{ color: preset.tokens.text }}>
                  {preset.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Cor de destaque
        </div>
        <ColorSelect
          value={accent}
          onChange={(hex) => update({ presetId: pref.presetId, accent: hex })}
        />
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
          Boot
        </div>
        <Toggle
          label="Mostrar a intro do Pitwall no boot"
          checked={showIntroOnBoot}
          onChange={(v) => void setShowIntroOnBoot(v)}
        />
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => update({ presetId: DEFAULT_PRESET_ID })}>
          Restaurar padrão
        </Button>
      </div>
    </div>
  )
}

// Igualdade de Combo pra detecção de conflito (mesma chave canônica que o matcher usa).
function comboKey(c: Combo): string {
  const k = c.code ? `code:${c.code}` : c.key ? `key:${c.key.toLowerCase()}` : ''
  return `${c.mod ? 1 : 0}${c.shift ? 1 : 0}${c.alt ? 1 : 0}|${k}`
}

// Constrói um Combo a partir de um keydown (mesma lógica de prioridade do matcher:
// Backslash vira code; o resto vira key). Retorna null para press só-de-modificador.
function comboFromEvent(e: KeyboardEvent): Combo | null {
  const key = e.key
  if (key === 'Control' || key === 'Meta' || key === 'Shift' || key === 'Alt') return null
  const combo: Combo = {}
  if (e.ctrlKey || e.metaKey) combo.mod = true
  if (e.shiftKey) combo.shift = true
  if (e.altKey) combo.alt = true
  if (e.code === 'Backslash') combo.code = 'Backslash'
  else combo.key = key
  return combo
}

function ShortcutsTab() {
  const contexts: ShortcutContext[] = ['Global', 'Workspace', 'Terminal']
  const overrides = useKeybindingsStore((s) => s.overrides)
  const setOverride = useKeybindingsStore((s) => s.setOverride)
  const reset = useKeybindingsStore((s) => s.reset)

  const [capturingId, setCapturingId] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ id: string; message: string } | null>(null)

  // Em modo captura, escuta o próximo keydown e grava o override (ou avisa conflito).
  useEffect(() => {
    if (!capturingId) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturingId(null)
        return
      }
      const combo = comboFromEvent(e)
      if (!combo) return // só modificador: continua capturando
      const newKey = comboKey(combo)
      const clashing = COMMANDS.find(
        (c) =>
          c.editable && c.id !== capturingId && comboKey(resolveCombo(c.id, overrides)) === newKey,
      )
      if (clashing) {
        setConflict({ id: capturingId, message: `Conflito com "${clashing.label}"` })
        setCapturingId(null)
        return
      }
      void setOverride(capturingId, combo)
      setConflict(null)
      setCapturingId(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturingId, overrides, setOverride])

  function renderRow(cmd: Command) {
    const combo = resolveCombo(cmd.id, overrides)
    const hasOverride = cmd.id in overrides
    const capturing = capturingId === cmd.id
    return (
      <div
        key={cmd.id}
        className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--color-bg)]/40"
      >
        <span className="min-w-0 flex-1 text-[var(--color-text)]">
          {cmd.label}
          {!cmd.editable && (
            <span className="ml-2 text-xs text-[var(--color-text-dim)]">(fixo)</span>
          )}
          {conflict?.id === cmd.id && (
            <span className="ml-2 text-xs text-[var(--color-danger,#ef4444)]">
              {conflict.message}
            </span>
          )}
        </span>
        <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]/60 px-1.5 py-0.5 font-mono text-xs text-[var(--color-text-dim)]">
          {capturing ? 'Pressione…' : formatCombo(combo)}
        </kbd>
        {cmd.editable && (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setConflict(null)
                setCapturingId(capturing ? null : cmd.id)
              }}
            >
              {capturing ? 'Cancelar' : 'Editar'}
            </Button>
            {hasOverride && (
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setConflict(null)
                  void reset(cmd.id)
                }}
              >
                Restaurar
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {contexts.map((ctx) => {
        const items = COMMANDS.filter((c) => c.context === ctx)
        if (items.length === 0) return null
        return (
          <div key={ctx}>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-dim)]">
              {ctx}
            </div>
            <div className="space-y-1">{items.map(renderRow)}</div>
          </div>
        )
      })}
    </div>
  )
}

const DEFAULT_NOTIF_PREFS: NotificationPrefs = {
  enabled: true,
  sessionWaiting: true,
  usageHigh: true,
}

function NotificationsTab({ open }: { open: boolean }) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIF_PREFS)

  useEffect(() => {
    if (!open) return
    void prefsApi.get<NotificationPrefs>('notifications').then((p) => {
      if (p) setPrefs({ ...DEFAULT_NOTIF_PREFS, ...p })
    })
  }, [open])

  function update(next: NotificationPrefs) {
    setPrefs(next)
    void prefsApi.set('notifications', next)
  }

  return (
    <div className="space-y-4">
      <Toggle
        label="Ativar notificações"
        checked={prefs.enabled}
        onChange={(v) => update({ ...prefs, enabled: v })}
      />
      <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
        <Toggle
          label="Sessão aguardando você"
          checked={prefs.sessionWaiting}
          disabled={!prefs.enabled}
          onChange={(v) => update({ ...prefs, sessionWaiting: v })}
        />
        <Toggle
          label="Uso alto (janela 5h/semanal)"
          checked={prefs.usageHigh}
          disabled={!prefs.enabled}
          onChange={(v) => update({ ...prefs, usageHigh: v })}
        />
      </div>
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between rounded-md px-1 py-1 text-sm transition-opacity ${
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
      }`}
    >
      <span className="text-[var(--color-text)]">{label}</span>
      <span
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
        style={{ background: checked ? 'var(--color-accent)' : 'var(--color-border)' }}
      >
        <span
          className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
          style={{ transform: checked ? 'translateX(1.125rem)' : 'translateX(0.125rem)' }}
        />
      </span>
    </button>
  )
}
