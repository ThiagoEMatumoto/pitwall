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

// Representação humana, plataforma-aware. Usada nos <kbd> da UI.
export function formatCombo(c: Combo): string {
  const parts: string[] = []
  if (c.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (c.shift) parts.push('Shift')
  if (c.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (c.code === 'Backslash') parts.push('\\')
  else if (c.key === 'Tab') parts.push('Tab')
  else if (c.key) parts.push(c.key.toUpperCase())
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
