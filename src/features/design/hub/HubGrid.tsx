import type { ComponentType, ReactNode } from 'react'
import { Archive, FolderOpen, Inbox, PenTool, SearchX, type LucideProps } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import type { HubSection } from '@/store/designStore'
import type { DesignDocumentMeta } from '@shared/types/design'
import { DocCard } from './DocCard'

const SKELETONS = 6

function Empty({
  icon,
  title,
  children,
  actions,
}: {
  icon: ComponentType<LucideProps>
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-dim)]">
          <Icon as={icon} size={20} />
        </span>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
        <p className="text-[13px] leading-relaxed text-[var(--color-text-dim)]">{children}</p>
        {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

export interface HubGridProps {
  section: HubSection
  docs: DesignDocumentMeta[]
  // The section before search: tells "empty folder" from "no match".
  sectionCount: number
  query: string
  loading: boolean
  onCreate: () => void
  onAsk: () => void
  onClearQuery: () => void
}

export function HubGrid({
  section,
  docs,
  sectionCount,
  query,
  loading,
  onCreate,
  onAsk,
  onClearQuery,
}: HubGridProps) {
  if (loading && sectionCount === 0) {
    return (
      <div
        aria-busy="true"
        aria-label="Carregando designs"
        className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-6"
      >
        {Array.from({ length: SKELETONS }, (_, i) => (
          <div key={i} className="glass-card overflow-hidden">
            <div className="pw-agent-skeleton aspect-[16/10] bg-[var(--color-surface-2)]" />
            <div className="space-y-2 px-3 py-3">
              <div className="pw-agent-skeleton h-3 w-2/3 rounded bg-[var(--color-surface-2)]" />
              <div className="pw-agent-skeleton h-2.5 w-1/3 rounded bg-[var(--color-surface-2)]" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (sectionCount === 0) {
    if (section === 'recent') {
      return (
        <Empty
          icon={PenTool}
          title="Seu primeiro design começa aqui"
          actions={
            <>
              <Button onClick={onCreate}>Novo design</Button>
              <Button variant="ghost" onClick={onAsk}>
                Pedir ao Claude
              </Button>
            </>
          }
        >
          Crie um documento em branco ou descreva o que você quer (ex.: “desenha a landing do
          produto”) e deixe o Claude desenhar.
        </Empty>
      )
    }
    if (section === 'archived') {
      return (
        <Empty icon={Archive} title="Nada arquivado">
          Designs arquivados saem das listas, mas ficam guardados aqui para quando você precisar.
        </Empty>
      )
    }
    if (section === 'unfiled') {
      return (
        <Empty icon={Inbox} title="Tudo organizado">
          Todos os designs estão em alguma pasta.
        </Empty>
      )
    }
    return (
      <Empty
        icon={FolderOpen}
        title="Esta pasta está vazia"
        actions={<Button onClick={onCreate}>Novo design</Button>}
      >
        Arraste designs para cá ou crie um novo.
      </Empty>
    )
  }

  if (docs.length === 0) {
    return (
      <Empty
        icon={SearchX}
        title={`Nenhum design com “${query.trim()}”`}
        actions={
          <Button variant="ghost" onClick={onClearQuery}>
            Limpar busca
          </Button>
        }
      >
        A busca olha só os títulos desta seção.
      </Empty>
    )
  }

  return (
    <ul
      aria-label="Designs"
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-6"
    >
      {docs.map((d, i) => (
        <li key={d.id}>
          <DocCard doc={d} index={i} showFolder={section === 'recent'} />
        </li>
      ))}
    </ul>
  )
}
