import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Flag } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { showToast } from '@/features/notifications/toast-store'
import { batonApi } from '@/lib/ipc'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'

import type { PassBatonResult } from '../../../shared/types/ipc'

// Status de handoff sem volta: filha em done/rejected/failed não tem papel a
// herdar. Espelha TERMINAL_HANDOFF_STATUSES do main (código do main não é
// importável no renderer); quem DECIDE a herança segue sendo o main — aqui isso
// só governa o que a tela PROMETE ao humano antes de ele confirmar.
const TERMINAL_HANDOFF_STATUSES: ReadonlySet<string> = new Set(['done', 'rejected', 'failed'])

type Phase = 'distilling' | 'error' | 'ready' | 'passing' | 'passed'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Foca a sucessora: o PTY dela já subiu no MAIN (baton:pass spawna lá dentro),
// então aqui não há spawn nenhum — só re-attach de pane à sessão viva, o mesmo
// caminho de quem clica numa sessão no strip. Devolve false quando o snapshot
// ainda não a trouxe: nesse caso ela existe, mas quem abre é o humano.
async function focusSuccessor(sessionId: string): Promise<boolean> {
  await useAppStore.getState().refreshLiveSessions()
  const live = useAppStore.getState().liveSessions.find((s) => s.id === sessionId)
  if (!live) return false
  await useAppStore.getState().focusOrOpenSession(live)
  return true
}

interface Props {
  open: boolean
  onClose: () => void
  // sessions.id interno da ANTECESSORA — é por ele que se descobre se ela é
  // filha de handoff (o vínculo mãe→filha mora em handoffs.child_session_id).
  sessionId: string
  // cc_session_id da ANTECESSORA: chave do transcript, o que os dois handlers pedem.
  // null = sessão que ainda não teve 1ª resposta (não há transcript a destilar).
  ccSessionId: string | null
  repoLabel?: string
}

// Passagem de bastão: destila o transcript da sessão cheia, deixa o humano LER e
// CORRIGIR o briefing e sobe uma sessão limpa com ele.
//
// O textarea é o coração da tela, não um detalhe: é o gate humano da feature — o
// que ele aprovar é literalmente o que a sucessora vai saber, e o main não
// re-destila (editar aqui é a única chance de corrigir uma alucinação da
// destilação antes que ela vire a verdade da sucessora).
export function BatonDialog({ open, onClose, sessionId, ccSessionId, repoLabel }: Props) {
  const [phase, setPhase] = useState<Phase>('distilling')
  const [briefing, setBriefing] = useState('')
  const [note, setNote] = useState('')
  const [task, setTask] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Segundos desde o início da destilação: a chamada leva DEZENAS de segundos e
  // um spinner mudo dessa duração é indistinguível de travamento.
  const [elapsed, setElapsed] = useState(0)
  const [passed, setPassed] = useState<PassBatonResult | null>(null)

  const liveSessions = useAppStore((s) => s.liveSessions)
  const handoffs = useHandoffsStore((s) => s.handoffs)

  // Papel herdado: se a antecessora é filha de um handoff vivo, a sucessora
  // assume o lugar dela no Crew Dock e o endereço de peer. Vale dizer isso ANTES
  // de confirmar — é a diferença entre "abri outra sessão" e "troquei quem
  // responde à mãe".
  const inherited =
    handoffs.find(
      (h) =>
        h.childSessionId === sessionId &&
        h.dismissedAt == null &&
        !TERMINAL_HANDOFF_STATUSES.has(h.status),
    ) ?? null
  const motherName = inherited?.motherSessionId
    ? (liveSessions.find((s) => s.id === inherited.motherSessionId)?.title ?? null)
    : null

  const distill = useCallback(
    async (extraNote: string) => {
      if (!ccSessionId) {
        setError('Esta sessão ainda não tem transcript — não há o que destilar.')
        setPhase('error')
        return
      }
      setPhase('distilling')
      setError(null)
      setElapsed(0)
      try {
        const text = await batonApi.distill({
          ccSessionId,
          note: extraNote.trim() || undefined,
        })
        setBriefing(text)
        setPhase('ready')
      } catch (err) {
        setError(messageOf(err))
        setPhase('error')
      }
    },
    [ccSessionId],
  )

  useEffect(() => {
    if (!open) return
    setBriefing('')
    setNote('')
    setTask('')
    setPassed(null)
    void distill('')
  }, [open, distill])

  useEffect(() => {
    if (phase !== 'distilling') return
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [phase])

  async function confirm() {
    const text = briefing.trim()
    if (!ccSessionId || !text) return
    setPhase('passing')
    setError(null)
    try {
      // Vai o texto do TEXTAREA (editado), nunca o destilado original: o main
      // não destila de novo, então o que está na tela é o contrato.
      const result = await batonApi.pass({
        ccSessionId,
        briefing: text,
        task: task.trim() || undefined,
      })
      const focused = await focusSuccessor(result.session.id)
      if (!focused) {
        showToast({
          title: 'A sucessora subiu',
          body: 'Ela ainda não apareceu na lista de sessões vivas — abra pelo strip.',
        })
      }
      // Endereço trocado é informação da MÃE, não ruído: ela continua chamando o
      // apelido antigo (que a antecessora, viva, ainda atende). Quem ENTREGA a
      // nota é o main (passBaton), por qualquer caminho — este aviso é a segunda
      // linha: a nota só chega se a mãe estiver viva, e mesmo viva ela pode estar
      // no meio de um turno. Por isso o diálogo segura até o humano confirmar.
      if (result.aliasChanged) {
        setPassed(result)
        setPhase('passed')
        return
      }
      showToast({
        title: 'Bastão passado',
        body: 'A sucessora assumiu com o briefing aprovado. A anterior continua viva — encerre quando quiser.',
      })
      onClose()
    } catch (err) {
      setError(messageOf(err))
      setPhase('ready')
    }
  }

  const busy = phase === 'distilling' || phase === 'passing'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Passar o bastão"
      widthClassName="w-[44rem]"
      footer={
        phase === 'passed' ? (
          <Button onClick={onClose}>Entendi</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              onClick={() => void confirm()}
              loading={phase === 'passing'}
              disabled={phase !== 'ready' || briefing.trim().length === 0}
            >
              {phase === 'passing' ? 'Subindo a sucessora…' : 'Subir a sucessora'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {/* A distinção que o usuário precisa fazer NESTA tela: /compact encolhe
            esta conversa; o bastão começa outra, limpa, herdando só o essencial. */}
        <p className="text-xs leading-relaxed text-[var(--color-text-dim)]">
          Uma sessão <strong className="text-[var(--color-text)]">nova</strong>, de contexto
          limpo, assume o trabalho levando o briefing abaixo.{' '}
          <strong className="text-[var(--color-text)]">Não é /compact</strong>: aquele condensa o
          histórico desta mesma conversa. Esta sessão{' '}
          <strong className="text-[var(--color-text)]">continua viva</strong> — encerre quando
          quiser.
        </p>

        <div className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-dim)]">
          <span>
            A sucessora sobe no mesmo repo
            {repoLabel ? (
              <>
                {' '}
                (<span className="text-[var(--color-text)]">{repoLabel}</span>)
              </>
            ) : null}{' '}
            e herda a feature vinculada a esta sessão.
          </span>
          {inherited && (
            <span data-testid="baton-inherits-child">
              Esta sessão é filha de handoff: a sucessora{' '}
              <span className="text-[var(--color-text)]">continua como filha</span>
              {motherName ? (
                <>
                  {' '}
                  da mesma mãe (<span className="text-[var(--color-text)]">{motherName}</span>)
                </>
              ) : (
                ' da mesma mãe'
              )}{' '}
              e assume o card no Crew Dock.
            </span>
          )}
        </div>

        {phase === 'distilling' && (
          <div
            data-testid="baton-loading"
            className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-6 text-center text-xs text-[var(--color-text-dim)]"
          >
            <span className="text-[var(--color-text)]">
              Destilando o transcript… ({elapsed}s)
            </span>
            <span>
              O Claude está relendo a conversa inteira: costuma levar dezenas de segundos e
              desiste em 90s.
            </span>
          </div>
        )}

        {phase === 'error' && (
          <div
            data-testid="baton-error"
            className="flex flex-col gap-2 rounded-md border px-3 py-3 text-xs"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-danger) 45%, transparent)',
              color: 'var(--color-danger)',
            }}
          >
            <span className="flex items-start gap-1.5">
              <Icon as={AlertTriangle} size={13} className="mt-px shrink-0" />
              <span>A destilação falhou: {error}</span>
            </span>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => void distill(note)}>
                Tentar de novo
              </Button>
            </div>
          </div>
        )}

        {phase === 'passed' && passed && (
          <div
            data-testid="baton-alias-changed"
            className="flex items-start gap-1.5 rounded-md border px-3 py-3 text-xs"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-warning) 45%, transparent)',
              color: 'var(--color-warning)',
            }}
          >
            <Icon as={Flag} size={13} className="mt-px shrink-0" />
            <span>
              O endereço da filha mudou: a sucessora atende por{' '}
              <strong>{passed.alias}</strong>, porque a anterior segue viva com o apelido
              antigo. O Pitwall já deixou a nota do endereço novo na sessão-mãe (se ela
              estiver viva) — confirme que ela leu antes de contar com isso, porque o
              SendMessage dela ainda aponta pro nome velho.
            </span>
          </div>
        )}

        {(phase === 'ready' || phase === 'passing') && (
          <>
            {error && (
              <div
                data-testid="baton-pass-error"
                className="rounded-md border px-3 py-2 text-xs"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-danger) 45%, transparent)',
                  color: 'var(--color-danger)',
                }}
              >
                Não deu pra subir a sucessora: {error}
              </div>
            )}
            <div className="w-full">
              <label className="mb-1 block text-xs text-[var(--color-text-dim)]">
                Briefing da sucessora — leia e corrija; é isto que ela vai saber
              </label>
              <textarea
                data-testid="baton-briefing"
                value={briefing}
                onChange={(e) => setBriefing(e.target.value)}
                rows={18}
                spellCheck={false}
                className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[16rem] flex-1">
                <Input
                  label="Primeiro passo da sucessora (opcional)"
                  data-testid="baton-task"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="O que ela faz assim que subir"
                />
              </div>
              <div className="min-w-[16rem] flex-1">
                <Input
                  label="Contexto extra pra destilar de novo (opcional)"
                  data-testid="baton-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="O que a destilação deixou passar"
                />
              </div>
              <Button variant="ghost" disabled={busy} onClick={() => void distill(note)}>
                Destilar de novo
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
