import { useCallback, useEffect, useRef, useState } from 'react'
import { Link2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { Select } from '@/features/objectives/ObjectiveDialog'
import { featuresApi, objectivesApi } from '@/lib/ipc'
import { navigateToObjective } from '@/lib/nav'
import type {
  FeatureLinkTargetType,
  FeatureObjectiveLink,
  ObjectiveWithProgress,
} from '../../../shared/types/ipc'

const TARGET_TYPE_LABEL: Record<FeatureLinkTargetType, string> = {
  objective: 'objetivo',
  key_result: 'KR',
}

function linkKey(link: FeatureObjectiveLink): string {
  return `${link.targetType}:${link.targetId}`
}

interface KrOption {
  id: string
  title: string
}

interface Props {
  featureId: string
  objectives: ObjectiveWithProgress[]
  krTitles: Map<string, string>
  // KR id -> objective id (Onda 2): navega pro objetivo dono quando o chip é
  // de um key_result, que não tem view própria. Nome distinto do state local
  // `krObjectiveId` do dialog (objetivo escolhido no picker de KR) abaixo.
  krToObjectiveId: Map<string, string>
  /** Muda de valor => abre o dialog de vínculo (vem da faixa de issues). */
  openSignal?: number
}

function LinkChip({
  link,
  label,
  onRemove,
  onNavigate,
}: {
  link: FeatureObjectiveLink
  label: string
  onRemove?: () => void
  // Ausente dentro do dialog de edição: navegar no meio da edição do draft
  // seria surpreendente — só os chips de exibição navegam.
  onNavigate?: () => void
}) {
  const title = `${TARGET_TYPE_LABEL[link.targetType]}: ${label}`
  const content = (
    <>
      <span className="shrink-0 font-medium text-[var(--color-accent)]">
        {TARGET_TYPE_LABEL[link.targetType]}
      </span>
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          title="Remover vínculo"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="shrink-0 rounded text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"
        >
          <Icon as={X} size={11} />
        </button>
      )}
    </>
  )

  if (onNavigate) {
    return (
      <li>
        <button
          type="button"
          onClick={onNavigate}
          title={title}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]"
        >
          {content}
        </button>
      </li>
    )
  }

  return (
    <li
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text)]"
      title={title}
    >
      {content}
    </li>
  )
}

// Seção "Objetivos" do FeatureDoc: chips dos vínculos feature → objetivo/KR e
// dialog de edição (replace-all via setObjectiveLinks, espelho do TaskDialog).
export function FeatureObjectiveLinksSection({
  featureId,
  objectives,
  krTitles,
  krToObjectiveId,
  openSignal,
}: Props) {
  const [links, setLinks] = useState<FeatureObjectiveLink[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<FeatureObjectiveLink[]>([])
  // Seleção de KR em dois passos: escolher o objetivo carrega os KRs dele
  // (mesmo fluxo do TaskDialog).
  const [krObjectiveId, setKrObjectiveId] = useState('')
  const [krOptions, setKrOptions] = useState<KrOption[]>([])
  const [saving, setSaving] = useState(false)
  const firstSignal = useRef(openSignal)

  const load = useCallback(async () => {
    setLinks(await featuresApi.listObjectiveLinks(featureId))
  }, [featureId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!krObjectiveId) {
      setKrOptions([])
      return
    }
    let alive = true
    void objectivesApi.get(krObjectiveId).then((detail) => {
      if (alive) setKrOptions(detail?.keyResults.map((kr) => ({ id: kr.id, title: kr.title })) ?? [])
    })
    return () => {
      alive = false
    }
  }, [krObjectiveId])

  const resolveLabel = useCallback(
    (link: FeatureObjectiveLink): string => {
      if (link.targetType === 'objective') {
        return (
          objectives.find((o) => o.id === link.targetId)?.title ?? TARGET_TYPE_LABEL.objective
        )
      }
      return krTitles.get(link.targetId) ?? TARGET_TYPE_LABEL.key_result
    },
    [objectives, krTitles],
  )

  const openDialog = useCallback(() => {
    setDraft(links)
    setKrObjectiveId('')
    setDialogOpen(true)
  }, [links])

  // Ignora o valor inicial: só o INCREMENTO (um clique na faixa) abre.
  useEffect(() => {
    if (openSignal === undefined || openSignal === firstSignal.current) return
    openDialog()
  }, [openSignal, openDialog])

  function addDraft(link: FeatureObjectiveLink) {
    setDraft((prev) => (prev.some((l) => linkKey(l) === linkKey(link)) ? prev : [...prev, link]))
  }

  function removeDraft(link: FeatureObjectiveLink) {
    setDraft((prev) => prev.filter((l) => linkKey(l) !== linkKey(link)))
  }

  async function handleSave() {
    if (saving) return
    setSaving(true)
    try {
      await featuresApi.setObjectiveLinks({ featureId, links: draft })
      await load()
      setDialogOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    // mt-3: mesmo ritmo de espaçamento do resto do header do FeatureDoc (Onda
    // 2 subiu esta seção pra junto do StatusBadge — único call site hoje).
    <section className="mt-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Objetivos</h2>
        <button
          type="button"
          onClick={openDialog}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text)] transition hover:bg-[var(--color-surface-2)]"
        >
          <Icon as={Link2} size={13} />
          Vincular
        </button>
      </div>

      {links.length === 0 ? (
        <p className="text-xs text-[var(--color-text-dim)]">
          Sem vínculo com objetivos ou key results.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {links.map((link) => (
            <LinkChip
              key={linkKey(link)}
              link={link}
              label={resolveLabel(link)}
              onNavigate={() =>
                navigateToObjective(
                  link.targetType === 'objective'
                    ? link.targetId
                    : (krToObjectiveId.get(link.targetId) ?? link.targetId),
                )
              }
            />
          ))}
        </ul>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Vincular a objetivos"
        widthClassName="w-[30rem]"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleSave()} loading={saving}>
              Salvar
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          {draft.length === 0 ? (
            <div className="text-[11px] text-[var(--color-text-dim)]">
              Sem vínculo — a feature fica fora do rollup de objetivos.
            </div>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {draft.map((link) => (
                <LinkChip
                  key={linkKey(link)}
                  link={link}
                  label={resolveLabel(link)}
                  onRemove={() => removeDraft(link)}
                />
              ))}
            </ul>
          )}

          <Select
            label="Adicionar vínculo a objetivo"
            value=""
            onChange={(v) => {
              if (v) addDraft({ targetType: 'objective', targetId: v })
            }}
          >
            <option value="">—</option>
            {objectives.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </Select>

          <div className="grid grid-cols-2 gap-3">
            <Select label="Objetivo do key result" value={krObjectiveId} onChange={setKrObjectiveId}>
              <option value="">—</option>
              {objectives.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </Select>
            <Select
              label="Adicionar vínculo a KR"
              value=""
              onChange={(v) => {
                if (v) addDraft({ targetType: 'key_result', targetId: v })
              }}
            >
              <option value="">
                {krObjectiveId
                  ? krOptions.length > 0
                    ? '—'
                    : 'Objetivo sem KRs'
                  : 'Escolha o objetivo'}
              </option>
              {krOptions.map((kr) => (
                <option key={kr.id} value={kr.id}>
                  {kr.title}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Dialog>
    </section>
  )
}
