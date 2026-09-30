import { describe, expect, it } from 'vitest'
import { gateMenuByStatus, menuFingerprint, parseTuiMenu, questionPositionLabel } from './tui-menu-parser'

// Fixtures espelham o desenho REAL da TUI do claude 2.1.212 (validação live +
// strings do binário) — ver header do tui-menu-parser.

// Menu de AskUserQuestion como visto ao vivo: chip, pergunta, 3 opções com
// descrição indentada + sentinelas Type something./Chat about this, rodapé.
const FRUIT_MENU = `● I'll ask you about your fruit preference.

 Fruta

Qual fruta você prefere?

❯ 1. Maçã
     Maçã
  2. Banana
     Banana
  3. Uva
     Uva
  4. Type something.

  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`

describe('parseTuiMenu — menu de pergunta', () => {
  it('parseia o menu normal com sentinelas', () => {
    const menu = parseTuiMenu(FRUIT_MENU)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('question')
    expect(menu!.question).toBe('Qual fruta você prefere?')
    expect(menu!.multiSelect).toBe(false)
    expect(menu!.options).toHaveLength(5)
    expect(menu!.options[0]).toMatchObject({ index: 0, label: 'Maçã', description: 'Maçã' })
    expect(menu!.options[1]).toMatchObject({ index: 1, label: 'Banana' })
    expect(menu!.options[2]).toMatchObject({ index: 2, label: 'Uva' })
    expect(menu!.options[3]).toMatchObject({ index: 3, sentinel: 'other' })
    expect(menu!.options[4]).toMatchObject({ index: 4, sentinel: 'chat' })
  })

  it('junta wrap de pane estreita na descrição da opção anterior', () => {
    const menu = parseTuiMenu(`Qual abordagem?

❯ 1. As duas linhas
     Corrige clone e cd — o bloco fica
     consistente, mas são 2 linhas.
  2. Só a linha 11
     Estritamente uma linha.
  3. Type something.

Enter to select · ↑/↓ to navigate · Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.options[0].description).toBe(
      'Corrige clone e cd — o bloco fica consistente, mas são 2 linhas.',
    )
    expect(menu!.options[1].description).toBe('Estritamente uma linha.')
  })

  it('tolera rodapé e linha de status de modo depois da última opção', () => {
    const menu = parseTuiMenu(`Pergunta?

❯ 1. Sim
  2. Não

Enter to select · ↑/↓ to navigate · Esc to cancel
⏵⏵ bypass permissions on (shift+tab to cycle)
`)
    expect(menu).not.toBeNull()
    expect(menu!.options).toHaveLength(2)
  })

  it('marca multiSelect quando o rodapé é de checkbox (Space to toggle)', () => {
    const menu = parseTuiMenu(`Quais itens?

❯ 1. Item A
  2. Item B
  3. Item C

Space to toggle, Enter to confirm, a to select all, n to select none, i to invert, l to toggle latest
`)
    expect(menu).not.toBeNull()
    expect(menu!.multiSelect).toBe(true)
  })

  it('Bug 1 — junta as linhas de wrap da pergunta (não só a última), excluindo o chip', () => {
    // Espelha o layout (e) da sonda Fase 0 (claude 2.1.216): chip + pergunta
    // quebrada em várias linhas visuais SEM blank entre si.
    const menu = parseTuiMenu(` ☐ Arquitetura
Imagine um sistema distribuído com dezenas de microsserviços onde o serviço de
pagamentos precisa consultar o serviço de inventário em tempo real antes de
confirmar uma transação: qual abordagem você prefere?
❯ 1. Opção 1
     Chamadas síncronas com consistência forte
  2. Opção 2
     Saga assíncrona com compensação
  3. Type something.

  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.question).toBe(
      'Imagine um sistema distribuído com dezenas de microsserviços onde o serviço de ' +
        'pagamentos precisa consultar o serviço de inventário em tempo real antes de ' +
        'confirmar uma transação: qual abordagem você prefere?',
    )
    expect(menu!.question).not.toContain('Arquitetura')
  })

  it('Bug 1 — layout novo (chip adjacente, sem blank): pergunta de 1 linha não engole o chip', () => {
    const menu = parseTuiMenu(` ☐ Confirmação
Você confirma?
❯ 1. Sim
  2. Não
  3. Type something.

  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.question).toBe('Você confirma?')
  })

  it('Bug 1 — para na barra de abas (multi-pergunta) sem juntar a pergunta anterior', () => {
    const menu = parseTuiMenu(`←  ☐ Cor  ☐ Animal  ✔ Submit  →
Qual sua cor favorita?
❯ 1. Vermelho
  2. Azul
  3. Type something.

  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.question).toBe('Qual sua cor favorita?')
    expect(menu!.tabs).toEqual([
      { label: 'Cor', done: false },
      { label: 'Animal', done: false },
      { label: 'Submit', done: true },
    ])
  })
})

describe('parseTuiMenu — menu de plano', () => {
  it('classifica o menu de 3 opções pela pergunta e pelos labels', () => {
    const menu = parseTuiMenu(`Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, keep planning

Enter to select · ↑/↓ to navigate · Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('plan')
    expect(menu!.options).toHaveLength(3)
    expect(menu!.options[1].label).toBe('Yes, manually approve edits')
  })

  it('classifica variantes com mais opções (contagem varia entre versões)', () => {
    const menu = parseTuiMenu(`Exit plan mode?

❯ 1. Yes, and bypass permissions
  2. Yes, auto-accept edits
  3. Yes, manually approve edits
  4. Yes, manually approve edits and stay in ultraplan
  5. No, keep planning

Enter to select · ↑/↓ to navigate · Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('plan')
    expect(menu!.options).toHaveLength(5)
  })
})

// Prompt de permissão de Edit como desenhado pela TUI: box com o diff acima,
// pergunta composta ("make this edit to …") e opções com strings do binário.
const EDIT_PERMISSION_MENU = `╭──────────────────────────────────────────────╮
│ Edit file                                    │
│ ╭──────────────────────────────────────────╮ │
│ │ src/foo.ts                               │ │
│ │ 12  - const a = 1                        │ │
│ │ 12  + const a = 2                        │ │
│ ╰──────────────────────────────────────────╯ │
╰──────────────────────────────────────────────╯
Do you want to make this edit to src/foo.ts?

❯ 1. Yes
  2. Yes, allow all edits during this session
  3. No, and tell Claude what to do differently (esc)

Esc to cancel
`

// Trust prompt de diretório (pré-transcript): heading real do binário + 5 opções.
const TRUST_MENU = `╭──────────────────────────────────────────────╮
│ This folder adds custom permissions          │
│ Only proceed if you trust this configuration.│
╰──────────────────────────────────────────────╯
Only proceed if you trust this configuration.

❯ 1. Yes, I trust this folder
  2. Yes, and remember this directory
  3. Yes, for this session
  4. No, continue without these permissions
  5. No, exit

Enter to select · Esc to go back
`

describe('parseTuiMenu — prompts de permissão e trust (TTY-only)', () => {
  it('classifica permissão de Edit e captura o diff do box em context', () => {
    const menu = parseTuiMenu(EDIT_PERMISSION_MENU)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('permission')
    expect(menu!.question).toBe('Do you want to make this edit to src/foo.ts?')
    expect(menu!.options).toHaveLength(3)
    expect(menu!.options[0].label).toBe('Yes')
    expect(menu!.options[2].label).toBe('No, and tell Claude what to do differently (esc)')
    expect(menu!.context).toContain('src/foo.ts')
    expect(menu!.context).toContain('12  - const a = 1')
    // Bordas de box-drawing aparadas do contexto.
    expect(menu!.context).not.toContain('│')
  })

  it('classifica permissão de Bash (Do you want to proceed?) com o comando no context', () => {
    const menu = parseTuiMenu(`╭──────────────────────────────────────────────╮
│ Bash command                                 │
│ rm -rf ./dist                                │
│ Remove build output                          │
╰──────────────────────────────────────────────╯
Do you want to proceed?

❯ 1. Yes
  2. Yes, and don't ask again for rm commands
  3. No, and tell Claude what to do differently (esc)

Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('permission')
    expect(menu!.question).toBe('Do you want to proceed?')
    expect(menu!.context).toContain('rm -rf ./dist')
  })

  it('classifica permissão pelas opções mesmo sem pergunta reconhecível (fail-soft no context)', () => {
    const menu = parseTuiMenu(`Allow tool use?

❯ 1. Yes
  2. Yes, and don't ask again for this command
  3. No, and tell Claude what to do differently (esc)

Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('permission')
    expect(menu!.context).toBeUndefined()
  })

  it('classifica o trust prompt de diretório (5 opções)', () => {
    const menu = parseTuiMenu(TRUST_MENU)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('trust')
    expect(menu!.options).toHaveLength(5)
    expect(menu!.options[0].label).toBe('Yes, I trust this folder')
    expect(menu!.options[4].label).toBe('No, exit')
    expect(menu!.context).toContain('This folder adds custom permissions')
  })

  it('trust tem precedência sobre permission quando as opções são de trust', () => {
    // "No, continue without these permissions" não deve cair no genérico.
    const menu = parseTuiMenu(`Do you want to use this folder's configuration?

❯ 1. Yes, I trust this folder
  2. No, continue without these permissions

Esc to go back
`)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('trust')
  })

  it('AskUserQuestion com "Do you want"/"trust" na pergunta continua question (sentinelas presentes)', () => {
    const menu = parseTuiMenu(`Do you want to trust this folder for the deploy?

❯ 1. Sim
  2. Não
  3. Type something.

  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('question')
    expect(menu!.context).toBeUndefined()
  })
})

describe('parseTuiMenu — fail-closed', () => {
  it('rejeita prompt de permissão com numeração não-contígua', () => {
    expect(
      parseTuiMenu(`Do you want to proceed?

❯ 1. Yes
  3. No, and tell Claude what to do differently (esc)

Esc to cancel
`),
    ).toBeNull()
  })

  it('rejeita menu scrollado (numeração não começa em 1)', () => {
    expect(
      parseTuiMenu(`  2. Banana
  3. Uva
  4. Type something.

Enter to select · ↑/↓ to navigate · Esc to cancel
`),
    ).toBeNull()
  })

  it('rejeita numeração não-contígua', () => {
    expect(
      parseTuiMenu(`Pergunta?

❯ 1. A
  3. B

Enter to select · ↑/↓ to navigate · Esc to cancel
`),
    ).toBeNull()
  })

  it('rejeita lista numerada de markdown que não termina perto do fim', () => {
    expect(
      parseTuiMenu(`Plano:

1. Primeiro passo
2. Segundo passo
3. Terceiro passo

Esse é o racional da abordagem, em prosa longa
que segue depois da lista.
`),
    ).toBeNull()
  })

  it('rejeita texto sem linhas numeradas ou vazio', () => {
    expect(parseTuiMenu('')).toBeNull()
    expect(parseTuiMenu('só prosa\nsem menu\n')).toBeNull()
  })

  it('rejeita run de uma opção só', () => {
    expect(parseTuiMenu('Pergunta?\n\n❯ 1. Única\n')).toBeNull()
  })
})

// Fixtures desta seção espelham buffer REAL capturado ao vivo contra claude
// 2.1.215 (harness node-pty isolado, ver tui-menu-parser header) — não são
// suposição. Inclui o fluxo completo de abas + "Review your answers".

// Multi-select de UMA pergunta só (≤4 opções, sem split) — validado ao vivo:
// SEMPRE tem barra de abas (pergunta + "Submit"), mesmo com uma única pergunta.
const SINGLE_QUESTION_MULTI_SELECT = `Me pergunte, usando multipla escolha (multiSelect) com exatamente 3 opcoes marcaveis, quais destes bancos de dados eu ja usei: Postgres, MySQL, SQLite. Uma unica pergunta, nao precisa dividir. Nao faca mais nada.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ Bancos  ✔ Submit  →

Quais destes bancos de dados você já usou?

❯ 1. [ ] Postgres
  Banco relacional open source, com recursos avançados (JSONB, extensões, replicação).
  2. [ ] MySQL
  Banco relacional open source amplamente usado em aplicações web.
  3. [ ] SQLite
  Banco relacional embarcado, em arquivo único, sem servidor.
  4. [ ] Type something
     Submit
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`

// Multi-pergunta (>4 opções → CLI quebra em abas). Segunda pergunta ("Ruby"),
// já com a primeira ("Linguagens") marcada.
const MULTI_QUESTION_TAB_2 = `Preciso que voce me pergunte, usando multipla escolha com pelo menos 3 opcoes marcaveis, quais das seguintes linguagens eu ja uso: Python, Go, Rust, TypeScript, Ruby. Use o formato de pergunta com multipla selecao
  (multiSelect). Nao faca nada alem de fazer a pergunta.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ Linguagens  ☐ Ruby  ✔ Submit  →

E Ruby — você já usa?

❯ 1. [ ] Ruby
  Já uso Ruby no dia a dia ou em projetos
  2. [ ] Não uso Ruby
  Nunca usei ou não uso atualmente
  3. [ ] Type something
     Submit
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`

// Tela de revisão final (aba "Submit"): resumo das respostas + 1/2.
const REVIEW_SCREEN = `Preciso que voce me pergunte, usando multipla escolha com pelo menos 3 opcoes marcaveis, quais das seguintes linguagens eu ja uso: Python, Go, Rust, TypeScript, Ruby. Use o formato de pergunta com multipla selecao
  (multiSelect). Nao faca nada alem de fazer a pergunta.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ Linguagens  ☒ Ruby  ✔ Submit  →

Review your answers

 ● Quais das seguintes linguagens você já usa?
   → Python, Rust
 ● E Ruby — você já usa?
   → Ruby

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`

// Single-select com preview/exemplo por opção (bloco ┌─...─┐ + "Notes: press n
// to add notes") — hoje falha fail-closed (:129-135); precisa parsear.
const PREVIEW_MENU = `Me pergunte, em uma pergunta de escolha unica (nao multiSelect), qual estilo de aspas eu prefiro para strings em TypeScript: aspas simples ou aspas duplas. Para cada opcao, inclua um bloco de exemplo de codigo
  mostrando a diferenca (um preview/exemplo de 2-3 linhas de codigo por opcao). Nao faca mais nada.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Aspas

Qual estilo de aspas você prefere para strings em TypeScript?

❯ 1. Aspas simples                ┌──────────────────────────────────────────┐
  2. Aspas duplas                 │ const name = 'Thiago';                   │
                                   │ const greeting = 'Olá, mundo';           │
                                   │ import { parse } from 'node:path';       │
                                   └──────────────────────────────────────────┘

                                   Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
`

describe('parseTuiMenu — multi-select (checkboxes + barra de abas)', () => {
  it('parseia multi-select de pergunta única com barra de abas (sempre tem "Submit", mesmo sem split)', () => {
    const menu = parseTuiMenu(SINGLE_QUESTION_MULTI_SELECT)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('question')
    expect(menu!.multiSelect).toBe(true)
    expect(menu!.question).toBe('Quais destes bancos de dados você já usou?')
    expect(menu!.options[0]).toMatchObject({ index: 0, label: 'Postgres', checked: false })
    expect(menu!.options[1]).toMatchObject({ index: 1, label: 'MySQL', checked: false })
    expect(menu!.options[2]).toMatchObject({ index: 2, label: 'SQLite', checked: false })
    expect(menu!.options[3]).toMatchObject({ index: 3, sentinel: 'other' })
    expect(menu!.options[4]).toMatchObject({ index: 4, sentinel: 'chat' })
    expect(menu!.tabs).toEqual([
      { label: 'Bancos', done: false },
      { label: 'Submit', done: true },
    ])
    expect(menu!.submitOnDigit).toBe(true)
  })

  it('lê o glyph [✔]/[ ] como checked/unchecked', () => {
    const checkedFixture = SINGLE_QUESTION_MULTI_SELECT.replace('1. [ ] Postgres', '1. [✔] Postgres')
    const menu = parseTuiMenu(checkedFixture)
    expect(menu!.options[0].checked).toBe(true)
    expect(menu!.options[1].checked).toBe(false)
  })

  it('parseia a segunda pergunta de uma multi-pergunta (abas: uma já marcada ☒)', () => {
    const menu = parseTuiMenu(MULTI_QUESTION_TAB_2)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('question')
    expect(menu!.multiSelect).toBe(true)
    expect(menu!.question).toBe('E Ruby — você já usa?')
    expect(menu!.tabs).toEqual([
      { label: 'Linguagens', done: true },
      { label: 'Ruby', done: false },
      { label: 'Submit', done: true },
    ])
  })
})

describe('parseTuiMenu — question_review (tela "Review your answers")', () => {
  it('reconhece a tela de revisão como kind próprio, com Submit answers/Cancel numerados', () => {
    const menu = parseTuiMenu(REVIEW_SCREEN)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('question_review')
    expect(menu!.options).toHaveLength(2)
    expect(menu!.options[0].label).toBe('Submit answers')
    expect(menu!.options[1].label).toBe('Cancel')
    expect(menu!.context).toContain('Python, Rust')
    expect(menu!.context).toContain('Ruby')
  })
})

describe('parseTuiMenu — preview/exemplo por opção (não fail-closa mais)', () => {
  it('parseia o menu com preview em vez de rejeitar (fail-closed antigo)', () => {
    const menu = parseTuiMenu(PREVIEW_MENU)
    expect(menu).not.toBeNull()
    expect(menu!.kind).toBe('question')
    expect(menu!.options[0].label).toBe('Aspas simples')
    expect(menu!.options[1].label).toBe('Aspas duplas')
  })

  it('captura o conteúdo do preview (sem os caracteres de moldura) e desliga submitOnDigit', () => {
    const menu = parseTuiMenu(PREVIEW_MENU)
    expect(menu!.submitOnDigit).toBe(false)
    const preview = menu!.options.map((o) => o.preview).find((p) => p != null)
    expect(preview).toContain("const name = 'Thiago';")
    expect(preview).not.toContain('│')
    expect(preview).not.toContain('┌')
  })
})

describe('parseTuiMenu — regressão: single-select sem preview continua submetendo direto', () => {
  it('submitOnDigit é true e não há tabs/checked quando não há preview nem multiSelect', () => {
    const menu = parseTuiMenu(FRUIT_MENU)!
    expect(menu.submitOnDigit).toBe(true)
    expect(menu.tabs).toBeUndefined()
    expect(menu.options[0].checked).toBeUndefined()
  })
})

describe('gateMenuByStatus — card pré-transcript', () => {
  const question = parseTuiMenu(FRUIT_MENU)!
  const permission = parseTuiMenu(EDIT_PERMISSION_MENU)!
  const trust = parseTuiMenu(TRUST_MENU)!

  it("em 'waiting' qualquer kind passa (comportamento F3b)", () => {
    expect(gateMenuByStatus(question, 'waiting')).toBe(question)
    expect(gateMenuByStatus(permission, 'waiting')).toBe(permission)
    expect(gateMenuByStatus(trust, 'waiting')).toBe(trust)
  })

  it("pré-transcript ('starting'/'idle') só permission/trust passam", () => {
    for (const status of ['starting', 'idle'] as const) {
      expect(gateMenuByStatus(trust, status)).toBe(trust)
      expect(gateMenuByStatus(permission, status)).toBe(permission)
      expect(gateMenuByStatus(question, status)).toBeNull()
    }
  })

  it('fail-closed em qualquer outro status e sem menu', () => {
    expect(gateMenuByStatus(trust, 'working')).toBeNull()
    expect(gateMenuByStatus(trust, 'ended')).toBeNull()
    expect(gateMenuByStatus(trust, undefined)).toBeNull()
    expect(gateMenuByStatus(null, 'waiting')).toBeNull()
  })
})

describe('menuFingerprint', () => {
  it('é estável pro mesmo menu e distingue menus diferentes', () => {
    const a = parseTuiMenu(FRUIT_MENU)!
    const b = parseTuiMenu(FRUIT_MENU)!
    expect(menuFingerprint(a)).toBe(menuFingerprint(b))
    const other = parseTuiMenu(FRUIT_MENU.replace('Qual fruta você prefere?', 'Outra pergunta?'))!
    expect(menuFingerprint(other)).not.toBe(menuFingerprint(a))
  })

  it('distingue pergunta de plano e single de multi', () => {
    const q = parseTuiMenu(FRUIT_MENU)!
    expect(menuFingerprint(q)).toContain('question')
    expect(menuFingerprint(q)).toContain('single')
  })

  it('inclui o kind — permission e trust não colidem com question/plan', () => {
    const perm = parseTuiMenu(EDIT_PERMISSION_MENU)!
    const trust = parseTuiMenu(TRUST_MENU)!
    expect(menuFingerprint(perm)).toContain('permission')
    expect(menuFingerprint(trust)).toContain('trust')
    expect(menuFingerprint(perm)).not.toBe(menuFingerprint(trust))
  })

  it('Bug 2 — NÃO inclui submitOnDigit (mesmas opções/labels = mesmo fingerprint mesmo com submitOnDigit diferente)', () => {
    // Documenta o mecanismo do Bug 2: applyTuiMenu (Terminal.tsx) dedupa pelo
    // fingerprint e retém o estado antigo quando ele bate — se submitOnDigit
    // não está no fingerprint, um parse mais recente com submitOnDigit
    // diferente (preview apareceu/sumiu) NUNCA substitui o estado. Por isso
    // ChatView.respondTuiQuestion usa o menu do RE-PARSE fresco (não o
    // `tuiMenu` do estado) pra decidir dígito-só vs dígito+Enter.
    const q = parseTuiMenu(FRUIT_MENU)!
    const withPreview = { ...q, submitOnDigit: false }
    const withoutPreview = { ...q, submitOnDigit: true }
    expect(menuFingerprint(withPreview)).toBe(menuFingerprint(withoutPreview))
  })
})

describe('questionPositionLabel — Fase 2 (multi-pergunta numa só chamada)', () => {
  it('undefined sem tabs (single-select comum)', () => {
    expect(questionPositionLabel(undefined, false)).toBeUndefined()
  })

  it('undefined em multi-select puro (mesmo shape de tabs, semântica diferente)', () => {
    const tabs = [
      { label: 'Linguagens', done: false },
      { label: 'Submit', done: true },
    ]
    expect(questionPositionLabel(tabs, true)).toBeUndefined()
  })

  it('undefined com só 1 aba de pergunta + Submit (não é sequência)', () => {
    const tabs = [
      { label: 'Cor', done: false },
      { label: 'Submit', done: true },
    ]
    expect(questionPositionLabel(tabs, false)).toBeUndefined()
  })

  it('"Pergunta 1 de 2" na 1ª pergunta (nenhuma aba done ainda)', () => {
    const tabs = [
      { label: 'Cor', done: false },
      { label: 'Hobby', done: false },
      { label: 'Submit', done: true },
    ]
    expect(questionPositionLabel(tabs, false)).toBe('Pergunta 1 de 2')
  })

  it('"Pergunta 2 de 2" depois de responder a 1ª (sonda Fase 2: Cor done, Hobby pendente)', () => {
    const tabs = [
      { label: 'Cor', done: true },
      { label: 'Hobby', done: false },
      { label: 'Submit', done: true },
    ]
    expect(questionPositionLabel(tabs, false)).toBe('Pergunta 2 de 2')
  })

  it('clampa em N/N se todas as perguntas já vieram done (defensivo)', () => {
    const tabs = [
      { label: 'Cor', done: true },
      { label: 'Hobby', done: true },
      { label: 'Submit', done: true },
    ]
    expect(questionPositionLabel(tabs, false)).toBe('Pergunta 2 de 2')
  })
})
