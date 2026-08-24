import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ChevronRight, CornerDownLeft, Image as ImageIcon, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button, GradientBorder } from '@/features/brand'
import { sessionsApi } from '@/lib/ipc'
import { useSessionPrefsStore } from '@/lib/session-prefs-store'
import { navigateHistory, resolveComposerKey, resolveForwardKey } from './composer-keys'
import { insertDictation } from './composer-insert'
import { insertPathToken, pickImageFiles, pickImageItems } from './image-paste'

export interface ComposerHandle {
  focus: () => void
  // Insere texto (ditado por voz) no DRAFT: na posição do cursor se o textarea
  // tem foco, senão no fim. Nunca envia — o usuário revisa e usa o submit normal.
  appendText: (text: string) => void
}

// Imagem anexada ao draft atual: `path` é o caminho temp injetado no prompt;
// `previewUrl` é um object URL (blob:) usado só pra renderizar o thumbnail —
// precisa ser revogado ao remover/desmontar pra não vazar memória. Vazio ('')
// quando o anexo foi RESTAURADO da persistência: o object URL é efêmero (não
// serializável) e não há IPC pra reler o binário, então o chip mostra um ícone.
interface Attachment {
  name: string
  path: string
  previewUrl: string
}

interface Props {
  sessionId: string
  // Injeta o texto no input do claude E submete (Enter).
  onSend: (text: string) => void
  // Injeta o texto SEM submeter (usuário revisa antes do Enter).
  onInsert: (text: string) => void
  // Encaminha uma sequência ANSI crua direto pro PTY (modelo Warp: o xterm é
  // display-only e o composer dirige a TUI do claude — setas, Ctrl+C, Esc, etc).
  onForwardKey?: (seq: string) => void
  // Barra de controles acima do textarea (switcher de modelo, anexar, etc).
  // Slot agnóstico: o pai compõe o conteúdo (compartilhado entre terminal e chat).
  toolbar?: ReactNode
  // Habilita o controle de recolher o dock (só faz sentido no modo terminal). O
  // valor recolhido é global e persistido (useSessionPrefsStore); este flag só
  // liga/desliga o controle — em chat o dock fica sempre expandido.
  collapsible?: boolean
}

// Drafts em memória por sessão — princípio "nunca perder input". Sobrevive ao
// remount do dock (toggle de aba, reopen de pane) enquanto o app vive; não
// persiste em disco. O Composer é montado uma vez por sessão, então a chave é
// estável durante o ciclo de vida da instância.
const drafts = new Map<string, string>()

// Histórico de prompts despachados por sessão (em ordem cronológica). Mesma
// natureza dos drafts: memória, por sessão, sobrevive ao remount do dock mas não
// persiste em disco. Recuperável via Ctrl+↑/↓ no composer.
const histories = new Map<string, string[]>()

function pushHistory(sessionId: string, value: string) {
  const v = value.trim()
  if (!v) return
  const list = histories.get(sessionId) ?? []
  // Dedupe consecutivo (estilo shell) — não polui o histórico com repetições.
  if (list[list.length - 1] === v) return
  histories.set(sessionId, [...list, v])
}

// Anexos persistidos por sessão: só a parte serializável ({name, path}). O
// `previewUrl` (object URL) é efêmero e não viaja — ao restaurar, o chip aparece
// sem thumbnail (com ícone). Mesma natureza dos drafts/histórico: memória.
type PersistedAttachment = Pick<Attachment, 'name' | 'path'>
const attachmentsBySession = new Map<string, PersistedAttachment[]>()

// Recolhido do dock, por sessão — mesma natureza dos drafts/histórico/anexos
// acima (memória, sobrevive ao remount, não persiste em disco). Era uma
// preferência GLOBAL em session-prefs-store; virou por-sessão pra colapsar um
// terminal não afetar os outros abertos ao lado.
const collapsedBySession = new Map<string, boolean>()

const MAX_HEIGHT = 192

// Dock de composição sempre visível abaixo do terminal. Um <textarea> de verdade
// (setas, clique, seleção, multiline) que injeta no PTY vivo via bracketed-paste,
// resolvendo a dor do Enter/Shift+Enter do input nativo do claude no xterm. É
// aditivo: o input direto na TUI continua funcionando.
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { sessionId, onSend, onInsert, onForwardKey, toolbar, collapsible = false },
  ref,
) {
  const [text, setText] = useState(() => drafts.get(sessionId) ?? '')
  // Navegação do histórico de prompts: `histIndex` null = editando o rascunho
  // atual (fora do histórico); >= 0 = posição no histórico da sessão. `savedDraft`
  // guarda o rascunho ao entrar no histórico pra restaurá-lo ao voltar pro fim.
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const savedDraftRef = useRef('')
  // Imagens anexadas ao draft atual (thumbnail + nome). Restaura da persistência
  // por sessão — sem object URL (chip com ícone até o usuário reanexar).
  const [attached, setAttached] = useState<Attachment[]>(() =>
    (attachmentsBySession.get(sessionId) ?? []).map((a) => ({ ...a, previewUrl: '' })),
  )
  // Espelha `attached` pra revogar os object URLs no unmount sem recriar o efeito.
  const attachedRef = useRef<Attachment[]>([])
  const innerRef = useRef<HTMLTextAreaElement>(null)
  const keyboardMode = useSessionPrefsStore((s) => s.keyboardMode)
  const loadPrefs = useSessionPrefsStore((s) => s.load)
  // Recolhido do dock, POR SESSÃO (collapsedBySession acima) — só em memória,
  // reseta ao reabrir o app. O Composer é montado uma vez por sessão (mesma
  // premissa dos drafts/histórico), então a chave é estável no ciclo de vida.
  const [composerCollapsed, setComposerCollapsedState] = useState(
    () => collapsedBySession.get(sessionId) ?? false,
  )
  function setComposerCollapsed(v: boolean) {
    collapsedBySession.set(sessionId, v)
    setComposerCollapsedState(v)
  }
  // Recolhido só vale no modo terminal (collapsible); em chat o dock é sempre completo.
  const collapsed = collapsible && composerCollapsed

  useImperativeHandle(
    ref,
    () => ({
      focus: () => innerRef.current?.focus(),
      // Ditado por voz → draft. Cursor: posição atual se o textarea tem foco,
      // fim caso contrário (ditar sem foco não pode sobrescrever o meio do texto).
      appendText: (dictated: string) => {
        // Dock recolhido esconderia o draft ditado — expande antes de inserir.
        setComposerCollapsed(false)
        const node = innerRef.current
        const focused = node != null && document.activeElement === node
        setText((cur) => {
          const start = focused ? (node.selectionStart ?? cur.length) : cur.length
          const end = focused ? (node.selectionEnd ?? cur.length) : cur.length
          const { value, cursor } = insertDictation(cur, dictated, start, end)
          requestAnimationFrame(() => {
            const el = innerRef.current
            if (el) {
              el.focus()
              el.setSelectionRange(cursor, cursor)
            }
          })
          return value
        })
        // Ditar sobre um prompt recuperado do histórico vira um novo rascunho.
        setHistIndex(null)
      },
    }),
    [],
  )

  useEffect(() => {
    void loadPrefs()
  }, [loadPrefs])

  // Persiste o draft em memória a cada mudança.
  useEffect(() => {
    if (text) drafts.set(sessionId, text)
    else drafts.delete(sessionId)
  }, [sessionId, text])

  useEffect(() => {
    attachedRef.current = attached
  }, [attached])

  // Persiste os anexos (só {name, path}) por sessão — sobrevive à troca de sessão,
  // espelhando o draft. O previewUrl é descartado (efêmero).
  useEffect(() => {
    if (attached.length > 0) {
      attachmentsBySession.set(
        sessionId,
        attached.map(({ name, path }) => ({ name, path })),
      )
    } else {
      attachmentsBySession.delete(sessionId)
    }
  }, [sessionId, attached])

  // Revoga os object URLs ainda pendurados ao desmontar o composer.
  useEffect(() => {
    return () => {
      for (const a of attachedRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    }
  }, [])

  // Auto-grow do textarea até um teto; depois disso, scroll interno.
  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  function refocus() {
    // onSend/onInsert focam o xterm; devolvemos o foco ao composer no próximo tick.
    requestAnimationFrame(() => innerRef.current?.focus())
  }

  // Move o cursor pro fim e foca — usado ao recuperar um prompt do histórico.
  function caretToEnd() {
    requestAnimationFrame(() => {
      const node = innerRef.current
      if (!node) return
      node.focus()
      const end = node.value.length
      node.setSelectionRange(end, end)
    })
  }

  // Ctrl+↑/↓ percorre o histórico de prompts da sessão (estilo shell). 'prev'
  // recua pros mais recentes; 'next' avança de volta até o rascunho salvo. Binding
  // distinto do ↑/↓ puro (que dirige a TUI do claude quando o composer está vazio).
  function recallHistory(dir: 'prev' | 'next') {
    const list = histories.get(sessionId) ?? []
    if (list.length === 0) return
    // Ao entrar no histórico a partir do rascunho, guarda o texto atual.
    const cur = histIndex ?? list.length
    if (histIndex === null) {
      if (dir === 'next') return // já no fim; nada mais novo
      savedDraftRef.current = text
    }
    const res = navigateHistory(list, cur, dir)
    if (res.index >= list.length) {
      setText(savedDraftRef.current)
      setHistIndex(null)
    } else {
      setText(res.value)
      setHistIndex(res.index)
    }
    caretToEnd()
  }

  // Salva cada imagem como temp (binário, via IPC) e injeta o(s) path(s) absoluto(s)
  // na posição do cursor — a CLI claude anexa a imagem a partir do caminho colado.
  // Nunca submete: o usuário revisa e aperta Enter.
  async function ingestImages(files: File[]) {
    const saved: Attachment[] = []
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer()
        const path = await sessionsApi.saveImage(sessionId, buf, file.type)
        // Só cria o object URL após o save dar certo — evita vazar URL em erro.
        saved.push({
          path,
          name: file.name || path.split('/').pop() || 'imagem',
          previewUrl: URL.createObjectURL(file),
        })
      } catch (err) {
        console.error('[composer] falha ao salvar imagem colada/arrastada:', err)
      }
    }
    if (saved.length === 0) return
    const el = innerRef.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    const joined = saved.map((s) => s.path).join(' ')
    setText((cur) => {
      const { value, cursor } = insertPathToken(cur, joined, start, end)
      requestAnimationFrame(() => {
        const node = innerRef.current
        if (node) {
          node.focus()
          node.setSelectionRange(cursor, cursor)
        }
      })
      return value
    })
    setAttached((a) => [...a, ...saved])
  }

  function removeAttachment(i: number) {
    const target = attachedRef.current[i]
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    setAttached((a) => a.filter((_, j) => j !== i))
  }

  function clearAttachments() {
    for (const a of attachedRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    setAttached([])
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const dt = e.clipboardData
    if (!dt) return
    let files = pickImageItems(Array.from(dt.items))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
    if (files.length === 0) files = pickImageFiles(Array.from(dt.files))
    if (files.length === 0) return // texto comum → deixa o paste nativo do textarea
    e.preventDefault()
    void ingestImages(files)
  }

  function handleDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const files = pickImageFiles(Array.from(e.dataTransfer?.files ?? []))
    if (files.length === 0) return
    e.preventDefault()
    void ingestImages(files)
  }

  function handleDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    // Sem preventDefault no dragover o onDrop nunca dispara.
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
  }

  function submit() {
    const value = text
    if (value.trim().length === 0) return
    onSend(value)
    pushHistory(sessionId, value)
    setText('')
    setHistIndex(null)
    clearAttachments()
    drafts.delete(sessionId)
    refocus()
  }

  function insertOnly() {
    const value = text
    if (value.trim().length === 0) return
    onInsert(value)
    pushHistory(sessionId, value)
    setText('')
    setHistIndex(null)
    clearAttachments()
    drafts.delete(sessionId)
    refocus()
  }

  const hint =
    keyboardMode === 'enter-newline'
      ? 'Enter quebra linha · Cmd/Ctrl+Enter envia'
      : 'Enter envia · Shift+Enter quebra linha'

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-2 pb-1 pt-2">
      <div className="flex items-center gap-1">
        {collapsible && (
          <button
            type="button"
            onClick={() => setComposerCollapsed(!composerCollapsed)}
            title={collapsed ? 'Expandir o compositor' : 'Recolher o compositor (mantém a barra de controles)'}
            aria-label={collapsed ? 'Expandir o compositor' : 'Recolher o compositor'}
            className="flex shrink-0 items-center rounded p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]"
          >
            <Icon
              as={ChevronRight}
              size={14}
              className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
            />
          </button>
        )}
        <div className="min-w-0 flex-1">{toolbar}</div>
      </div>
      {!collapsed && attached.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1.5 px-1">
          {attached.map((att, i) => (
            <span
              key={`${att.name}-${i}`}
              className="flex items-center gap-1.5 rounded bg-[var(--color-surface-2)] py-0.5 pl-0.5 pr-1.5 text-[10px] text-[var(--color-text-dim)]"
              title="Imagem anexada — o caminho foi inserido no prompt"
            >
              {att.previewUrl ? (
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="h-7 w-7 rounded border border-[var(--color-border)] object-cover"
                />
              ) : (
                <span className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-dim)]">
                  <Icon as={ImageIcon} size={14} />
                </span>
              )}
              <span className="max-w-32 truncate">{att.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                className="hover:text-[var(--color-text)]"
                title="Remover indicador (não apaga o caminho do prompt)"
              >
                <Icon as={X} size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {!collapsed && (
        <>
      <GradientBorder
        radius={12}
        innerBg="var(--color-bg)"
        className="w-full"
        style={{ display: 'block', width: '100%' }}
        innerClassName="flex items-end gap-2 px-2.5 py-2"
      >
        <div className="relative min-w-0 flex-1">
          {/* Placeholder da marca: texto + cursor piscante (pw-cursor). Overlay
              decorativo (pointer-events-none) mostrado só com o input vazio — não
              interfere no textarea real por baixo. */}
          {text.length === 0 && (
            <div
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 flex items-center font-mono text-sm leading-[1.5] text-[var(--color-text-dim)]"
            >
              Escreva um prompt…
              <span className="pw-cursor ml-0.5 inline-block h-[15px] w-[7px] bg-[var(--color-accent)] align-text-bottom" />
            </div>
          )}
        <textarea
          ref={innerRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // Editar manualmente sai do modo histórico (vira um novo rascunho).
            if (histIndex !== null) setHistIndex(null)
          }}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          rows={2}
          placeholder=""
          aria-label="Escreva um prompt — vai pro mesmo claude. Vazio: setas/Esc/Ctrl+C dirigem a TUI."
          className="max-h-48 min-h-[2.5rem] w-full resize-none overflow-auto border-0 bg-transparent p-0 font-mono text-sm text-[var(--color-text)] outline-none"
          onKeyDown={(e) => {
            // Não deixa atalhos globais/terminal interceptarem enquanto compõe.
            e.stopPropagation()
            // Histórico de prompts: Ctrl+↑/↓ recupera prompts despachados na sessão.
            // Vem ANTES do forward pro PTY pra não conflitar com o ↑/↓ puro (que
            // dirige a TUI do claude quando o composer está vazio).
            if (
              (e.ctrlKey || e.altKey) &&
              !e.metaKey &&
              (e.key === 'ArrowUp' || e.key === 'ArrowDown')
            ) {
              e.preventDefault()
              recallHistory(e.key === 'ArrowUp' ? 'prev' : 'next')
              return
            }
            // Modelo Warp: teclas de controle/navegação são encaminhadas pro PTY pra
            // dirigir a TUI do claude (menus, y/n, Shift+Tab, interrupção). O textarea
            // vazio é "modo de controle"; com texto, as teclas editam o draft.
            if (onForwardKey) {
              const fwd = resolveForwardKey(
                {
                  key: e.key,
                  ctrl: e.ctrlKey,
                  meta: e.metaKey,
                  shift: e.shiftKey,
                  alt: e.altKey,
                },
                text.trim().length === 0,
              )
              if ('seq' in fwd) {
                e.preventDefault()
                onForwardKey(fwd.seq)
                return
              }
            }
            const action = resolveComposerKey(
              { key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey },
              keyboardMode,
            )
            if (action === 'send') {
              e.preventDefault()
              submit()
            }
            // 'newline' e 'noop': comportamento nativo do textarea (quebra/edição).
          }}
        />
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button variant="primary" size="sm" onClick={submit} title={hint}>
            <Icon as={CornerDownLeft} size={13} />
            Enviar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={insertOnly}
            title="Insere o texto no prompt do claude sem enviar — você revisa e aperta Enter"
          >
            Inserir
          </Button>
        </div>
      </GradientBorder>
        </>
      )}
    </div>
  )
})
