import type { ReactNode } from 'react'
import { AlertTriangle, Archive, ArrowRight, Info, OctagonAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { IssueLevel } from '../../../shared/feature-loop'
import {
  duplicateCandidate,
  ISSUE_LEVEL_META,
  issueAction,
  sortIssues,
  type DuplicateSuspectLike,
  type FeatureIssue,
} from './feature-issues'

const LEVEL_ICON: Record<IssueLevel, LucideIcon> = {
  error: OctagonAlert,
  warn: AlertTriangle,
  info: Info,
}

interface Props {
  issues: readonly FeatureIssue[]
  /** Suspeita vinda do snapshot — supre o id que a mensagem não carrega. */
  suspect?: DuplicateSuspectLike | null
  onEditPulse: () => void
  onEditObjective: () => void
  onLinkOkr: () => void
  onOpenCandidate: (id: string) => void
  onArchive: () => void
}

// Faixa de higiene do dossiê: o que está errado nesta feature, do mais grave
// pro menos, e o GESTO que resolve cada coisa. Sem issue não renderiza nada —
// uma faixa vazia dizendo "tudo certo" seria mais um lugar pra não olhar.
export function FeatureIssues({
  issues,
  suspect,
  onEditPulse,
  onEditObjective,
  onLinkOkr,
  onOpenCandidate,
  onArchive,
}: Props) {
  if (issues.length === 0) return null
  const ordered = sortIssues(issues)

  return (
    <section
      data-testid="feature-issues"
      className="mt-3 flex flex-col gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-2"
    >
      {ordered.map((issue) => (
        <IssueRow
          key={issue.code}
          issue={issue}
          suspect={suspect}
          onEditPulse={onEditPulse}
          onEditObjective={onEditObjective}
          onLinkOkr={onLinkOkr}
          onOpenCandidate={onOpenCandidate}
          onArchive={onArchive}
        />
      ))}
    </section>
  )
}

function IssueRow({
  issue,
  suspect,
  onEditPulse,
  onEditObjective,
  onLinkOkr,
  onOpenCandidate,
  onArchive,
}: { issue: FeatureIssue } & Omit<Props, 'issues'>) {
  const meta = ISSUE_LEVEL_META[issue.level]
  const action = issueAction(issue.code)
  const candidate = duplicateCandidate(issue, suspect)

  return (
    <div
      data-testid="feature-issue"
      data-code={issue.code}
      data-level={issue.level}
      className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5"
      style={{ background: `color-mix(in srgb, ${meta.color} 8%, transparent)` }}
    >
      <Icon as={LEVEL_ICON[issue.level]} size={13} style={{ color: meta.color }} />
      <span className="min-w-0 flex-1 text-xs text-[var(--color-text)]">
        {candidate ? `Possível duplicata de “${candidate.title}”.` : issue.message}
      </span>

      {action === 'open-candidate' && candidate && (
        <>
          <IssueButton
            testId="feature-issue-open-candidate"
            color={meta.color}
            icon={ArrowRight}
            onClick={() => onOpenCandidate(candidate.id)}
          >
            abrir “{candidate.title}”
          </IssueButton>
          {/* Mesclar é backend de outra fase: aqui o veredito possível é
              arquivar esta, que não perde nada (archive é reversível). */}
          <IssueButton
            testId="feature-issue-archive"
            color={meta.color}
            icon={Archive}
            onClick={onArchive}
          >
            arquivar esta
          </IssueButton>
        </>
      )}
      {action === 'edit-pulse' && (
        <IssueButton testId="feature-issue-pulse" color={meta.color} onClick={onEditPulse}>
          escrever pulso
        </IssueButton>
      )}
      {action === 'edit-objective' && (
        <IssueButton testId="feature-issue-objective" color={meta.color} onClick={onEditObjective}>
          editar objetivo
        </IssueButton>
      )}
      {action === 'link-okr' && (
        <IssueButton testId="feature-issue-okr" color={meta.color} onClick={onLinkOkr}>
          vincular a um OKR
        </IssueButton>
      )}
    </div>
  )
}

function IssueButton({
  testId,
  color,
  icon,
  onClick,
  children,
}: {
  testId: string
  color: string
  icon?: LucideIcon
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      {icon && <Icon as={icon} size={11} />}
      {children}
    </button>
  )
}
