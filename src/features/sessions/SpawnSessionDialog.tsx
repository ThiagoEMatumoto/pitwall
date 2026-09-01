import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { featuresApi } from '@/lib/ipc'
import { MotherSessionPicker } from '@/features/handoffs/MotherSessionPicker'
import { FeaturePicker } from '@/features/features/FeaturePicker'
import { suggestFeatures } from '@/features/features/fuzzy'
import { STATUS_META } from '@/features/features/status'
import {
  clearRepoSessionDefaults,
  loadRepoSessionDefaults,
  saveRepoSessionDefaults,
  useSessionPrefsStore,
  type RepoSessionDefaults,
} from '@/lib/session-prefs-store'
import { setNextPaneMode, type PaneMode } from '@/store/appStore'
import { PERMISSION_OPTIONS } from './permission-modes'
import { MODEL_OPTIONS, EFFORT_OPTIONS, ADVISOR_OPTIONS } from './spawn-options'
import { WORK_MODE_PRESETS } from './work-mode-presets'
import type {
  AdvisorModel,
  EffortLevel,
  FeatureWithStats,
  PermissionMode,
  Repo,
} from '../../../shared/types/ipc'

const PANE_MODE_OPTIONS = [
  { value: 'terminal', label: 'Terminal' },
  { value: 'chat', label: 'Chat' },
] as const satisfies readonly { value: PaneMode; label: string }[]

interface Props {
  open: boolean
  onClose: () => void
  repo: Repo
  // Feature já existente neste projeto (filtradas por projeto do repo).
  // Confirmar dispara o spawn com name, featureId, model, effort, permission,
  // advisorModel e initialCommand (este último só vem de um preset, ex. Ultracode).
  onConfirm: (
    name: string | undefined,
    featureId: string | undefined,
    model: string | undefined,
    effort: EffortLevel | undefined,
    permission: PermissionMode,
    advisorModel: AdvisorModel | undefined,
    initialCommand: string | undefined,
  ) => void
  // Saída ALTERNATIVA: abrir como sessão-filha de handoff em vez de aba. A
  // presença do callback é o que habilita a opção no diálogo — caller que não
  // sabe criar filha simplesmente não a oferece (evita um 8º parâmetro posicional
  // no onConfirm, que já está no limite).
  onConfirmChild?: (input: {
    task: string
    motherSessionId: string
    featureId: string | undefined
    permission: PermissionMode
  }) => void
  // Feature já decidida pelo caller (ex.: "Trabalhar nesta feature" no dossiê).
  // Sem ela o diálogo abre em "sem vínculo", como sempre.
  initialFeatureId?: string
}

export function SpawnSessionDialog({
  open,
  onClose,
  repo,
  onConfirm,
  onConfirmChild,
  initialFeatureId,
}: Props) {
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [features, setFeatures] = useState<FeatureWithStats[]>([])
  const [featurePickerOpen, setFeaturePickerOpen] = useState(false)
  // Vínculo explícito (a): selecionado no dropdown. '' = nenhum.
  const [selectedFeature, setSelectedFeature] = useState<string>('')
  // Modelo inicial. '' = default do claude (não passa --model).
  const [model, setModel] = useState<string>('')
  // Effort inicial. '' = default do claude (não passa --effort).
  const [effort, setEffort] = useState<'' | EffortLevel>('')
  // Modo de permissão inicial. 'default' = pergunta tudo (padrão da CLI).
  const [permission, setPermission] = useState<PermissionMode>('default')
  // Advisor tool inicial. '' = desligado (não passa --advisor).
  const [advisorModel, setAdvisorModel] = useState<'' | AdvisorModel>('')
  // Display inicial do painel da sessão (terminal cru ou chat renderizado).
  const [paneMode, setPaneMode] = useState<PaneMode>('terminal')
  // Slash command a injetar no boot — só preenchido por um preset (ex. Ultracode).
  const [initialCommand, setInitialCommand] = useState('')
  // Só pra destacar o botão do preset escolhido; ajustes manuais depois não o desmarcam.
  const [selectedPreset, setSelectedPreset] = useState<string>('default')
  // Nasce como filha de handoff (painel lateral) em vez de aba. A tarefa é
  // obrigatória: é dela que sai o escopo do apelido — e o apelido é o endereço do
  // peer, então "sessão filha sem tarefa" não tem como se chamar.
  const [asChild, setAsChild] = useState(false)
  const [childTask, setChildTask] = useState('')
  const [motherSessionId, setMotherSessionId] = useState<string | null>(null)
  // bypassPermissions é destrutivo (pula TODAS as permissões): exige um 2º clique.
  const [confirmingBypass, setConfirmingBypass] = useState(false)
  // Defaults efetivos no open: override do repo (se houver) sobre os globais.
  // Guardados pra "Padrão" (preset) reverter pro mesmo estado do open.
  const [effectiveDefaults, setEffectiveDefaults] = useState<RepoSessionDefaults | null>(null)
  const [hasRepoDefaults, setHasRepoDefaults] = useState(false)
  const [saveAsRepoDefault, setSaveAsRepoDefault] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  function applyDefaults(d: RepoSessionDefaults) {
    setModel(d.model)
    setEffort(d.effort)
    setPermission(d.permission)
    setAdvisorModel(d.advisor)
    setPaneMode(d.paneMode)
  }

  // Aplica os overrides do preset aos controles — o usuário ainda pode ajustar
  // cada um manualmente depois (mesmo espírito do pré-preenchimento de defaults).
  // Campo ausente no preset = NÃO mexe no controle (contrato documentado em
  // work-mode-presets.ts); só "Padrão" é especial e reverte tudo pros defaults
  // efetivos (override do repo > defaults globais persistidos).
  function applyPreset(id: string) {
    setSelectedPreset(id)
    const preset = WORK_MODE_PRESETS.find((p) => p.id === id)
    if (!preset) return
    if (id === 'default') {
      const { defaultModel, defaultEffort, defaultPermission, defaultAdvisor, defaultPaneMode } =
        useSessionPrefsStore.getState()
      applyDefaults(
        effectiveDefaults ?? {
          model: defaultModel,
          effort: defaultEffort,
          permission: defaultPermission,
          advisor: defaultAdvisor,
          paneMode: defaultPaneMode,
        },
      )
      setInitialCommand('')
      return
    }
    if (preset.model !== undefined) setModel(preset.model)
    if (preset.effort !== undefined) setEffort(preset.effort)
    if (preset.permission !== undefined) setPermission(preset.permission)
    if (preset.advisorModel !== undefined) setAdvisorModel(preset.advisorModel)
    if (preset.initialCommand !== undefined) setInitialCommand(preset.initialCommand)
  }

  useEffect(() => {
    if (!open) return
    setName('')
    setObjective('')
    setSelectedFeature(initialFeatureId ?? '')
    setConfirmingBypass(false)
    setInitialCommand('')
    setSelectedPreset('default')
    setSaveAsRepoDefault(false)
    setAsChild(false)
    setChildTask('')
    setMotherSessionId(null)
    // Pré-preenche modelo + effort + permissão + advisor: override do repo
    // (app_prefs session.defaults.<repoId>) > defaults globais (Settings).
    void Promise.all([
      useSessionPrefsStore.getState().load(),
      loadRepoSessionDefaults(repo.id),
    ]).then(([, repoDefaults]) => {
      const { defaultModel, defaultEffort, defaultPermission, defaultAdvisor, defaultPaneMode } =
        useSessionPrefsStore.getState()
      const effective = repoDefaults ?? {
        model: defaultModel,
        effort: defaultEffort,
        permission: defaultPermission,
        advisor: defaultAdvisor,
        paneMode: defaultPaneMode,
      }
      setEffectiveDefaults(effective)
      setHasRepoDefaults(repoDefaults !== null)
      applyDefaults(effective)
    })
    // Features ligadas a este repo (linkagem (a) filtrada por repo). Vem com
    // stats porque o picker ordena por atividade REAL (último session record).
    void featuresApi.listWithStats().then((all) => {
      setFeatures(all.filter((f) => f.repos.some((l) => l.repoId === repo.id)))
    })
    setFeaturePickerOpen(false)
    setTimeout(() => nameRef.current?.focus(), 0)
  }, [open, repo.id, initialFeatureId])

  function clearRepoDefaults() {
    void clearRepoSessionDefaults(repo.id).then(() => {
      setHasRepoDefaults(false)
      const { defaultModel, defaultEffort, defaultPermission, defaultAdvisor, defaultPaneMode } =
        useSessionPrefsStore.getState()
      const globals: RepoSessionDefaults = {
        model: defaultModel,
        effort: defaultEffort,
        permission: defaultPermission,
        advisor: defaultAdvisor,
        paneMode: defaultPaneMode,
      }
      setEffectiveDefaults(globals)
      applyDefaults(globals)
    })
  }

  // Fuzzy-match (b): sugestões a partir do objetivo livre, client-side.
  const suggestions = useMemo(() => {
    if (!objective.trim()) return []
    return suggestFeatures(objective, features)
  }, [objective, features])

  // Vínculo efetivo: o explícito vence; senão a melhor sugestão se o usuário
  // aceitou (clicar numa sugestão seta selectedFeature).
  const featureId = selectedFeature || undefined
  const selectedFeatureItem = features.find((f) => f.id === selectedFeature) ?? null

  function pickPermission(v: PermissionMode) {
    setPermission(v)
    setConfirmingBypass(false)
  }

  function confirm() {
    // bypassPermissions pula todas as permissões — pede um 2º clique de confirmação.
    if (permission === 'bypassPermissions' && !confirmingBypass) {
      setConfirmingBypass(true)
      return
    }
    // Filha de handoff: não vira aba (nasce em background, no painel lateral), o
    // nome vem do apelido resolvido no main e modelo/esforço não chegam ao spawn
    // de background — por isso o caminho curto aqui, sem setNextPaneMode.
    if (asChild && onConfirmChild) {
      const task = childTask.trim()
      if (!task || !motherSessionId) return
      onConfirmChild({ task, motherSessionId, featureId, permission })
      onClose()
      return
    }
    if (saveAsRepoDefault) {
      void saveRepoSessionDefaults(repo.id, {
        model: model as RepoSessionDefaults['model'],
        effort,
        permission,
        advisor: advisorModel,
        paneMode,
      })
    }
    // O diálogo não conhece o paneId (quem spawna é o caller); o appStore consome
    // esta escolha no próximo openSession.
    setNextPaneMode(paneMode)
    onConfirm(
      name.trim() || undefined,
      featureId,
      model || undefined,
      effort || undefined,
      permission,
      advisorModel || undefined,
      initialCommand || undefined,
    )
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Nova sessão · ${repo.label}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={confirm} disabled={asChild && !childTask.trim()}>
            {confirmingBypass ? 'Confirmar bypass' : asChild ? 'Abrir como filha' : 'Abrir'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-xs text-[var(--color-text-dim)]">
            Modo de trabalho
          </label>
          <div className="flex flex-wrap gap-1.5">
            {WORK_MODE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                title={preset.description}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  selectedPreset === preset.id
                    ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <Input
          ref={nameRef}
          label="Nome da sessão"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="opcional"
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm()
          }}
        />

        {onConfirmChild && (
          <div className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] p-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-dim)]">
              <input
                type="checkbox"
                data-testid="as-child-toggle"
                checked={asChild}
                onChange={(e) => setAsChild(e.target.checked)}
                className="size-3.5 accent-[var(--color-accent)]"
              />
              Abrir como sessão filha
            </label>
            {asChild && (
              <>
                <div className="w-full">
                  <label className="mb-1 block text-xs text-[var(--color-text-dim)]">
                    Tarefa da filha
                  </label>
                  <textarea
                    data-testid="child-task"
                    value={childTask}
                    onChange={(e) => setChildTask(e.target.value)}
                    placeholder="O que ela vai fazer — vira o escopo do apelido"
                    rows={2}
                    className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                  />
                </div>
                <MotherSessionPicker value={motherSessionId} onChange={setMotherSessionId} />
                <div className="text-[10px] text-[var(--color-text-dim)]">
                  A filha não abre aba: nasce no painel lateral, com apelido gerado a partir da
                  tarefa. O nome acima é ignorado.
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-4">
          <div>
            <label className="mb-1 block text-xs text-[var(--color-text-dim)]">Modelo</label>
            <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
              {MODEL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setModel(opt.value)}
                  className={`px-3 py-1.5 text-xs transition ${
                    model === opt.value
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)]'
                      : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-[var(--color-text-dim)]">Esforço</label>
            <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
              {EFFORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setEffort(opt.value)}
                  className={`px-3 py-1.5 text-xs transition ${
                    effort === opt.value
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)]'
                      : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-[var(--color-text-dim)]">Advisor</label>
            <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
              {ADVISOR_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAdvisorModel(opt.value)}
                  className={`px-3 py-1.5 text-xs transition ${
                    advisorModel === opt.value
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)]'
                      : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {advisorModel && (
              <div className="mt-1 text-[10px] text-[var(--color-text-dim)]">
                Experimental — só Anthropic API direta.
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs text-[var(--color-text-dim)]">Abrir em</label>
            <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)]">
              {PANE_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPaneMode(opt.value)}
                  className={`px-3 py-1.5 text-xs transition ${
                    paneMode === opt.value
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)]'
                      : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-[var(--color-text-dim)]">Permissão</label>
          <div className="inline-flex max-w-full flex-wrap overflow-hidden rounded-md border border-[var(--color-border)]">
            {PERMISSION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => pickPermission(opt.value)}
                className={`shrink-0 px-3 py-1.5 text-xs transition ${
                  permission === opt.value
                    ? 'bg-[var(--color-surface-2)] text-[var(--color-accent)]'
                    : 'text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {permission === 'bypassPermissions' && (
            <div className="mt-1.5 text-[11px] text-[var(--color-danger)]">
              Bypass pula TODAS as permissões — o Claude executa qualquer ação sem
              perguntar. Clique em "Confirmar bypass" para prosseguir.
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-dim)]">
            <input
              type="checkbox"
              checked={saveAsRepoDefault}
              onChange={(e) => setSaveAsRepoDefault(e.target.checked)}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            Salvar como padrão deste repo (modelo/esforço/permissão/advisor/painel)
          </label>
          {hasRepoDefaults && (
            <button
              type="button"
              onClick={clearRepoDefaults}
              className="text-[11px] text-[var(--color-text-dim)] underline decoration-dotted hover:text-[var(--color-text)]"
              title="Remove o override deste repo e volta aos defaults globais"
            >
              Padrões deste repo aplicados — limpar
            </button>
          )}
        </div>

        <div className="w-full">
          <label className="mb-1 block text-xs text-[var(--color-text-dim)]">
            Feature (opcional)
          </label>
          <div className="relative w-full">
            <button
              type="button"
              data-testid="spawn-feature-select"
              data-feature-id={selectedFeature}
              onClick={() => setFeaturePickerOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-left text-sm outline-none focus:border-[var(--color-accent)]"
            >
              <span className={selectedFeatureItem ? '' : 'text-[var(--color-text-dim)]'}>
                {selectedFeatureItem
                  ? `${selectedFeatureItem.title} (${STATUS_META[selectedFeatureItem.status].label})`
                  : '— sem vínculo —'}
              </span>
              <Icon as={ChevronDown} size={14} className="shrink-0 text-[var(--color-text-dim)]" />
            </button>
            {featurePickerOpen && (
              <FeaturePicker
                features={features}
                value={selectedFeature || null}
                onPick={(id) => {
                  setSelectedFeature(id ?? '')
                  setFeaturePickerOpen(false)
                }}
                onClose={() => setFeaturePickerOpen(false)}
                repoId={repo.id}
                allowNone
                testId="spawn-feature-picker"
              />
            )}
          </div>
        </div>

        <div className="w-full">
          <label className="mb-1 block text-xs text-[var(--color-text-dim)]">
            Objetivo da sessão
          </label>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Descreva o que vai fazer — sugerimos uma feature relacionada"
            rows={2}
            className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          {suggestions.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] text-[var(--color-text-dim)]">
                Features relacionadas:
              </div>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map(({ feature }) => {
                  const on = selectedFeature === feature.id
                  const meta = STATUS_META[feature.status]
                  return (
                    <button
                      key={feature.id}
                      type="button"
                      onClick={() => setSelectedFeature(on ? '' : feature.id)}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition ${
                        on
                          ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-text)]'
                          : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                      }`}
                      title={meta.label}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: meta.color }}
                      />
                      {feature.title}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}
