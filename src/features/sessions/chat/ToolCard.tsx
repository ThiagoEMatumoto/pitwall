import { useRef, useState } from 'react'
import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  AlertTriangle,
  Bot,
  CornerDownRight,
  FilePen,
  FileText,
  Globe,
  Layers,
  Loader,
  OctagonX,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { CopyButton } from '@/components/ui/CopyButton'
import { DiffBlock } from './PermissionCard'
import { Chevron, ROW_BUTTON } from './chat-row-ui'
import { ThinkingCard } from './ThinkingCard'
import { toolEntries, type GroupEntry, type ToolEntry } from './chat-rows'
import { oneLine, previewLines, summarizeTools, toolDiff, toolView, type ToolCategory } from './tool-view'

const CATEGORY_ICON: Record<ToolCategory, ComponentType<LucideProps>> = {
  read: FileText,
  edit: FilePen,
  bash: Terminal,
  search: Search,
  web: Globe,
  task: Bot,
  other: Wrench,
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// Saída longa abre nas primeiras linhas: o card não vira um muro de texto.
const OUTPUT_PREVIEW_LINES = 12

function OutputBlock({ content, isError }: { content: string; isError?: boolean }) {
  const [all, setAll] = useState(false)
  const { shown, hidden } = previewLines(content, OUTPUT_PREVIEW_LINES)
  if (content.trim() === '') {
    return <div className="px-1 text-xs text-[var(--color-text-dim)]">Sem saída.</div>
  }
  return (
    <div
      className={`group/out relative overflow-hidden rounded-lg border bg-[var(--color-bg)] ${
        isError
          ? 'border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)]'
          : 'border-[var(--color-border)]'
      }`}
    >
      <CopyButton
        text={content}
        className="absolute right-1.5 top-1.5 opacity-0 transition group-hover/out:opacity-100 focus-visible:opacity-100"
        size={11}
      />
      <pre
        className={`max-h-96 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed ${
          isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]/85'
        }`}
      >
        {all ? content : shown}
      </pre>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className="w-full border-t border-[var(--color-border)] px-3 py-1 text-left text-[11px] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          {all ? 'Mostrar menos' : `Mostrar mais ${hidden} ${hidden === 1 ? 'linha' : 'linhas'}`}
        </button>
      )}
    </div>
  )
}

function CommandBlock({ command }: { command: string }) {
  return (
    <div className="group/cmd relative rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <CopyButton
        text={command}
        className="absolute right-1.5 top-1.5 opacity-0 transition group-hover/cmd:opacity-100 focus-visible:opacity-100"
        size={11}
      />
      <pre className="overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-text)]">
        <span className="select-none text-[var(--color-accent)]">$ </span>
        {command}
      </pre>
    </div>
  )
}

// Selo de "não rodou até o fim": warning, nunca o cinza de um card comum.
function InterruptedBadge({ label }: { label: string }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-warning)]/50 px-1 text-[10px] text-[var(--color-warning)]"
      title="Este turno foi interrompido (Ctrl+C) — a ferramenta não chegou ao fim."
    >
      <Icon as={OctagonX} size={10} />
      {label}
    </span>
  )
}

function RowStatus({ entry, running }: { entry: ToolEntry; running?: boolean }) {
  const { use, result } = entry
  if (use.interrupted) return <InterruptedBadge label="não executou" />
  if (result?.interrupted) return <InterruptedBadge label="interrompido" />
  if (result?.isError) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-danger)]">
        <Icon as={AlertTriangle} size={11} />
        falhou
      </span>
    )
  }
  if (!result && running) {
    return (
      <Icon
        as={Loader}
        size={12}
        aria-label="rodando"
        className="shrink-0 animate-spin text-[var(--color-accent)] motion-reduce:animate-none"
      />
    )
  }
  return null
}

// O transcript é reparseado a cada broadcast: o input chega como objeto novo
// mesmo sem mudar. A chave estável é o id do tool_use (o input serializado só
// se a CLI não gravou id).
function toolKey(use: ToolEntry['use']): string {
  if (use.id) return `${use.name}:${use.id}`
  try {
    return `${use.name}:${JSON.stringify(use.input)}`
  } catch {
    return `${use.name}:${String(use.input)}`
  }
}

function useCached<T>(key: string, compute: () => T): T {
  const ref = useRef<{ key: string; value: T } | null>(null)
  if (ref.current?.key !== key) ref.current = { key, value: compute() }
  return ref.current.value
}

// Uma chamada de ferramenta com o seu resultado: linha fechada diz o que foi
// feito e em quê; aberta mostra o comando/diff e a saída. `open`/`onToggle`
// vêm do grupo (que guarda o estado por chamada); sozinha, a linha se vira.
export function ToolRow({
  entry,
  running,
  open: openProp,
  onToggle,
}: {
  entry: ToolEntry
  running?: boolean
  open?: boolean
  onToggle?: () => void
}) {
  const [openLocal, setOpenLocal] = useState(false)
  const open = openProp ?? openLocal
  const toggle = onToggle ?? (() => setOpenLocal((o) => !o))
  const { use, result } = entry
  const key = toolKey(use)
  const view = useCached(key, () => toolView(use.name, use.input))
  // LCS só com a linha aberta: a fechada mostra o +N −M da contagem linear.
  const diff = useCached(open && view.hasDiff ? key : '', () =>
    open && view.hasDiff ? toolDiff(use.name, use.input) : undefined,
  )
  const showInput = !view.command && !view.hasDiff && view.category !== 'read'
  // "The file … has been updated" não diz nada que o diff já não mostre.
  const showOutput = result != null && (view.category !== 'edit' || result.isError)
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className={ROW_BUTTON}
        title={view.command ?? (view.target || undefined)}
      >
        <Chevron open={open} />
        <Icon
          as={CATEGORY_ICON[view.category]}
          size={13}
          className={`shrink-0 ${result?.isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-dim)]'}`}
        />
        <span className="shrink-0 font-medium text-[var(--color-text)]">{view.label}</span>
        {view.target && (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-text)]/80">
            {view.target}
          </span>
        )}
        {view.meta && (
          <span className="min-w-0 shrink truncate text-[var(--color-text-dim)]">{view.meta}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center pl-2">
          <RowStatus entry={entry} running={running} />
        </span>
      </button>
      {open && (
        <div className="chat-reveal mb-2 ml-6 mt-1 flex flex-col gap-2">
          {view.command && <CommandBlock command={view.command} />}
          {diff && diff.length > 0 && <DiffBlock lines={diff} />}
          {showInput && <OutputBlock content={pretty(use.input)} />}
          {showOutput && <OutputBlock content={result.content} isError={result.isError} />}
          {!result && !running && (
            <div className="px-1 text-xs text-[var(--color-text-dim)]">
              Sem resultado no transcript.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Sequência de chamadas seguidas. Com uma só, a linha basta; com várias, um
// resumo ("Leu 6 arquivos · rodou 3 comandos") que abre a lista sob demanda.
// A árvore é a mesma nos dois casos (o resumo só entra acima da lista), então
// quando a 2ª chamada chega a linha aberta não desmonta; e o grupo nasce
// expandido se havia uma linha aberta, pra não esconder o que se estava lendo.
export function ToolGroup({ entries, running }: { entries: GroupEntry[]; running?: boolean }) {
  const tools = toolEntries(entries)
  const multi = tools.length >= 2
  const [expanded, setExpanded] = useState(false)
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [wasMulti, setWasMulti] = useState(multi)
  if (wasMulti !== multi) {
    setWasMulti(multi)
    if (multi && openKeys.size > 0) setExpanded(true)
  }
  const toggleRow = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const errors = tools.filter((t) => t.result?.isError).length
  const pending = running ? tools.filter((t) => !t.result) : []
  const current = pending[pending.length - 1]
  const live = current ? toolView(current.use.name, current.use.input) : null
  const showList = !multi || expanded
  return (
    <div className="min-w-0">
      {multi && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((o) => !o)}
          className={ROW_BUTTON}
        >
          <Chevron open={expanded} />
          <Icon as={Layers} size={13} className="shrink-0 text-[var(--color-text-dim)]" />
          <span className="shrink-0 font-medium text-[var(--color-text)]">
            {summarizeTools(tools.map((t) => t.use.name))}
          </span>
          {errors > 0 && (
            <span className="shrink-0 text-[var(--color-danger)]">
              · {errors === 1 ? '1 erro' : `${errors} erros`}
            </span>
          )}
          {live && (
            <span className="min-w-0 truncate text-[var(--color-text-dim)]">
              · agora: {live.label.toLowerCase()} <span className="font-mono">{live.target}</span>
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[var(--color-text-dim)]">
            {live && (
              <Icon
                as={Loader}
                size={12}
                aria-label="rodando"
                className="animate-spin text-[var(--color-accent)] motion-reduce:animate-none"
              />
            )}
            <span className="tabular-nums">{tools.length}</span>
          </span>
        </button>
      )}
      {showList && (
        <div className={`flex min-w-0 flex-col ${multi ? 'chat-reveal ml-4 mt-0.5' : ''}`}>
          {/* Chamadas paralelas: todas as que ainda não têm resultado estão rodando. */}
          {entries.map((e) => {
            if (e.kind !== 'tool') return <ThinkingCard key={e.index} text={e.text} />
            const key = toolKey(e.use)
            return (
              <ToolRow
                key={e.index}
                entry={e}
                running={running}
                open={openKeys.has(key)}
                onToggle={() => toggleRow(key)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// Resultado sem chamada correspondente no transcript (raro: chamada fundida em
// outro card ou cortada). Continua visível, no mesmo vocabulário das linhas.
export function ToolResultCard({
  content,
  isError,
  interrupted,
}: {
  content: string
  isError: boolean
  interrupted?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={ROW_BUTTON}
      >
        <Chevron open={open} />
        <Icon
          as={isError ? AlertTriangle : CornerDownRight}
          size={13}
          className={`shrink-0 ${isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-dim)]'}`}
        />
        <span
          className={`shrink-0 font-medium ${isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'}`}
        >
          {isError ? 'Erro' : interrupted ? 'Resultado parcial' : 'Resultado'}
        </span>
        {!open && (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-text-dim)]">
            {oneLine(content)}
          </span>
        )}
        {interrupted && (
          <span className="ml-auto pl-2">
            <InterruptedBadge label="interrompido" />
          </span>
        )}
      </button>
      {open && (
        <div className="chat-reveal mb-2 ml-6 mt-1">
          <OutputBlock content={content} isError={isError} />
        </div>
      )}
    </div>
  )
}
