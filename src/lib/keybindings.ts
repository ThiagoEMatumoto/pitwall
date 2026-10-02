export type ShortcutContext = 'Global' | 'Workspace' | 'Terminal'

export interface Combo {
  mod?: boolean
  shift?: boolean
  alt?: boolean
  key?: string
  code?: string
}

export interface Command {
  id: string
  label: string
  context: ShortcutContext
  defaultCombo: Combo
  editable: boolean
}

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

// Match exato em modificadores: mod = Ctrl OU Meta (Linux usa Ctrl; mac usa Cmd).
// shift/alt precisam bater exatamente (true⇔pressionado). A tecla casa por code
// quando o combo define code (estável sob Shift, ex: Backslash vira '|'), senão
// por key case-insensitive.
export function matchCombo(e: KeyboardEvent, c: Combo): boolean {
  if (!!c.mod !== (e.ctrlKey || e.metaKey)) return false
  if (!!c.shift !== e.shiftKey) return false
  if (!!c.alt !== e.altKey) return false
  if (c.code) return e.code === c.code
  if (c.key) return e.key.toLowerCase() === c.key.toLowerCase()
  return false
}

const ARROW_GLYPH: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
}

const PUNCTUATION_CODE: Record<string, string> = { Comma: ',', Period: '.', Backquote: '`' }

// O que a tecla física imprime no layout de quem usa: no ABNT2 a Backquote (acima
// do Tab) é a do ' e o ` é tecla morta em outro lugar, então "Ctrl+`" mentiria.
// Vem do navigator.keyboard (Chromium) no boot; sem ele, os rótulos US acima.
let layoutLabels: ReadonlyMap<string, string> = new Map()

export function setKeyboardLayoutLabels(labels: ReadonlyMap<string, string>): void {
  layoutLabels = labels
}

export async function loadKeyboardLayoutLabels(): Promise<void> {
  const kb = (
    navigator as Navigator & {
      keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> }
    }
  ).keyboard
  try {
    const map = await kb?.getLayoutMap?.()
    if (map) layoutLabels = map
  } catch {
    // Sem permissão ou sem API: ficam os rótulos US.
  }
}

function arrowGlyph(c: Combo): string | undefined {
  return ARROW_GLYPH[c.code ?? ''] ?? ARROW_GLYPH[c.key ?? '']
}

// Representação humana, plataforma-aware. Usada nos <kbd> da UI.
export function formatCombo(c: Combo): string {
  const parts: string[] = []
  if (c.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (c.shift) parts.push('Shift')
  if (c.alt) parts.push(isMac ? '⌥' : 'Alt')
  const arrow = arrowGlyph(c)
  if (c.code === 'Backslash') parts.push('\\')
  else if (c.code && PUNCTUATION_CODE[c.code])
    parts.push(layoutLabels.get(c.code) ?? PUNCTUATION_CODE[c.code])
  else if (c.code?.startsWith('Key')) parts.push(c.code.slice(3))
  else if (arrow) parts.push(arrow)
  else if (c.key === 'Tab') parts.push('Tab')
  // Tecla nomeada (Enter, Escape) fica como está: "ENTER" gritava na UI.
  else if (c.key) parts.push(c.key.length === 1 ? c.key.toUpperCase() : c.key)
  return parts.join('+')
}

export const COMMANDS: Command[] = [
  // Global
  {
    id: 'palette.toggle',
    label: 'Abrir paleta de comandos',
    context: 'Global',
    defaultCombo: { mod: true, key: 'k' },
    editable: true,
  },
  {
    id: 'switcher.open',
    label: 'Abrir seletor de sessões',
    context: 'Global',
    defaultCombo: { mod: true, shift: true, key: 'a' },
    editable: true,
  },
  // Trocar de feature como o Alt+Tab: segura o Ctrl, ` (ou Tab) cicla, soltar
  // confirma, Shift volta. Ctrl+` e não Alt+Tab/Alt+` (do GNOME: switch-applications
  // e switch-group) nem Ctrl+Tab (pane.next). Por code: a tecla acima do Tab em
  // qualquer layout (no ABNT2 o e.key dela é a aspa).
  {
    id: 'featureSwitcher.open',
    label: 'Trocar de feature (segure Ctrl, ` cicla)',
    context: 'Global',
    defaultCombo: { mod: true, code: 'Backquote' },
    editable: true,
  },
  // Mandar um prompt pra qualquer sessão sem abri-la. Não colide: Shift+Enter é a
  // nova linha do terminal e Ctrl+Enter o envio do composer / commit de texto do Design.
  {
    id: 'quickComposer.open',
    label: 'Enviar mensagem para uma sessão',
    context: 'Global',
    defaultCombo: { mod: true, shift: true, key: 'Enter' },
    editable: true,
  },
  // Fila de atenção: pular direto pra sessão que precisa de você. Alt (e não
  // Ctrl) porque Ctrl+letra é do shell/TUI; Alt+A/Alt+Q não colidem com o GNOME
  // nem com os defaults do Claude Code. O AppShell engole a tecla antes do PTY.
  // Por code: com Alt, e.key vira 'å'/'œ' no mac e 'ф' no layout russo.
  {
    id: 'attention.next',
    label: 'Próxima sessão que precisa de você',
    context: 'Global',
    defaultCombo: { alt: true, code: 'KeyA' },
    editable: true,
  },
  {
    id: 'attention.prev',
    label: 'Sessão anterior na fila de atenção',
    context: 'Global',
    defaultCombo: { alt: true, shift: true, code: 'KeyA' },
    editable: true,
  },
  {
    id: 'session.back',
    label: 'Voltar à sessão onde você estava',
    context: 'Global',
    defaultCombo: { alt: true, code: 'KeyQ' },
    editable: true,
  },
  // Andar pelas relações da sessão (mãe → irmãs → filhas; bastão ao lado dela).
  // Alt+,/Alt+. (os "<" e ">" do teclado) e NÃO Alt+←/→: no prompt do Claude Code
  // (2.1.286) meta+←/→ é pular palavra, e o listener global engoliria a tecla.
  // Por code, pelo mesmo motivo do Alt+A (com Option o e.key vira '≤'/'≥' no mac).
  {
    id: 'session.linkPrev',
    label: 'Sessão relacionada anterior (mãe, irmã, bastão de)',
    context: 'Global',
    defaultCombo: { alt: true, code: 'Comma' },
    editable: true,
  },
  {
    id: 'session.linkNext',
    label: 'Próxima sessão relacionada (filha, irmã, bastão para)',
    context: 'Global',
    defaultCombo: { alt: true, code: 'Period' },
    editable: true,
  },
  {
    id: 'session.new',
    label: 'Nova sessão (escolher repo)',
    context: 'Global',
    defaultCombo: { mod: true, key: 'n' },
    editable: true,
  },
  // Porta de entrada do teclado pro Crew Dock. Precisa de modificador: dentro do
  // dock, ↑/↓ e Espaço bastam, mas fora dele o Espaço puro vai direto pro xterm
  // (o attachCustomKeyEventHandler do Terminal só intercepta copy/paste).
  {
    id: 'crew.focus',
    label: 'Focar a equipe (sessões-filhas)',
    context: 'Global',
    defaultCombo: { mod: true, key: 'j' },
    editable: true,
  },
  // Trabalhar na feature em foco: o dossiê aberto na área de Features é o
  // "foco". Fica em Global porque não é gesto de pane/terminal.
  {
    id: 'feature.work',
    label: 'Trabalhar na feature em foco',
    context: 'Global',
    defaultCombo: { mod: true, shift: true, key: 'f' },
    editable: true,
  },
  // Mapa ⇄ Terminais na área Projetos. Ctrl+Shift+G ("grafo"): o Ctrl+Shift+G
  // do Design (desagrupar) só vive na área de design, e este só na de projetos;
  // não colide com GNOME nem com os meta+letra do Claude Code. Por code: estável
  // com Shift em qualquer layout.
  {
    id: 'projects.toggleMap',
    label: 'Alternar Mapa de sessões ⇄ Terminais',
    context: 'Workspace',
    defaultCombo: { mod: true, shift: true, code: 'KeyG' },
    editable: true,
  },
  // Ir direto à mãe da feature em foco (ou da sessão selecionada): foca a coluna
  // fixada, ou abre a mãe na modal do mapa. Ctrl+Shift+O ("origem"): Alt+M é o
  // meta+m do Claude Code (2.1.286 usa meta+p/o/t/m e meta+↑/↓), Ctrl+Shift+M é
  // o ditado e Ctrl+Shift+U é a entrada unicode do GTK. Por code: estável com
  // Shift em qualquer layout.
  {
    id: 'mother.focus',
    label: 'Ir para a sessão mãe da feature em foco',
    context: 'Workspace',
    defaultCombo: { mod: true, shift: true, code: 'KeyO' },
    editable: true,
  },
  // Mostrar/esconder o painel da mãe no mapa. Ctrl+Shift+P ("painel"): o
  // Ctrl+Shift+M pedido é o ditado (session.dictate); P não é default do app, do
  // Design (que usa Alt+letra para alinhar), do GNOME nem do Electron, e o
  // meta+p do Claude Code é Alt/Meta, não Ctrl+Shift. Por code: estável com Shift.
  {
    id: 'mother.togglePanel',
    label: 'Mostrar/esconder o painel da mãe no mapa',
    context: 'Workspace',
    defaultCombo: { mod: true, shift: true, code: 'KeyP' },
    editable: true,
  },
  {
    id: 'files.togglePanel',
    label: 'Alternar painel de arquivos',
    context: 'Workspace',
    defaultCombo: { mod: true, key: 'b' },
    editable: true,
  },

  // Workspace (editáveis)
  {
    id: 'pane.next',
    label: 'Próximo painel',
    context: 'Workspace',
    defaultCombo: { mod: true, key: 'Tab' },
    editable: true,
  },
  {
    id: 'pane.prev',
    label: 'Painel anterior',
    context: 'Workspace',
    defaultCombo: { mod: true, shift: true, key: 'Tab' },
    editable: true,
  },
  {
    id: 'pane.close',
    label: 'Fechar painel',
    context: 'Workspace',
    defaultCombo: { mod: true, key: 'w' },
    editable: true,
  },
  {
    id: 'pane.splitRight',
    label: 'Dividir à direita',
    context: 'Workspace',
    defaultCombo: { mod: true, code: 'Backslash' },
    editable: true,
  },
  {
    id: 'pane.splitBelow',
    label: 'Dividir abaixo',
    context: 'Workspace',
    defaultCombo: { mod: true, shift: true, code: 'Backslash' },
    editable: true,
  },
  {
    id: 'pane.newTab',
    label: 'Nova aba de sessão',
    context: 'Workspace',
    defaultCombo: { mod: true, key: 't' },
    editable: true,
  },

  // Workspace (fixo, display): Ctrl+1..9 numa linha só.
  {
    id: 'pane.focusN',
    label: 'Focar painel 1–9',
    context: 'Workspace',
    defaultCombo: { mod: true, key: '1' },
    editable: false,
  },

  // Terminal — zoom de fonte + nova linha (editáveis)
  {
    id: 'terminal.zoomIn',
    label: 'Aumentar fonte',
    context: 'Terminal',
    defaultCombo: { mod: true, key: '=' },
    editable: true,
  },
  {
    id: 'terminal.zoomOut',
    label: 'Diminuir fonte',
    context: 'Terminal',
    defaultCombo: { mod: true, key: '-' },
    editable: true,
  },
  {
    id: 'terminal.zoomReset',
    label: 'Resetar fonte',
    context: 'Terminal',
    defaultCombo: { mod: true, key: '0' },
    editable: true,
  },
  {
    id: 'terminal.newline',
    label: 'Nova linha (multiline)',
    context: 'Terminal',
    defaultCombo: { shift: true, key: 'Enter' },
    editable: true,
  },
  {
    id: 'terminal.compose',
    label: 'Compor prompt (editor)',
    context: 'Terminal',
    defaultCombo: { mod: true, shift: true, key: 'e' },
    editable: true,
  },
  {
    id: 'terminal.search',
    label: 'Buscar no terminal',
    context: 'Terminal',
    defaultCombo: { mod: true, key: 'f' },
    editable: true,
  },
  {
    id: 'terminal.clear',
    label: 'Limpar terminal',
    context: 'Terminal',
    defaultCombo: { mod: true, shift: true, key: 'k' },
    editable: true,
  },

  // Sessão — controles de voz do rodapé do composer. Existem como atalho porque
  // o acesso pelo botão depende da largura do pane: no narrow (ou no overflow
  // "⋯") eles saem da barra, e o teclado é o caminho que não encolhe.
  {
    id: 'session.dictate',
    label: 'Ditar por voz',
    context: 'Terminal',
    defaultCombo: { mod: true, shift: true, key: 'm' },
    editable: true,
  },
  {
    id: 'session.summarizeNow',
    label: 'Resumir o último turno',
    context: 'Terminal',
    defaultCombo: { mod: true, shift: true, key: 'r' },
    editable: true,
  },
  {
    id: 'session.toggleAutoSummary',
    label: 'Alternar resumo automático',
    context: 'Terminal',
    defaultCombo: { mod: true, shift: true, key: 's' },
    editable: true,
  },

  // Terminal (fixo, display)
  {
    id: 'terminal.copy',
    label: 'Copiar',
    context: 'Terminal',
    defaultCombo: { mod: true, shift: true, key: 'c' },
    editable: false,
  },
  {
    id: 'terminal.paste',
    label: 'Colar',
    context: 'Terminal',
    defaultCombo: { mod: true, shift: true, key: 'v' },
    editable: false,
  },
]

const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]))

export function resolveCombo(id: string, overrides: Record<string, Combo>): Combo {
  const override = overrides[id]
  if (override) return override
  const cmd = COMMAND_BY_ID.get(id)
  return cmd ? cmd.defaultCombo : {}
}
