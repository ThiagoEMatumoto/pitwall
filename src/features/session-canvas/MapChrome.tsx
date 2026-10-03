import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { NodeToolbar, Position, useStore } from '@xyflow/react'
import {
  ChevronDown,
  ExternalLink,
  MoreHorizontal,
  Eye,
  FolderInput,
  GitBranchPlus,
  LayoutGrid,
  Pencil,
  Plus,
  Repeat,
  SquareTerminal,
  Sparkles,
  StickyNote,
  Target,
  Trash2,
  Unlink,
  Users,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useBarPillStore } from '@/features/notifications/toast-store'
import { barPillPadding } from '@/app/toast-placement'
import { Menu } from '@/components/ui/Menu'
import { create } from 'zustand'
import { FeaturePicker } from '@/features/features/FeaturePicker'
import type { FeatureWithActivity } from '@/features/features/feature-activity'
import { featuresApi, sessionsApi } from '@/lib/ipc'
import { useSessionFeatureStore } from '@/store/sessionFeatureStore'
import type { SessionGroup } from '../../../shared/types/canvas'
import type { MapNode, NoteData, SessionCardData, UserGroupData } from './graph-to-flow'
import { canPassBaton, type MapCommands } from './useMapCommands'
import type { MapScopeMode } from './projects-view-store'
import { LANE_HEADER_H, OPEN_H } from './graph-to-flow'
import { headerBoxes, toolbarSideAtZoom } from './selection-toolbar'
import { clampMenuPosition } from './menu-position'

export interface MapAction {
  key: string
  label: string
  icon: ComponentType<LucideProps>
  onClick: () => void
  danger?: boolean
  // Ação principal: na toolbar ganha rótulo de texto, não só o ícone.
  primary?: string
  // O que o tooltip explica além do rótulo (atalho, efeito).
  hint?: string
}

const GROUP_COLORS = [
  null,
  'var(--color-accent2)',
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-danger)',
]

// A MESMA lista alimenta a toolbar contextual e o menu de contexto: as duas
// superfícies nunca divergem sobre o que dá pra fazer com o nó.
export function actionsFor(
  node: MapNode | undefined,
  cmd: MapCommands,
  groups: SessionGroup[],
  memberCounts: Map<string, number>,
): MapAction[] {
  if (!node) return []
  if (node.type === 'session') {
    const { node: s } = node.data as SessionCardData
    const inGroup = node.parentId?.startsWith('g:') ?? false
    return [
      ...(s.status !== 'ended'
        ? [
            {
              key: 'interact',
              label: 'Terminal',
              primary: 'Terminal',
              hint: 'o terminal real numa janela sobre o mapa (Enter)',
              icon: SquareTerminal,
              onClick: () => cmd.interact(s.sessionId),
            },
          ]
        : []),
      {
        key: 'child',
        label: 'Nova filha',
        primary: 'Filha',
        hint: 'delega uma tarefa a uma sessão-filha desta (Crew Dock)',
        icon: GitBranchPlus,
        onClick: () => cmd.newChildOf(s),
      },
      ...(canPassBaton(s)
        ? [
            {
              key: 'baton',
              label: s.isMother ? 'Passar o bastão da mãe…' : 'Passar o bastão',
              primary: 'Bastão',
              hint: s.isMother
                ? 'a sucessora assume a liderança das filhas, com endereço novo'
                : 'destila o contexto e sobe uma sucessora limpa',
              icon: Repeat,
              onClick: () => cmd.passBatonOf(s),
            },
          ]
        : []),
      {
        key: 'purpose',
        label: 'Editar propósito',
        hint: 'ou duplo clique no propósito do cartão',
        icon: Pencil,
        onClick: () => cmd.startEditPurpose(s.sessionId),
      },
      {
        key: 'note',
        label: 'Adicionar nota',
        primary: 'Nota',
        hint: 'presa a esta sessão; a 1ª linha aparece no cartão',
        icon: StickyNote,
        onClick: () => cmd.createNote(s.sessionId),
      },
      {
        key: 'feature',
        label: 'Mover para feature…',
        hint: 'grava a frente desta sessão; vale mais que o palpite por branch/worktree',
        icon: Target,
        onClick: () => useFeatureMoveStore.getState().open(s.sessionId, s.featureId ?? null),
      },
      ...groups
        .filter((g) => g.id !== s.groupId)
        .map((g) => ({
          key: `group:${g.id}`,
          label: `Mover para ${g.name}`,
          icon: FolderInput,
          onClick: () =>
            void cmd.moveToGroup(
              s.sessionId,
              g.id,
              30 + (memberCounts.get(g.id) ?? 0) * (OPEN_H + 16),
            ),
        })),
      ...(inGroup
        ? [
            {
              key: 'ungroup',
              label: 'Tirar do grupo',
              icon: Unlink,
              onClick: () => void cmd.moveToGroup(s.sessionId, null),
            },
          ]
        : []),
      ...(s.provider === 'claude' && s.ccSessionId
        ? [
            {
              key: 'summary',
              label: 'Resumir onde parou',
              hint: 'claude -p sob demanda',
              icon: Sparkles,
              onClick: () => cmd.summarize(s.sessionId),
            },
          ]
        : []),
      {
        key: 'peek',
        label: 'Espiar',
        primary: 'Espiar',
        hint: 'conversa renderizada (ou clique no cartão recolhido)',
        icon: Eye,
        onClick: () => cmd.peek(s),
      },
      {
        key: 'open',
        label: 'Abrir terminal',
        hint: 'ou duplo clique no cartão',
        icon: ExternalLink,
        onClick: () => cmd.openTab(s),
      },
    ]
  }
  if (node.type === 'note') {
    const { note } = node.data as NoteData
    return [
      {
        key: 'edit',
        label: 'Editar nota',
        icon: Pencil,
        onClick: () => cmd.startEditNote(note.id),
      },
      ...(note.attachedSessionId
        ? [
            {
              key: 'detach',
              label: 'Soltar da sessão',
              icon: Unlink,
              onClick: () => cmd.setNoteAttachment(note.id, null),
            },
          ]
        : []),
      {
        key: 'delete',
        label: 'Apagar nota',
        icon: Trash2,
        onClick: () => cmd.deleteNote(note.id),
        danger: true,
      },
    ]
  }
  if (node.type === 'userGroup') {
    const { group } = node.data as UserGroupData
    return [
      {
        key: 'rename',
        label: 'Renomear',
        icon: Pencil,
        onClick: () => cmd.startRenameGroup(group.id),
      },
      ...GROUP_COLORS.filter((c) => c !== group.color).map((c) => ({
        key: `color:${c ?? 'default'}`,
        label: c ? 'Cor' : 'Cor padrão',
        icon: ColorDot(c),
        onClick: () => cmd.recolorGroup(group, c),
      })),
      {
        key: 'delete',
        label: 'Apagar grupo',
        icon: Trash2,
        onClick: () => cmd.deleteGroup(group.id),
        danger: true,
      },
    ]
  }
  return []
}

function ColorDot(color: string | null): ComponentType<LucideProps> {
  return function Dot({ size = 14 }: LucideProps) {
    return (
      <span
        className="inline-block rounded-full"
        style={{
          width: Number(size) - 4,
          height: Number(size) - 4,
          background: color ?? 'var(--color-violet)',
        }}
      />
    )
  }
}

const pill =
  'pointer-events-auto flex shrink-0 items-center whitespace-nowrap gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg'
const pillButton =
  'flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'

const PLURAL = new Intl.PluralRules('pt-BR')
export function plural(n: number, one: string, other: string): string {
  return PLURAL.select(n) === 'one' ? one : other
}

// Abrir/recolher todos e organizar: ações de vez em quando, num menu só — eram
// mais duas pílulas e jogavam a barra pra duas linhas.
function ViewMenu({
  onTidy,
  onOpenAll,
  onCollapseAll,
}: {
  onTidy: () => void
  onOpenAll: () => void
  onCollapseAll: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      portal
      align="left"
      items={[
        {
          label: 'Abrir todos os cartões',
          title: 'Saída ao vivo + prompt em todos',
          onClick: onOpenAll,
        },
        {
          label: 'Recolher todos os cartões',
          title: 'Uma linha por sessão (inclusive o terminal)',
          onClick: onCollapseAll,
        },
        { label: 'Organizar em lanes', title: 'Reorganizar o mapa em lanes', onClick: onTidy },
      ]}
    >
      <button
        type="button"
        data-testid="map-view-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={pillButton}
        title="Abrir/recolher todos os cartões, organizar"
      >
        <Icon as={LayoutGrid} size={13} /> Visão
        <Icon as={ChevronDown} size={12} />
      </button>
    </Menu>
  )
}

export function MapTopBar({
  scopeMode,
  hasProject,
  onScope,
  hiddenEdges,
  onNewSession,
  onNote,
  onGroup,
  onTidy,
  onOpenAll,
  onCollapseAll,
  rightInset = 0,
  narrow = false,
  children,
}: {
  // Largura do painel Equipe/Conversas sobre o mapa: nada da barra fica embaixo.
  rightInset?: number
  // Mapa estreito (painel da mãe ou da feature aberto): o "+N" dos avisos pode
  // morar no canto da barra, que reserva a vaga dele sempre.
  narrow?: boolean
  scopeMode: MapScopeMode
  hasProject: boolean
  onScope: (mode: MapScopeMode) => void
  // Fios agregados (repoDep/feature) escondidos até um cartão entrar em foco.
  hiddenEdges: number
  onNewSession: () => void
  onNote: () => void
  onGroup: () => void
  onTidy: () => void
  onOpenAll: () => void
  onCollapseAll: () => void
  // Contadores de estado (MapStatusCounters): assinam os stores sozinhos.
  children?: ReactNode
}) {
  const barPill = useBarPillStore((s) => s.width)
  return (
    // Faixa opaca: transparente, os cartões apareciam por trás dela entre as pílulas.
    <div
      data-testid="map-top-bar"
      // @container: estreita (painel da feature ou Equipe abertos), os rótulos
      // encurtam e Nota/Grupo viram ícone — sem isso o contador caía numa 2ª linha
      // solta. O wrap fica só como último recurso: cortado, o status sumia.
      className="@container absolute left-0 right-0 top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 backdrop-blur-md"
      style={{
        background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)',
        right: rightInset,
        // O "+N" dos avisos (mapa estreito) mora no canto direito: fica de fora.
        paddingRight: barPillPadding(narrow, barPill),
      }}
    >
      <button
        type="button"
        data-testid="map-new-session"
        onClick={onNewSession}
        title="Nova sessão (N com o mapa focado)"
        className="pointer-events-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-accent)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-accent)] shadow-lg transition hover:bg-[var(--color-surface-2)]"
      >
        <Icon as={Plus} size={13} /> Nova sessão
      </button>
      <div className={pill} role="group" aria-label="Escopo do mapa">
        {(['all', 'project'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={scopeMode === mode}
            aria-label={mode === 'all' ? 'Todos os projetos' : 'Projeto selecionado'}
            disabled={mode === 'project' && !hasProject}
            onClick={() => onScope(mode)}
            title={
              mode === 'project' && !hasProject
                ? 'Selecione um projeto na barra lateral'
                : mode === 'all'
                  ? 'Sessões de todos os projetos'
                  : 'Só as sessões do projeto selecionado na barra lateral'
            }
            // Ativa: superfície elevada com borda e peso 600; inativa só texto
            // apagado — um branco levemente mais claro não dizia qual valia.
            data-active={scopeMode === mode || undefined}
            className={`${pillButton} border disabled:opacity-40 ${
              scopeMode === mode
                ? '!border-[var(--color-border)] !bg-[var(--color-surface-2)] !font-semibold !text-[var(--color-text)] shadow-sm'
                : '!border-transparent !bg-transparent !text-[var(--color-text-dim)]'
            }`}
          >
            {mode === 'all' ? (
              <>
                Todos<span className="@max-3xl:hidden"> os projetos</span>
              </>
            ) : (
              <>
                {/* Estreito: "Este projeto" ("Projeto" sozinho não dizia qual). */}
                <span className="@max-3xl:hidden">Projeto selecionado</span>
                <span className="hidden @max-3xl:inline">Este projeto</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div className={pill}>
        <button
          type="button"
          onClick={onNote}
          className={pillButton}
          title="Nova nota solta"
          aria-label="Nova nota solta"
        >
          <Icon as={StickyNote} size={13} /> <span className="@max-3xl:hidden">Nota</span>
        </button>
        <button
          type="button"
          onClick={onGroup}
          className={pillButton}
          title="Novo grupo de sessões"
          aria-label="Novo grupo de sessões"
        >
          <Icon as={Users} size={13} /> <span className="@max-3xl:hidden">Grupo</span>
        </button>
        <ViewMenu onTidy={onTidy} onOpenAll={onOpenAll} onCollapseAll={onCollapseAll} />
      </div>
      {children}
      {hiddenEdges > 0 && (
        <span
          data-testid="map-hidden-hint"
          title="Fios de mesma frente, dependência entre repos e leques de filhas aparecem ao passar o mouse ou selecionar um cartão"
          className="whitespace-nowrap rounded-full px-2 py-1 text-[11px] text-[var(--color-text-dim)] @max-3xl:hidden"
        >
          +{hiddenEdges} {plural(hiddenEdges, 'ligação', 'ligações')} no foco
        </span>
      )}
    </div>
  )
}

// Altura da toolbar (≈ pill de 34px + offset) em px de tela (= unidades do fluxo a zoom 1).
const TOOLBAR_CLEARANCE = 44
// Menor largura útil: abaixo disto os botões empilhariam um por linha.
const TOOLBAR_MIN_W = 180

// Acima do cartão, a não ser que acima dele more o cabeçalho da lane (o 1º
// cartão da coluna): ali a toolbar cobria o nome do repo/projeto — e, mais
// larga que o cartão, o da lane vizinha. Então vira pra baixo.
export function toolbarPositionFor(
  node: { parentId?: string; position: { y: number } } | undefined,
): Position {
  if (!node?.parentId) return Position.Top
  return node.position.y < LANE_HEADER_H + TOOLBAR_CLEARANCE ? Position.Bottom : Position.Top
}

// Flutua junto ao nó selecionado (NodeToolbar segue pan/zoom): fixa no topo do
// mapa ela cobria o título dos cartões da primeira linha.
export function SelectionToolbar({
  nodeId,
  actions,
  position = Position.Top,
  onMore,
}: {
  nodeId: string | null
  actions: MapAction[]
  position?: Position
  // "⋯ Mais": o menu de contexto completo, ancorado no botão.
  onMore: (at: { x: number; y: number }) => void
}) {
  // Não passa da largura do cartão na tela: quebra em linhas em vez de invadir
  // a lane do lado.
  const screenW = useStore((s) => {
    const n = nodeId ? s.nodeLookup.get(nodeId) : undefined
    const w = n?.measured.width ?? n?.width ?? 0
    return Math.round(w * s.transform[2])
  })
  // Anti-colisão: com o cabeçalho de grupo/lane/feature acima, vira pra baixo.
  const side = useStore((s) => {
    const n = nodeId ? s.nodeLookup.get(nodeId) : undefined
    if (!n) return null
    const zoom = s.transform[2] || 1
    const boxOf = (m: typeof n) => ({
      x: m.internals.positionAbsolute.x,
      y: m.internals.positionAbsolute.y,
      w: m.measured.width ?? m.width ?? 0,
      h: m.measured.height ?? m.height ?? 0,
    })
    const headers = headerBoxes(
      [...s.nodeLookup.values()].map((m) => ({
        type: m.type,
        box: boxOf(m),
        headerH: (m.data as { headerH?: number } | undefined)?.headerH,
      })),
      LANE_HEADER_H,
    )
    return toolbarSideAtZoom(boxOf(n), headers, zoom, {
      clearance: TOOLBAR_CLEARANCE,
      minW: TOOLBAR_MIN_W,
    })
  })
  const finalPosition = side ? (side === 'bottom' ? Position.Bottom : Position.Top) : position
  if (!nodeId || actions.length === 0) return null
  // Só as principais, sempre com rótulo (ícone solto ninguém decifra); o resto
  // mora no "⋯ Mais", que é o mesmo menu do clique direito.
  const primary = actions.filter((a) => a.primary)
  const shown = primary.length > 0 ? primary : actions
  const hidden = actions.length > shown.length
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={finalPosition} offset={8}>
      <div
        data-testid="map-selection-toolbar"
        data-position={finalPosition}
        // Fundo levemente translúcido: virada pra baixo ela pode passar sobre o
        // título do cartão de baixo, que continua legível por trás.
        className={`${pill} flex-wrap justify-center !rounded-[18px] !bg-[color-mix(in_srgb,var(--color-surface)_86%,transparent)]`}
        style={{ maxWidth: Math.max(screenW, TOOLBAR_MIN_W) }}
      >
        {shown.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            title={a.hint ? `${a.label} — ${a.hint}` : a.label}
            data-testid={`map-action-${a.key}`}
            className={`${pillButton} ${a.danger ? 'hover:!text-[var(--color-danger)]' : ''} !text-[var(--color-text)]`}
          >
            <Icon as={a.icon} size={14} />
            {a.primary ?? a.label}
          </button>
        ))}
        {hidden && (
          <button
            type="button"
            data-testid="map-action-more"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              onMore({ x: r.left, y: r.bottom + 4 })
            }}
            title="Mais ações (o mesmo menu do clique direito)"
            className={pillButton}
          >
            <Icon as={MoreHorizontal} size={14} /> Mais
          </button>
        )}
      </div>
    </NodeToolbar>
  )
}

export function MapContextMenu({
  at,
  actions,
  onClose,
}: {
  at: { x: number; y: number }
  actions: MapAction[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos(
      clampMenuPosition(
        at,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    )
  }, [at, actions.length])
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  if (actions.length === 0) return null
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[900] min-w-[190px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-[12px] shadow-xl"
      style={{ left: pos.x, top: pos.y }}
    >
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose()
            a.onClick()
          }}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-[var(--color-surface-2)] ${
            a.danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'
          }`}
        >
          <Icon as={a.icon} size={13} />
          {a.label}
        </button>
      ))}
    </div>
  )
}

// "Mover para feature…": o menu/toolbar abre, o picker flutua junto do cartão.
interface FeatureMoveState {
  target: { sessionId: string; featureId: string | null } | null
  open: (sessionId: string, featureId: string | null) => void
  close: () => void
}

export const useFeatureMoveStore = create<FeatureMoveState>((set) => ({
  target: null,
  open: (sessionId, featureId) => set({ target: { sessionId, featureId } }),
  close: () => set({ target: null }),
}))

// Busca no workspace inteiro (sem recorte de repo): a feature junta repos de
// projetos diferentes. Grava sessions.feature_id pelo mesmo IPC do header.
export function MapFeatureMovePicker() {
  const target = useFeatureMoveStore((s) => s.target)
  const close = useFeatureMoveStore((s) => s.close)
  const note = useSessionFeatureStore((s) => s.note)
  const forget = useSessionFeatureStore((s) => s.forget)
  const [features, setFeatures] = useState<FeatureWithActivity[]>([])
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!target) return
    void featuresApi.listWithStats().then(setFeatures)
    const card = document
      .querySelector(`.react-flow__node[data-id="s:${CSS.escape(target.sessionId)}"]`)
      ?.getBoundingClientRect()
    const x = Math.min(card ? card.left : 200, window.innerWidth - 320)
    const y = Math.min(card ? card.top + 40 : 160, window.innerHeight - 320)
    setAt({ x: Math.max(8, x), y: Math.max(8, y) })
  }, [target])
  if (!target || !at) return null
  return (
    <div
      data-testid="map-feature-move"
      className="fixed z-[950] w-72"
      style={{ left: at.x, top: at.y }}
    >
      <div className="relative">
        <FeaturePicker
          features={features}
          value={target.featureId}
          testId="map-feature-picker"
          allowNone
          onClose={close}
          onPick={(featureId) => {
            close()
            // Grava mesmo quando é a feature atual: confirmar o que a heurística
            // pôs torna o vínculo do usuário (a resolução contínua não o move
            // mais). `null` desfaz e também fica como escolha do usuário.
            void sessionsApi.setFeature(target.sessionId, featureId).then(() => {
              if (featureId) note(target.sessionId, featureId)
              else forget(target.sessionId)
            })
          }}
        />
      </div>
    </div>
  )
}
