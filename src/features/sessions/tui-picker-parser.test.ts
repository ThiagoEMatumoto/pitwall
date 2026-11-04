import { describe, expect, it } from 'vitest'
import {
  parseConfigMenu,
  parseHistorySearch,
  parseModelMenu,
  parseThemeMenu,
  parseTuiPicker,
  pickerFingerprint,
} from './tui-picker-parser'

// Fixtures espelham o desenho REAL dos pickers /model, /theme, /config e da
// busca Ctrl+R — capturados ao vivo (claude 2.1.215, harness node-pty isolado,
// snapshots renderizados por @xterm/headless). Ver header do tui-picker-parser
// pra proveniência completa.

const MODEL_PICKER = `❯ /model

────────────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.

  ❯ 1. Default (recommended) ✔  Opus 4.8 with 1M context · Best for everyday, complex tasks
    2. Opus                     Opus 4.8 with 1M context · Best for everyday, complex tasks
    3. Fable                    Fable 5 · Most capable for your hardest and longest-running tasks
    4. Sonnet                   Sonnet 5 · Efficient for routine tasks
    5. Haiku                    Haiku 4.5 · Fastest for quick answers

  ● High effort (default) ←/→ to adjust

  Use /fast to turn on Fast mode (Opus 4.8).

  Enter to set as default · s to use this session only · Esc to cancel
`

const MODEL_PICKER_NAV = `❯ /model

────────────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.

    1. Default (recommended) ✔  Opus 4.8 with 1M context · Best for everyday, complex tasks
    2. Opus                     Opus 4.8 with 1M context · Best for everyday, complex tasks
  ❯ 3. Fable                    Fable 5 · Most capable for your hardest and longest-running tasks
    4. Sonnet                   Sonnet 5 · Efficient for routine tasks
    5. Haiku                    Haiku 4.5 · Fastest for quick answers

  ◐ Medium effort ←/→ to adjust

  Use /fast to turn on Fast mode (Opus 4.8).

  Enter to set as default · s to use this session only · Esc to cancel
`

const THEME_PICKER = `❯ /theme

────────────────────────────────────────────────────────────────────
  Theme

  Choose the text style that looks best with your terminal

    1. Auto (match terminal)
    2. Dark mode
    3. Light mode
  ❯ 4. Dark mode (colorblind-friendly) ✔
    5. Light mode (colorblind-friendly)
    6. Dark mode (ANSI colors only)
    7. Light mode (ANSI colors only)
    8. New custom theme…

  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   1  function greet() {
   2 -  console.log("Hello, World!");
   2 +  console.log("Hello, Claude!");
   3  }
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  Syntax theme: Monokai Extended (ctrl+t to disable)

  Enter to select · Esc to cancel
`

const CONFIG_SEARCH_FOCUSED = `❯ /config

────────────────────────────────────────────────────────────────────
  Settings  Status   Config   Usage   Stats


  ╭──────────────────────────────────╮
  │ ⌕ Search settings…                │
  ╰──────────────────────────────────╯

    Auto-compact                               true
    Switch models when a message is flagged    true
    Show tips                                  true
    Reduce motion                              false
  ↓ 18 more below

  Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear
`

const CONFIG_LIST_FOCUSED = `❯ /config

────────────────────────────────────────────────────────────────────
  Settings  Status   Config   Usage   Stats


  ╭──────────────────────────────────╮
  │ ⌕ Search settings…                │
  ╰──────────────────────────────────╯

    Auto-compact                               true
    Switch models when a message is flagged    true
  ❯ Show tips                                  true
    Reduce motion                              false
  ↓ 18 more below

  Enter/Space to change · / to search · Esc to close
`

const CONFIG_FILTERED = `❯ /config

────────────────────────────────────────────────────────────────────
  Settings  Status   Config   Usage   Stats


  ╭──────────────────────────────────╮
  │ ⌕ verbose                          │
  ╰──────────────────────────────────╯

    Verbose output                             false

  Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear
`

describe('parseModelMenu', () => {
  it('parseia o picker de /model com opção destacada, current e effort', () => {
    const menu = parseModelMenu(MODEL_PICKER)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('model')
    expect(menu!.highlightIndex).toBe(0)
    expect(menu!.options).toHaveLength(5)
    expect(menu!.options[0]).toMatchObject({
      index: 0,
      label: 'Default (recommended)',
      current: true,
      description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
    })
    expect(menu!.options[1]).toMatchObject({ index: 1, label: 'Opus', current: false })
    expect(menu!.effortLabel).toBe('High effort (default)')
  })

  it('acompanha navegação (highlight movido) e ajuste de effort', () => {
    const menu = parseModelMenu(MODEL_PICKER_NAV)
    expect(menu).not.toBeNull()
    expect(menu!.highlightIndex).toBe(2)
    expect(menu!.effortLabel).toBe('Medium effort')
  })

  it('fail-closed sem o anchor "Select model"', () => {
    expect(parseModelMenu('Some unrelated text\n\n1. A\n2. B\n')).toBeNull()
  })

  it('fail-closed sem o footer específico do /model', () => {
    const withoutFooter = MODEL_PICKER.replace(
      'Enter to set as default · s to use this session only · Esc to cancel',
      'Enter to select · Esc to cancel',
    )
    expect(parseModelMenu(withoutFooter)).toBeNull()
  })
})

describe('parseThemeMenu', () => {
  it('parseia o picker de /theme com preview de diff e syntax theme', () => {
    const menu = parseThemeMenu(THEME_PICKER)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('theme')
    expect(menu!.highlightIndex).toBe(3)
    expect(menu!.options).toHaveLength(8)
    expect(menu!.options[3]).toMatchObject({
      index: 3,
      label: 'Dark mode (colorblind-friendly)',
      current: true,
    })
    expect(menu!.syntaxTheme).toBe('Monokai Extended')
    expect(menu!.previewOn).toBe(true)
    expect(menu!.preview).toContain('function greet()')
  })

  it('fail-closed sem o anchor "Theme" + descrição', () => {
    expect(parseThemeMenu('Theme\n\n1. A\n2. B\n\nEnter to select · Esc to cancel\n')).toBeNull()
  })
})

describe('parseConfigMenu', () => {
  it('parseia com foco na busca (footer "Type to filter")', () => {
    const menu = parseConfigMenu(CONFIG_SEARCH_FOCUSED)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('config')
    expect(menu!.tabs).toEqual(['Settings', 'Status', 'Config', 'Usage', 'Stats'])
    expect(menu!.searchFocused).toBe(true)
    expect(menu!.searchQuery).toBe('')
    expect(menu!.items).toHaveLength(4)
    expect(menu!.items[0]).toMatchObject({ label: 'Auto-compact', value: 'true', highlighted: false })
    expect(menu!.hasMoreBelow).toBe(true)
  })

  it('parseia com foco na lista (footer "Enter/Space to change") e item destacado', () => {
    const menu = parseConfigMenu(CONFIG_LIST_FOCUSED)
    expect(menu).not.toBeNull()
    expect(menu!.searchFocused).toBe(false)
    const highlighted = menu!.items.find((i) => i.highlighted)
    expect(highlighted).toMatchObject({ label: 'Show tips', value: 'true' })
  })

  it('parseia a lista filtrada pela busca', () => {
    const menu = parseConfigMenu(CONFIG_FILTERED)
    expect(menu).not.toBeNull()
    expect(menu!.searchQuery).toBe('verbose')
    expect(menu!.items).toEqual([{ label: 'Verbose output', value: 'false', highlighted: false }])
  })

  it('fail-closed sem a caixa de busca (⌕)', () => {
    expect(parseConfigMenu('Settings  Status\n\nAuto-compact   true\n')).toBeNull()
  })
})

describe('parseHistorySearch', () => {
  it('reconhece a busca aberta sem query', () => {
    const menu = parseHistorySearch('  search prompts:   ⏵⏵ bypass permissions on (shift+tab to cycle)\n')
    expect(menu).toEqual({ kind: 'history_search', mode: 'inline', query: '', noMatch: false })
  })

  it('reconhece sem match, com query', () => {
    const menu = parseHistorySearch('  no matching prompt: model  ⏵⏵ bypass permissions on (shift+tab to cycle)\n')
    expect(menu).toEqual({ kind: 'history_search', mode: 'inline', query: 'model', noMatch: true })
  })

  it('fail-closed fora do estado de busca de histórico', () => {
    expect(parseHistorySearch('  ⏵⏵ bypass permissions on (shift+tab to cycle)\n')).toBeNull()
  })
})

describe('parseTuiPicker — combinador', () => {
  it('tenta cada parser específico e devolve o primeiro match', () => {
    expect(parseTuiPicker(MODEL_PICKER)?.kind).toBe('model')
    expect(parseTuiPicker(THEME_PICKER)?.kind).toBe('theme')
    expect(parseTuiPicker(CONFIG_SEARCH_FOCUSED)?.kind).toBe('config')
    expect(parseTuiPicker('  search prompts:  ⏵⏵ bypass permissions on\n')?.kind).toBe('history_search')
  })

  it('null quando nada bate (texto de conversa comum)', () => {
    expect(parseTuiPicker('Claude respondeu normalmente aqui.\n')).toBeNull()
  })
})

describe('pickerFingerprint', () => {
  it('muda quando o highlight do /model muda', () => {
    const a = parseModelMenu(MODEL_PICKER)!
    const b = parseModelMenu(MODEL_PICKER_NAV)!
    expect(pickerFingerprint(a)).not.toBe(pickerFingerprint(b))
  })

  it('estável pro mesmo estado parseado duas vezes', () => {
    const a = parseModelMenu(MODEL_PICKER)!
    const a2 = parseModelMenu(MODEL_PICKER)!
    expect(pickerFingerprint(a)).toBe(pickerFingerprint(a2))
  })
})
