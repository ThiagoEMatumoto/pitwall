// Sonda ao vivo: diálogo de aprovação de plano (ExitPlanMode) do claude 2.1.317.
// Derivada de probe-chat-permission-2316.ts. Uso:
//   npx tsx e2e/scenarios/probe-chat-plan-2317.ts <cenario>
// Env: PROBE_SB (sandbox; cwd da sessão e saídas brutas ficam em PROBE_SB/<cenario>/),
//      PROBE_FIXTURES=1 copia os dumps marcados como fixture para shared/tui/__fixtures__.
// Cenários e2e-* respondem pelo caminho de produção (parseTuiMenuFull -> buildPlanKeys ou
// keysForAction -> playKeys) e terminam com [verdict] PASS/FAIL; exit 1 se alguma expectativa
// falhar. question-multi-keys*, question-single-keys e question-multi-chat-digit são
// exploratórios: registram o que cada tecla faz (fonte das teclas de respond-keys).
// Cada cenário declara flags extras, prompt inicial e passos. Um dump grava .txt (tela do
// xterm headless) e .ansi (bytes do PTY desde o último dump), roda parseTuiMenuFull real e
// loga status de ~/.claude/sessions/<pid>.json e o estado do ExitPlanMode no JSONL.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import {
  buildPlanKeys,
  findPlanOption,
  PLAN_KEY_DELAY_MS,
  playKeys,
} from '../../shared/tui/respond-keys'
import { parseTuiMenuFull, type PlanIntent, type TuiMenu } from '../../shared/tui/tui-menu-parser'
import { actionKeyDelay, keysForAction } from '../../shared/tui/menu-actions'
import type { AttentionAction } from '../../shared/types/ipc'
import { parseTuiPicker } from '../../src/features/sessions/tui-picker-parser'

const xtermHeadless = createRequire(import.meta.url)(
  process.env.XTERM_HEADLESS ?? '@xterm/headless',
)
const { Terminal } = xtermHeadless as unknown as {
  Terminal: new (o: Record<string, unknown>) => any
}

// Nome das fixtures: a versão instalada (o 2.1.318 já desenha as mesmas telas do 2.1.317).
const CLAUDE_VERSION =
  execFileSync('claude', ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown'
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../shared/tui/__fixtures__')
const SB = process.env.PROBE_SB ?? join(tmpdir(), 'pitwall-probe-chat-plan-2317')

const KEYS = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  'ctrl-c': '\x03',
  'ctrl-g': '\x07',
  'ctrl-r': '\x12',
  'ctrl-u': '\x15',
  backspace: '\x7f',
  space: ' ',
  'paste-start': '\x1b[200~',
  'paste-end': '\x1b[201~',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
} as const
type KeyName = keyof typeof KEYS

type Step =
  | { wait: 'menu'; kind: TuiMenu['kind']; timeout?: number }
  | { wait: 'text'; re: RegExp; timeout?: number }
  | { wait: 'idle'; timeout?: number }
  | { keys: KeyName[]; gapMs?: number }
  | { type: string }
  // Digita um prompt e manda Enter (como um envio pelo composer).
  | { submit: string }
  // Bracketed paste, como o Composer injeta texto.
  | { paste: string }
  // Espera o menu do kind sumir da tela.
  | { wait: 'gone'; kind: TuiMenu['kind']; timeout?: number }
  // Loga o arquivo do plano citado no rodapé (~/.claude/plans/<slug>.md).
  | { planfile: string }
  | { sleep: number }
  // Escolhe a opção do menu atual cujo label casa e tecla o dígito dela (como o card faria).
  | { pick: RegExp }
  // Move o cursor (setas) até a opção cujo label casa, sem selecionar.
  | { nav: RegExp }
  // Loga as últimas linhas não vazias da tela (rodapé com o modo de permissão).
  | { footer: string }
  | { dump: string; fixture?: string }
  // awaitUseMs: espera o tool_use do ExitPlanMode chegar ao JSONL e loga o atraso do flush.
  | { jsonl: string; fixture?: string; awaitUseMs?: number; tool?: string }
  // Lê o log dos hooks (Scenario.hookLog): evento, tool, campos e atraso vs. 1º parse do menu.
  | { hooklog: string; fixture?: string }
  // Responde o diálogo de plano como o card: parse fresco + buildPlanKeys + playKeys.
  | { respond: PlanIntent | 'reject'; feedback?: string }
  // Expectativas (entram no [verdict]): rodapé da tela e último tool_result do ExitPlanMode.
  | { expectFooter: RegExp; timeout?: number }
  | { expectResult: { isError: boolean; feedback?: string }; timeout?: number }
  // Responde pelo caminho de produção dos cards (keysForAction + playKeys) a partir do
  // parse fresco. Opção por índice ou pelo label; other/chat acham a sentinela.
  | { act: Act }
  // Último tool_result do AskUserQuestion: respostas contêm cada texto / recusa com feedback.
  | { expectAnswers: string[] | 'checked'; timeout?: number }
  | { expectRejected: RegExp; timeout?: number }
  // Menu atual (parse fresco) com esse kind e, se dado, título; null = nenhum menu.
  | { expectMenu: { kind: TuiMenu['kind']; question?: RegExp } | null; timeout?: number }
  // Só verificação (sem tecla): status da sessão em ~/.claude/sessions/<pid>.json.
  | { expectStatus: string }
  | { expectNoFile: string }
  // Esc até a sessão voltar a idle sem menu (no máx. n vezes): fecha o diálogo seja qual for o nível.
  | { escUntilIdle: number }
  // Arquivo do cwdSetup segue byte a byte igual (o diálogo não gravou nada nele).
  | { expectUnchanged: string }

type Act =
  | { kind: 'toggle'; label: RegExp | number }
  | { kind: 'other'; text: string }
  | { kind: 'submit-multi' }
  | { kind: 'chat' }
  | { kind: 'esc' }
  | { kind: 'tab'; direction: 'next' | 'prev' }
  | { kind: 'select'; label: RegExp | number }

interface Scenario {
  args: string[]
  env?: Record<string, string>
  // Arquivos criados no SB antes do spawn (path relativo ao SB -> conteúdo, modo 0755).
  setup?: Record<string, string>
  // Arquivos criados no cwd da sessão antes do spawn (path relativo ao cwd -> conteúdo).
  cwdSetup?: Record<string, string>
  prompt: string
  // Diálogo cuja latência é medida: texto no PTY vs. 1º parse com o kind esperado.
  latency?: { kind: TuiMenu['kind']; textRe: RegExp }
  // Tool cujo tool_use/tool_result o passo jsonl acompanha (default ExitPlanMode).
  tool?: string
  // Arquivo que hooks só-observação anexam; a sonda faz polling e carimba a chegada de cada linha.
  hookLog?: string
  steps: Step[]
}

const PLAN_PROMPT =
  "Planeje criar um arquivo hello.txt com o conteudo 'oi'. Nao crie nada: so escreva um plano de uma linha e chame ExitPlanMode."
// Variante que aceita execução depois de aprovado (o default proíbe criar o arquivo).
const PLAN_PROMPT_EXEC =
  "Planeje criar um arquivo hello.txt neste diretorio com o conteudo 'oi'. Escreva um plano de uma linha e chame ExitPlanMode; se aprovado, crie so esse arquivo e pare."
const PLAN_LATENCY = { kind: 'plan' as const, textRe: /Would you like to proceed/ }
const BASE_ARGS = ['--model', 'claude-haiku-5-5', '--effort', 'low', '--permission-mode', 'plan']
const planCapture = (name: string): Step[] => [
  { wait: 'menu', kind: 'plan', timeout: 180_000 },
  { dump: '10-plan-dialog', fixture: name },
  { jsonl: 'before-answer', fixture: name, awaitUseMs: 10_000 },
]

const QUESTION_ARGS = ['--model', 'claude-haiku-5-5', '--effort', 'low']
const QUESTION_LATENCY = { kind: 'question' as const, textRe: /Type\s+something/ }
const questionCapture = (name: string): Step[] => [
  { wait: 'menu', kind: 'question', timeout: 180_000 },
  { dump: '10-question', fixture: name },
  { jsonl: 'before-answer', awaitUseMs: 10_000 },
]

const DEFAULT_ARGS = ['--model', 'claude-haiku-5-5', '--effort', 'low', '--permission-mode', 'default']
const THREE_PROMPTS: Step[] = [
  { wait: 'idle', timeout: 90_000 },
  { submit: 'diga b' },
  { wait: 'idle', timeout: 90_000 },
  { submit: 'diga c' },
  { wait: 'idle', timeout: 90_000 },
]

// fixture=false: a tela tem dado da conta (ex.: /mcp lista os conectores) ou já tem parser.
const slashMenu = (cmd: string, n: number, fixture = true): Step[] => [
  { submit: `/${cmd}` },
  { sleep: 2500 },
  { dump: `${n}-${cmd}`, ...(fixture ? { fixture: `unknown-${cmd}` } : {}) },
  { keys: ['down'] },
  { sleep: 800 },
  { dump: `${n + 1}-${cmd}-down`, ...(fixture ? { fixture: `unknown-${cmd}-down` } : {}) },
  { keys: ['esc'] },
  { sleep: 1500 },
  { dump: `${n + 2}-${cmd}-esc` },
  { keys: ['esc'] },
  { sleep: 1200 },
]

const FAKE_EDITOR = 'fake-editor.sh'
const FAKE_EDITOR_LINE = '- linha anexada pelo editor falso da sonda'

// Hooks só-observação: o script anexa o stdin ao log e sai 0 sem saída (não decide nada).
const HOOK_DIR = join(SB, 'hook-spike')
const HOOK_SCRIPT = join(HOOK_DIR, 'hook-log.sh')
const HOOK_LOG = join(HOOK_DIR, 'log.jsonl')
const HOOK_SETTINGS = join(HOOK_DIR, 'settings.json')
const observeHook = [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_SCRIPT }] }]

// Fecha a sessão depois do Write negado: o turno pode seguir, o que importa já foi medido.
const denyWrite: Step[] = [
  { wait: 'menu', kind: 'permission', timeout: 90_000 },
  { dump: '50-write-permission' },
  { keys: ['esc'] },
  { sleep: 2000 },
]
const NO_AUTO = JSON.stringify({ disableAutoMode: 'disable' })

// /hooks e /permissions populados (as fixtures unknown-* só têm as telas vazias): 24 hooks
// inócuos em 7 eventos + 3 ask + 3 deny no .claude/settings.json do cwd, e 12 allow via
// --settings. O /hooks não lista hooks de --settings, e o allow do projeto não aparece
// numa pasta sem trust; regra de --settings abre "Rule details" read-only.
let noopN = 0
// `true` ignora argumentos; o sufixo só evita que hooks iguais sejam deduplicados.
const noop = (matcher?: string) => ({
  ...(matcher ? { matcher } : {}),
  hooks: [{ type: 'command', command: `true pitwall-hook-${++noopN}` }],
})
const SEED_HOOKS = {
  PreToolUse: [noop('Bash'), noop('Edit|Write'), noop('Read'), noop('Agent'), noop('Grep')],
  PostToolUse: [noop('Bash'), noop('Edit|Write'), noop('Read'), noop('Glob')],
  UserPromptSubmit: [noop(), noop(), noop()],
  SessionStart: [noop('startup'), noop('resume'), noop('clear'), noop('compact')],
  Stop: [noop(), noop(), noop()],
  Notification: [noop(), noop()],
  PreCompact: [noop('manual'), noop('auto'), noop()],
}
const SEED_ALLOW = {
  allow: [
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(ls:*)',
    'Bash(cat:*)',
    'Bash(npm test:*)',
    'Bash(npm run typecheck)',
    'Read(./src/**)',
    'Grep',
    'Glob',
    'WebSearch',
    'Bash(echo:*)',
  ],
}
const SEED_PERMISSIONS = {
  ask: ['Bash(git push:*)', 'Bash(npm publish:*)', 'Edit(./docs/**)'],
  deny: ['Bash(rm -rf:*)', 'Read(./.env)', 'Bash(curl:*)'],
}
const SEED_FLAG = join(SB, 'seed', 'allow.json')
const SEED_ARGS = [...DEFAULT_ARGS, '--settings', SEED_FLAG]
const SEED_SETUP = { 'seed/allow.json': JSON.stringify({ permissions: SEED_ALLOW }, null, 2) }
const SEED_CWD = {
  '.claude/settings.json':
    JSON.stringify({ hooks: SEED_HOOKS, permissions: SEED_PERMISSIONS }, null, 2) + '\n',
}


const SCENARIOS: Record<string, Scenario> = {
  'e2e-approve-auto': {
    args: BASE_ARGS,
    prompt: PLAN_PROMPT_EXEC,
    steps: [
      { wait: 'menu', kind: 'plan', timeout: 180_000 },
      { dump: '10-plan-dialog' },
      { respond: 'approve-auto' },
      { expectFooter: /⏵⏵ auto mode on/ },
      { expectResult: { isError: false } },
      { dump: '40-after-approve' },
      { wait: 'idle', timeout: 120_000 },
      { dump: '41-idle' },
    ],
  },
  'e2e-approve-manual': {
    args: [...BASE_ARGS, '--settings', NO_AUTO],
    prompt: PLAN_PROMPT_EXEC,
    steps: [
      { wait: 'menu', kind: 'plan', timeout: 180_000 },
      { dump: '10-plan-dialog' },
      { respond: 'approve-manual' },
      { expectFooter: /⏸ manual mode on/ },
      { expectResult: { isError: false } },
      { dump: '40-after-approve' },
      ...denyWrite,
    ],
  },
  'e2e-feedback': {
    args: BASE_ARGS,
    prompt: PLAN_PROMPT,
    steps: [
      { wait: 'menu', kind: 'plan', timeout: 180_000 },
      { dump: '10-plan-dialog' },
      { respond: 'feedback', feedback: 'adicione também um bye.txt' },
      { expectResult: { isError: true, feedback: 'adicione também um bye.txt' } },
      { dump: '20-after-feedback' },
      { wait: 'text', re: /User rejected Claude's plan/, timeout: 60_000 },
      { wait: 'menu', kind: 'plan', timeout: 120_000 },
      { dump: '30-plan-dialog-2' },
      { respond: 'reject' },
      { sleep: 2000 },
      { dump: '31-after-esc' },
    ],
  },
  // Cursor levado ao campo por setas (não pelo dígito): o campo fica focado e vazio, e um
  // dígito ali vira texto. Aprovar precisa sair do campo antes.
  'e2e-cursor-on-feedback-approve': {
    args: BASE_ARGS,
    prompt: PLAN_PROMPT,
    steps: [
      { wait: 'menu', kind: 'plan', timeout: 180_000 },
      { dump: '10-plan-dialog' },
      { keys: ['down', 'down'], gapMs: 600 },
      { sleep: 800 },
      { dump: '20-cursor-on-feedback', fixture: 'plan-feedback-cursor-arrows' },
      { respond: 'approve-manual' },
      { expectFooter: /manual mode on/ },
      { expectResult: { isError: false } },
      { dump: '40-after-approve' },
      { sleep: 2000 },
    ],
  },
  'e2e-cursor-on-feedback-feedback': {
    args: BASE_ARGS,
    prompt: PLAN_PROMPT,
    steps: [
      { wait: 'menu', kind: 'plan', timeout: 180_000 },
      { dump: '10-plan-dialog' },
      { keys: ['down', 'down'], gapMs: 600 },
      { sleep: 800 },
      { dump: '20-cursor-on-feedback' },
      { respond: 'feedback', feedback: 'teste cursor' },
      { expectResult: { isError: true, feedback: 'teste cursor' } },
      { dump: '30-after-feedback' },
      { sleep: 2000 },
    ],
  },
  'e2e-clear-context-manual': {
    args: [...BASE_ARGS, '--settings', JSON.stringify({ showClearContextOnPlanAccept: true })],
    prompt: PLAN_PROMPT_EXEC,
    steps: [
      { wait: 'menu', kind: 'plan', timeout: 180_000 },
      { dump: '10-plan-dialog' },
      { respond: 'approve-manual' },
      { expectFooter: /⏸ manual mode on/ },
      { expectResult: { isError: false } },
      { dump: '40-after-approve' },
      ...denyWrite,
    ],
  },
  'plan-default': {
    args: BASE_ARGS,
    prompt: PLAN_PROMPT,
    latency: PLAN_LATENCY,
    steps: [
      ...planCapture('plan-default'),
      { keys: ['esc'] },
      { sleep: 2500 },
      { dump: '11-after-esc', fixture: 'plan-default-after-esc' },
      { jsonl: 'after-esc', fixture: 'plan-default-after-esc' },
      { wait: 'idle', timeout: 60_000 },
      { dump: '12-idle' },
    ],
  },
  // Auto mode disponível (default do haiku-5-5): aprova por dígito em "use auto mode" e
  // registra o modo resultante e o tool_result. A execução fica no cwd do sandbox.
  'plan-auto-approve': {
    args: BASE_ARGS,
    prompt: PLAN_PROMPT_EXEC,
    latency: PLAN_LATENCY,
    steps: [
      ...planCapture('plan-auto'),
      { pick: /use auto mode/ },
      { sleep: 2500 },
      { dump: '40-after-approve', fixture: 'plan-auto-after-approve' },
      { footer: 'after-approve' },
      { jsonl: 'after-approve', fixture: 'plan-auto-after-approve' },
      { wait: 'idle', timeout: 120_000 },
      { dump: '41-idle' },
      { footer: 'idle' },
      { jsonl: 'idle' },
    ],
  },
  // Auto mode indisponível por setting: isola o rótulo sem "use auto mode" e aprova
  // manualmente por dígito. O Write seguinte pede permissão; ela é negada com Esc.
  'plan-no-auto': {
    args: [...BASE_ARGS, '--settings', JSON.stringify({ disableAutoMode: 'disable' })],
    prompt: PLAN_PROMPT_EXEC,
    latency: PLAN_LATENCY,
    steps: [
      ...planCapture('plan-no-auto'),
      { pick: /manually approve/ },
      { sleep: 2500 },
      { dump: '40-after-manual', fixture: 'plan-no-auto-after-manual' },
      { footer: 'after-manual' },
      { jsonl: 'after-manual', fixture: 'plan-no-auto-after-manual' },
      { wait: 'menu', kind: 'permission', timeout: 90_000 },
      { dump: '41-write-permission' },
      { footer: 'write-permission' },
      { keys: ['esc'] },
      { sleep: 2500 },
      { dump: '42-after-deny' },
      { footer: 'after-deny' },
      { jsonl: 'after-deny' },
    ],
  },
  'plan-bypass': {
    args: [...BASE_ARGS, '--allow-dangerously-skip-permissions'],
    prompt: PLAN_PROMPT,
    latency: PLAN_LATENCY,
    steps: [
      ...planCapture('plan-bypass'),
      { keys: ['esc'] },
      { sleep: 2500 },
      { jsonl: 'after-esc' },
    ],
  },
  'plan-clear-context': {
    args: [...BASE_ARGS, '--settings', JSON.stringify({ showClearContextOnPlanAccept: true })],
    prompt: PLAN_PROMPT,
    latency: PLAN_LATENCY,
    steps: [
      ...planCapture('plan-clear-context'),
      { keys: ['esc'] },
      { sleep: 2500 },
      { jsonl: 'after-esc' },
    ],
  },
  // "No, keep planning" + feedback: navega até a última opção (input) e digita.
  'plan-feedback': {
    args: BASE_ARGS,
    prompt: PLAN_PROMPT,
    latency: PLAN_LATENCY,
    steps: [
      ...planCapture('plan-feedback'),
      { keys: ['up'] },
      { sleep: 600 },
      { dump: '20-cursor-keep-planning', fixture: 'plan-feedback-cursor' },
      { type: 'use o arquivo ola.txt' },
      { sleep: 800 },
      { dump: '21-feedback-typed', fixture: 'plan-feedback-typed' },
      { keys: ['enter'] },
      { sleep: 3000 },
      { jsonl: 'after-feedback' },
      { dump: '22-after-feedback' },
      { keys: ['esc'] },
      { sleep: 1500 },
    ],
  },
  // Feedback por dígito na opção de input + paste, replanejamento, e Ctrl+G no 2º diálogo
  // com EDITOR/VISUAL num script que só anexa uma linha ao arquivo recebido.
  'plan-feedback-ctrlg': {
    args: BASE_ARGS,
    env: { EDITOR: join(SB, FAKE_EDITOR), VISUAL: join(SB, FAKE_EDITOR) },
    setup: {
      [FAKE_EDITOR]: `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(SB, 'fake-editor-calls.log')}"\nfor f; do case "$f" in -*) ;; *) printf '\\n${FAKE_EDITOR_LINE}\\n' >> "$f";; esac; done\nexit 0\n`,
    },
    prompt: PLAN_PROMPT,
    latency: PLAN_LATENCY,
    steps: [
      ...planCapture('plan-feedback'),
      { footer: 'plan-1' },
      { pick: /Tell Claude what to change|keep planning/ },
      { sleep: 1000 },
      { dump: '20-feedback-input', fixture: 'plan-feedback-input' },
      { footer: 'feedback-input' },
      { paste: 'adicione também um bye.txt' },
      { sleep: 800 },
      { dump: '21-feedback-typed', fixture: 'plan-feedback-typed' },
      { keys: ['enter'] },
      { sleep: 2500 },
      { dump: '22-after-feedback', fixture: 'plan-feedback-after-submit' },
      { jsonl: 'after-feedback', fixture: 'plan-feedback-after-submit' },
      // O tool_use do 2º ExitPlanMode não chega ao JSONL com o diálogo aberto: o sinal é a tela.
      { wait: 'text', re: /User rejected Claude's plan/, timeout: 60_000 },
      { wait: 'menu', kind: 'plan', timeout: 120_000 },
      { dump: '30-plan-dialog-2', fixture: 'plan-replanned' },
      { jsonl: 'replanned', fixture: 'plan-replanned' },
      { footer: 'plan-2' },
      { planfile: 'before-ctrl-g' },
      { keys: ['ctrl-g'] },
      { sleep: 3000 },
      { dump: '31-after-ctrl-g', fixture: 'plan-ctrlg' },
      { footer: 'after-ctrl-g' },
      { planfile: 'after-ctrl-g' },
      { sleep: 2000 },
      { dump: '32-after-ctrl-g-settled', fixture: 'plan-ctrlg-settled' },
      { jsonl: 'after-ctrl-g' },
      { keys: ['esc'] },
      { sleep: 2500 },
      { dump: '33-after-esc' },
      { jsonl: 'after-esc', fixture: 'plan-feedback-ctrlg-after-esc' },
    ],
  },
  'plan-ctrl-g': {
    args: BASE_ARGS,
    prompt: PLAN_PROMPT,
    latency: PLAN_LATENCY,
    steps: [
      ...planCapture('plan-ctrl-g'),
      { keys: ['ctrl-g'] },
      { sleep: 3000 },
      { dump: '30-after-ctrl-g', fixture: 'plan-ctrl-g' },
      { keys: ['esc'] },
      { sleep: 1500 },
      { dump: '31-after-ctrl-g-esc' },
    ],
  },
  // AskUserQuestion multiSelect: navega até "Type something", digita, vai até a revisão e envia.
  'question-multi-other': {
    args: QUESTION_ARGS,
    tool: 'AskUserQuestion',
    prompt:
      "Use a ferramenta AskUserQuestion com UMA pergunta multiSelect com 3 opções sobre cores favoritas. Depois da resposta, só diga ok e pare.",
    latency: QUESTION_LATENCY,
    steps: [
      ...questionCapture('question-multi-other'),
      { nav: /^Type something/ },
      { sleep: 800 },
      { dump: '20-other-typing', fixture: 'question-multi-other-typing' },
      { type: 'verde agua' },
      { sleep: 800 },
      { dump: '21-other-typed', fixture: 'question-multi-other-typed' },
      // Enter dentro do input do Other não marca o checkbox nem avança (visto ao vivo).
      { keys: ['down'] },
      { sleep: 1000 },
      { dump: '22-cursor-submit', fixture: 'question-multi-other-cursor-submit' },
      { keys: ['enter'] },
      { sleep: 1500 },
      { dump: '23-after-submit-line' },
      { wait: 'menu', kind: 'question_review', timeout: 10_000 },
      { dump: '30-review', fixture: 'question-review' },
      { jsonl: 'review' },
      { pick: /Submit answers/ },
      { sleep: 3000 },
      { dump: '31-after-submit', fixture: 'question-multi-other-after-submit' },
      { jsonl: 'after-submit', fixture: 'question-multi-other' },
      // Pós-turno o 2.1.317 pode abrir "Teach auto mode about your environment?" com a
      // sessão já idle; o parser o lê como question. Fica como fixture de menu desconhecido.
      { sleep: 3000 },
      { dump: '32-post-turn', fixture: 'auto-mode-env-nudge' },
      { keys: ['esc'] },
      { sleep: 1500 },
      { dump: '33-after-nudge-esc' },
    ],
  },
  // Exploratório (Fase 2): o que cada tecla faz no multi-select do 2.1.317. Cada dump
  // registra a tela depois de uma tecla; o que o card usa sai daqui.
  'question-multi-keys': {
    args: QUESTION_ARGS,
    tool: 'AskUserQuestion',
    prompt:
      "Use a ferramenta AskUserQuestion com UMA pergunta multiSelect com 3 opções sobre frutas favoritas. Depois da resposta, só diga ok e pare.",
    latency: QUESTION_LATENCY,
    steps: [
      ...questionCapture('question-multi-keys'),
      { keys: ['1'] },
      { sleep: 900 },
      { dump: '20-digit1', fixture: 'question-multi-keys-digit1' },
      { keys: ['1'] },
      { sleep: 900 },
      { dump: '21-digit1-again', fixture: 'question-multi-keys-digit1-again' },
      { keys: ['2'] },
      { sleep: 900 },
      { dump: '22-digit2', fixture: 'question-multi-keys-digit2' },
      { keys: ['space'] },
      { sleep: 900 },
      { dump: '23-space', fixture: 'question-multi-keys-space' },
      { keys: ['down'] },
      { sleep: 900 },
      { dump: '24-down' },
      { keys: ['enter'] },
      { sleep: 1200 },
      { dump: '25-enter-on-option', fixture: 'question-multi-keys-enter-option' },
      { keys: ['4'] },
      { sleep: 900 },
      { dump: '26-digit-other', fixture: 'question-multi-keys-digit-other' },
      { type: 'roxo' },
      { sleep: 900 },
      { dump: '27-other-typed' },
      { keys: ['up'] },
      { sleep: 900 },
      { dump: '28-up-from-other', fixture: 'question-multi-keys-up-from-other' },
      { keys: ['right'] },
      { sleep: 1200 },
      { dump: '29-right', fixture: 'question-multi-keys-right' },
      { keys: ['enter'] },
      { sleep: 1200 },
      { dump: '30-enter-after-right', fixture: 'question-multi-keys-enter-after-right' },
      { keys: ['2'] },
      { sleep: 1200 },
      { dump: '31-review-cancel', fixture: 'question-multi-keys-review-cancel' },
      { keys: ['esc'] },
      { sleep: 2500 },
      { dump: '32-esc' },
      { jsonl: 'end' },
    ],
  },
  // Exploratório (Fase 2): ↓ até a linha Submit passando pelo Other vazio, Enter nela,
  // Cancel e Esc na revisão, e o Other com texto seguido de ↓.
  'question-multi-keys2': {
    args: QUESTION_ARGS,
    tool: 'AskUserQuestion',
    prompt:
      "Use a ferramenta AskUserQuestion com UMA pergunta multiSelect com 3 opções sobre frutas favoritas. Depois da resposta, só diga ok e pare.",
    latency: QUESTION_LATENCY,
    steps: [
      ...questionCapture('question-multi-keys2'),
      { keys: ['2'] },
      { sleep: 900 },
      { keys: ['down', 'down', 'down', 'down'], gapMs: 400 },
      { sleep: 900 },
      { dump: '20-down4-submit-line', fixture: 'question-multi-submit-line' },
      { keys: ['enter'] },
      { sleep: 1500 },
      { dump: '21-enter-on-submit', fixture: 'question-multi-review-no-other' },
      { keys: ['2'] },
      { sleep: 1500 },
      { dump: '22-review-cancel', fixture: 'question-multi-after-review-cancel' },
      { jsonl: 'after-cancel' },
      { sleep: 6000 },
      { dump: '23-later' },
    ],
  },
  // Exploratório (Fase 2): o dígito da sentinela chat no multi-select.
  'question-multi-chat-digit': {
    args: QUESTION_ARGS,
    tool: 'AskUserQuestion',
    prompt:
      "Use a ferramenta AskUserQuestion com UMA pergunta multiSelect com 3 opções sobre frutas favoritas. Depois da resposta, só diga ok e pare.",
    latency: QUESTION_LATENCY,
    steps: [
      ...questionCapture('question-multi-chat-digit'),
      { keys: ['5'] },
      { sleep: 3000 },
      { dump: '20-digit-chat' },
      { jsonl: 'after-digit-chat' },
    ],
  },
  // Exploratório (Fase 2): no single-select, o dígito do Other foca o campo? E o da
  // sentinela chat responde? Duas perguntas na mesma sessão.
  'question-single-keys': {
    args: QUESTION_ARGS,
    tool: 'AskUserQuestion',
    prompt:
      'Use a ferramenta AskUserQuestion com UMA pergunta single-select (multiSelect false) com 3 opções sobre linguagem de programação favorita. Depois da resposta, só diga ok e pare.',
    latency: QUESTION_LATENCY,
    steps: [
      ...questionCapture('question-single-keys'),
      { keys: ['4'] },
      { sleep: 900 },
      { dump: '20-digit-other', fixture: 'question-single-digit-other' },
      { type: 'Rust 2' },
      { sleep: 900 },
      { dump: '21-other-typed', fixture: 'question-single-other-typed' },
      { keys: ['enter'] },
      { sleep: 3000 },
      { dump: '22-after-enter' },
      { jsonl: 'after-other' },
      { sleep: 6000 },
      { dump: '23-idle' },
      { keys: ['esc'] },
      { sleep: 800 },
      {
        submit:
          'Agora use AskUserQuestion de novo com UMA pergunta single-select com 3 opções sobre editor favorito. Depois da resposta, só diga ok e pare.',
      },
      { wait: 'menu', kind: 'question', timeout: 180_000 },
      { dump: '30-question2' },
      { keys: ['5'] },
      { sleep: 3000 },
      { dump: '31-digit-chat', fixture: 'question-single-digit-chat' },
      { jsonl: 'after-digit-chat' },
    ],
  },
  // e2e (Fase 2): multi-select respondido pelos cards — marca 2 opções, Other com texto,
  // Enviar respostas, revisão. O tool_result tem que trazer as 3.
  'e2e-multi-other': {
    args: QUESTION_ARGS,
    tool: 'AskUserQuestion',
    prompt:
      "Use a ferramenta AskUserQuestion com UMA pergunta multiSelect com 3 opções sobre cores favoritas. Depois da resposta, só diga ok e pare.",
    latency: QUESTION_LATENCY,
    steps: [
      { wait: 'menu', kind: 'question', timeout: 180_000 },
      { dump: '10-question' },
      { act: { kind: 'toggle', label: 0 } },
      { sleep: 900 },
      { act: { kind: 'toggle', label: 1 } },
      { sleep: 900 },
      { dump: '20-two-checked' },
      { act: { kind: 'other', text: 'roxo' } },
      { sleep: 1200 },
      { dump: '21-other-marked' },
      { act: { kind: 'submit-multi' } },
      { wait: 'menu', kind: 'question_review', timeout: 10_000 },
      { dump: '30-review' },
      { act: { kind: 'select', label: /^Submit answers$/ } },
      { expectAnswers: 'checked', timeout: 20_000 },
      { jsonl: 'after-submit' },
    ],
  },
  // e2e (Fase 2): "Conversar sobre isso" pelo card no single-select.
  'e2e-chat-sentinel': {
    args: QUESTION_ARGS,
    tool: 'AskUserQuestion',
    prompt:
      'Use a ferramenta AskUserQuestion com UMA pergunta single-select (multiSelect false) com 3 opções sobre linguagem de programação favorita. Depois da resposta, só diga ok e pare.',
    latency: QUESTION_LATENCY,
    steps: [
      { wait: 'menu', kind: 'question', timeout: 180_000 },
      { dump: '10-question' },
      { act: { kind: 'chat' } },
      { expectRejected: /The user wants to clarify these questions/, timeout: 20_000 },
      { jsonl: 'after-chat' },
    ],
  },
  // Exploratório: /hooks e /permissions com conteúdo (24 hooks, 18 regras). Registra o
  // layout e o que cada tecla faz em cada estado (abas, busca, lista, detalhe).
  'populated-menus': {
    args: SEED_ARGS,
    setup: SEED_SETUP,
    cwdSetup: SEED_CWD,
    tool: 'none',
    prompt: 'diga oi',
    steps: [
      { wait: 'idle', timeout: 90_000 },
      { type: '/hooks' },
      { sleep: 700 },
      { keys: ['enter'] },
      { sleep: 2000 },
      { dump: '10-hooks', fixture: 'populated-hooks' },
      { keys: ['down', 'down', 'down'] },
      { sleep: 800 },
      { dump: '11-hooks-down3', fixture: 'populated-hooks-down3' },
      { keys: ['down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down'] },
      { sleep: 800 },
      { dump: '12-hooks-scrolled', fixture: 'populated-hooks-scrolled' },
      { type: '2' },
      { sleep: 800 },
      { dump: '13-hooks-digit' },
      { keys: ['enter'] },
      { sleep: 1200 },
      { dump: '14-hooks-detail', fixture: 'populated-hooks-detail' },
      { keys: ['down', 'enter'] },
      { sleep: 800 },
      { dump: '15-hooks-detail-keys' },
      { keys: ['esc'] },
      { sleep: 1200 },
      { dump: '16-hooks-back' },
      { escUntilIdle: 4 },
      { wait: 'idle', timeout: 15_000 },
      { type: '/permissions' },
      { sleep: 700 },
      { keys: ['enter'] },
      { sleep: 2000 },
      { dump: '20-perm', fixture: 'populated-permissions' },
      { keys: ['down'] },
      { sleep: 800 },
      { dump: '21-perm-list', fixture: 'populated-permissions-list' },
      { keys: ['down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down'] },
      { sleep: 800 },
      { dump: '22-perm-list-scrolled', fixture: 'populated-permissions-list-scrolled' },
      { keys: ['up', 'up'] },
      { sleep: 800 },
      { dump: '23-perm-list-scrolled-up2' },
      { type: '4' },
      { sleep: 1000 },
      { dump: '24-perm-scrolled-digit', fixture: 'populated-permissions-rule-readonly' },
      { keys: ['esc'] },
      { sleep: 1200 },
      { dump: '25-perm-after-esc' },
      { keys: ['up', 'up', 'up'] },
      { sleep: 800 },
      { type: '3' },
      { sleep: 1000 },
      { dump: '26-perm-list-up3-digit' },
      { keys: ['down', 'right'] },
      { sleep: 800 },
      { dump: '27-perm-readonly-keys' },
      { keys: ['esc'] },
      { sleep: 1200 },
      { dump: '28-perm-readonly-esc' },
      { escUntilIdle: 4 },
      { wait: 'idle', timeout: 15_000 },
      { type: '/permissions' },
      { sleep: 700 },
      { keys: ['enter'] },
      { sleep: 2000 },
      { type: '3' },
      { sleep: 1000 },
      { dump: '30-perm-digit', fixture: 'populated-permissions-digit' },
      { keys: ['backspace'] },
      { sleep: 800 },
      { dump: '31-perm-search-cleared' },
      { type: 'g' },
      { sleep: 800 },
      { dump: '32-perm-search', fixture: 'populated-permissions-search' },
      { keys: ['left', 'right'] },
      { sleep: 800 },
      { dump: '33-perm-search-arrows' },
      { keys: ['esc'] },
      { sleep: 1000 },
      { dump: '34-perm-search-esc', fixture: 'populated-permissions-search-esc' },
      { keys: ['esc'] },
      { sleep: 1000 },
      { dump: '35-perm-search-esc2' },
      { escUntilIdle: 4 },
      { wait: 'idle', timeout: 15_000 },
      { type: '/permissions' },
      { sleep: 700 },
      { keys: ['enter'] },
      { sleep: 2000 },
      { keys: ['right'] },
      { sleep: 800 },
      { dump: '40-perm-ask', fixture: 'populated-permissions-ask' },
      { keys: ['right'] },
      { sleep: 800 },
      { dump: '41-perm-deny', fixture: 'populated-permissions-deny' },
      { keys: ['left'] },
      { sleep: 800 },
      { keys: ['down', 'down'] },
      { sleep: 800 },
      { dump: '42-perm-ask-list', fixture: 'populated-permissions-ask-list' },
      { keys: ['enter'] },
      { sleep: 1200 },
      { dump: '43-perm-delete', fixture: 'populated-permissions-delete' },
      { keys: ['esc'] },
      { sleep: 1200 },
      { dump: '44-perm-delete-esc' },
      { keys: ['up', 'up'] },
      { sleep: 800 },
      { dump: '45-perm-up-to-tabs' },
      { escUntilIdle: 4 },
      { wait: 'idle', timeout: 15_000 },
      { expectNoFile: '.claude/settings.local.json' },
      { expectUnchanged: '.claude/settings.json' },
    ],
  },
  // e2e: /hooks e /permissions populados pelo card genérico. Abre o detalhe de um hook e de
  // uma regra read-only, recusa o "Delete ask tool?" com No, limpa a busca e fecha tudo por
  // Esc, sem gravar nada no cwd.
  'e2e-populated-menus': {
    args: SEED_ARGS,
    setup: SEED_SETUP,
    cwdSetup: SEED_CWD,
    tool: 'none',
    prompt: 'diga oi',
    steps: [
      { wait: 'idle', timeout: 90_000 },
      { type: '/hooks' },
      { sleep: 700 },
      { keys: ['enter'] },
      { expectMenu: { kind: 'menu', question: /^Hooks$/ }, timeout: 10_000 },
      { expectStatus: 'waiting' },
      { act: { kind: 'select', label: /pitwall-hook-6 / } },
      { expectMenu: { kind: 'menu', question: /^Command hook$/ }, timeout: 5_000 },
      { dump: '10-hook-detail' },
      { act: { kind: 'esc' } },
      { expectMenu: { kind: 'menu', question: /^Hooks$/ }, timeout: 5_000 },
      { act: { kind: 'esc' } },
      { expectMenu: null, timeout: 10_000 },
      { wait: 'idle', timeout: 30_000 },
      { type: '/permissions' },
      { sleep: 700 },
      { keys: ['enter'] },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ }, timeout: 10_000 },
      { act: { kind: 'select', label: /^Bash\(echo:/ } },
      { expectMenu: { kind: 'menu', question: /^Rule details$/ }, timeout: 5_000 },
      { dump: '20-rule-details' },
      { act: { kind: 'esc' } },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ }, timeout: 5_000 },
      { act: { kind: 'tab', direction: 'next' } },
      { sleep: 900 },
      { act: { kind: 'select', label: /^Bash\(git push:/ } },
      { expectMenu: { kind: 'menu', question: /^Delete ask tool\?$/ }, timeout: 5_000 },
      { dump: '21-delete-confirm' },
      { act: { kind: 'select', label: /^No$/ } },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ }, timeout: 5_000 },
      { dump: '22-after-no' },
      { act: { kind: 'esc' } },
      { expectMenu: null, timeout: 10_000 },
      { wait: 'idle', timeout: 30_000 },
      { type: '/permissions' },
      { sleep: 700 },
      { keys: ['enter'] },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ }, timeout: 10_000 },
      { type: 'g' },
      { sleep: 900 },
      { dump: '30-search' },
      { act: { kind: 'esc' } },
      { sleep: 900 },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ }, timeout: 5_000 },
      { dump: '31-search-cleared' },
      { act: { kind: 'esc' } },
      { sleep: 900 },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ }, timeout: 5_000 },
      { act: { kind: 'esc' } },
      { expectMenu: null, timeout: 10_000 },
      { expectNoFile: '.claude/settings.local.json' },
      { expectUnchanged: '.claude/settings.json' },
    ],
  },
  // e2e (Fase 2): menus da CLI pelo card genérico. /hooks fecha com Esc; em /permissions
  // troca de aba, entra na opção e volta com Esc sem gravar regra nenhuma.
  'e2e-generic-menus': {
    args: DEFAULT_ARGS,
    tool: 'none',
    prompt: 'diga oi',
    steps: [
      { wait: 'idle', timeout: 90_000 },
      { type: '/hooks' },
      { sleep: 700 },
      { keys: ['enter'] },
      { expectMenu: { kind: 'menu', question: /^Hooks$/ }, timeout: 10_000 },
      { expectStatus: 'waiting' },
      { dump: '10-hooks' },
      { act: { kind: 'esc' } },
      { expectMenu: null, timeout: 10_000 },
      { dump: '11-hooks-closed' },
      { wait: 'idle', timeout: 30_000 },
      { type: '/permissions' },
      { sleep: 700 },
      { keys: ['enter'] },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ }, timeout: 10_000 },
      { dump: '20-permissions' },
      { act: { kind: 'tab', direction: 'next' } },
      { sleep: 900 },
      { dump: '21-permissions-tab-next' },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ } },
      { act: { kind: 'tab', direction: 'prev' } },
      { sleep: 900 },
      { dump: '22-permissions-tab-prev' },
      { act: { kind: 'select', label: /^Add a new rule/ } },
      { sleep: 1200 },
      { dump: '23-permissions-add-rule' },
      // O campo da regra não é menu (o composer escreve nele): Esc pelo teclado.
      { expectMenu: null, timeout: 5_000 },
      { keys: ['esc'] },
      { sleep: 1200 },
      { dump: '24-permissions-esc1' },
      { expectMenu: { kind: 'menu', question: /^Permissions$/ }, timeout: 5_000 },
      { act: { kind: 'esc' } },
      { expectMenu: null, timeout: 10_000 },
      { dump: '25-permissions-closed' },
      { expectNoFile: '.claude/settings.local.json' },
      { expectNoFile: '.claude/settings.json' },
    ],
  },
  // Single-select: registra a sentinela "Chat about this" e o que ela devolve ao modelo.
  'question-chat-sentinel': {
    args: QUESTION_ARGS,
    tool: 'AskUserQuestion',
    prompt:
      'Use a ferramenta AskUserQuestion com UMA pergunta single-select (multiSelect false) com 3 opções sobre linguagem de programação favorita. Depois da resposta, só diga ok e pare.',
    latency: QUESTION_LATENCY,
    steps: [
      ...questionCapture('question-chat-sentinel'),
      { nav: /^Chat about this/ },
      { sleep: 800 },
      { dump: '20-cursor-chat', fixture: 'question-chat-sentinel-cursor' },
      { keys: ['enter'] },
      { sleep: 3000 },
      { dump: '21-after-chat', fixture: 'question-chat-sentinel-after' },
      { jsonl: 'after-chat', fixture: 'question-chat-sentinel' },
      { sleep: 3000 },
      { dump: '22-post-turn' },
      { keys: ['esc'] },
      { sleep: 1500 },
      { dump: '23-after-esc' },
      { jsonl: 'after-esc' },
    ],
  },
  // Ctrl+R, Esc-Esc (rewind) e /compact numa sessão default com 3 prompts no histórico.
  'history-rewind-compact': {
    args: DEFAULT_ARGS,
    tool: 'none',
    prompt: 'diga a',
    steps: [
      ...THREE_PROMPTS,
      { dump: '10-idle-3-prompts' },
      { keys: ['ctrl-r'] },
      { sleep: 1200 },
      { dump: '20-ctrl-r-empty' },
      { type: 'diga' },
      { sleep: 1200 },
      { dump: '21-history-results', fixture: 'history-search-results' },
      // Setas não navegam os resultados no 2.1.317 (visto ao vivo); Ctrl+R de novo cicla
      // para o match anterior.
      { keys: ['down'] },
      { sleep: 900 },
      { dump: '22-history-down' },
      { keys: ['ctrl-r'] },
      { sleep: 900 },
      { dump: '23-history-ctrl-r-again', fixture: 'history-search-selected' },
      { keys: ['ctrl-r'] },
      { sleep: 900 },
      { dump: '24-history-ctrl-r-3' },
      { keys: ['esc'] },
      { sleep: 1200 },
      { dump: '25-history-esc' },
      // Esc deixa o match no composer: o 1º Esc-Esc só limpa ("Esc again to clear").
      { keys: ['esc', 'esc'], gapMs: 200 },
      { sleep: 1200 },
      { dump: '26-composer-cleared' },
      { keys: ['esc', 'esc'], gapMs: 200 },
      { sleep: 1500 },
      { dump: '30-rewind-picker', fixture: 'rewind-picker' },
      { keys: ['up'] },
      { sleep: 700 },
      { dump: '31-rewind-up1' },
      { keys: ['up'] },
      { sleep: 700 },
      { dump: '32-rewind-up2' },
      // Cursor nasce em "(current)": 2 setas para cima = 2ª mensagem ("diga b").
      { dump: '33-rewind-second-selected', fixture: 'rewind-picker-selected' },
      { keys: ['enter'] },
      { sleep: 1500 },
      { dump: '34-rewind-restore-menu', fixture: 'rewind-restore-menu' },
      { jsonl: 'rewind-restore-menu' },
      // A seta muda o texto do submenu ("Summarize from here: add context (optional)").
      { keys: ['down'] },
      { sleep: 700 },
      { dump: '35-rewind-restore-down', fixture: 'rewind-restore-menu-down' },
      // Com o cursor na opção de input, o dígito vira texto ("Summarize from here: 1", visto
      // ao vivo; fixture rewind-digit-into-input). Volta o cursor antes de teclar o dígito.
      // Esc no submenu volta ao seletor. O dígito 1 só restaura a conversa.
      { keys: ['up'] },
      { sleep: 700 },
      { dump: '35b-rewind-restore-up' },
      { pick: /^Restore conversation$/ },
      { sleep: 2000 },
      { dump: '36-after-restore', fixture: 'rewind-after-restore' },
      { jsonl: 'after-restore' },
      { keys: ['esc', 'esc'], gapMs: 200 },
      { sleep: 1200 },
      { dump: '37-composer-cleared' },
      { jsonl: 'after-clear' },
      { type: '/compact' },
      { sleep: 1200 },
      { dump: '40-compact-typed' },
      { keys: ['enter'] },
      { sleep: 2500 },
      // Sem confirmação no 2.1.317: Enter já compacta.
      { dump: '41-compact-after-enter', fixture: 'compact-running' },
      { wait: 'idle', timeout: 120_000 },
      { dump: '42-compact-idle', fixture: 'compact-done' },
      { jsonl: 'after-compact' },
    ],
  },
  // Spike: PreToolUse/PermissionRequest disparam para ExitPlanMode e AskUserQuestion na TUI?
  // --setting-sources project,local deixa os hooks do usuário de fora; --settings é flag.
  'hook-spike': {
    args: [...BASE_ARGS, '--settings', HOOK_SETTINGS],
    setup: {
      'hook-spike/hook-log.sh': `#!/bin/sh\n{ cat; echo; } >> "${HOOK_LOG}"\nexit 0\n`,
      'hook-spike/settings.json': JSON.stringify(
        { hooks: { PreToolUse: observeHook, PermissionRequest: observeHook } },
        null,
        2,
      ),
    },
    hookLog: HOOK_LOG,
    prompt: PLAN_PROMPT,
    latency: PLAN_LATENCY,
    steps: [
      { wait: 'menu', kind: 'plan', timeout: 180_000 },
      { dump: '10-plan-dialog' },
      { hooklog: 'plan-dialog' },
      { jsonl: 'plan-before-answer', awaitUseMs: 10_000 },
      { sleep: 3000 },
      { hooklog: 'plan-dialog+3s' },
      { keys: ['esc'] },
      { sleep: 2500 },
      { dump: '11-plan-after-esc' },
      { hooklog: 'plan-after-esc' },
      { jsonl: 'plan-after-esc' },
      { wait: 'idle', timeout: 60_000 },
      {
        submit:
          'Use a ferramenta AskUserQuestion com UMA pergunta single-select com 3 opções sobre cor favorita. Depois da resposta, só diga ok e pare.',
      },
      { wait: 'menu', kind: 'question', timeout: 180_000 },
      { dump: '20-question' },
      { hooklog: 'question' },
      { jsonl: 'question-before-answer', tool: 'AskUserQuestion', awaitUseMs: 10_000 },
      { sleep: 3000 },
      { hooklog: 'question+3s' },
      { keys: ['esc'] },
      { sleep: 2500 },
      { dump: '21-question-after-esc' },
      { hooklog: 'question-after-esc', fixture: 'hook-spike-payloads' },
      { jsonl: 'question-after-esc', tool: 'AskUserQuestion' },
    ],
  },
  // Menus de slash command que o parser não conhece: abre cada um, captura, desce uma linha
  // e fecha com Esc. A sessão fica em waiting/"dialog open" enquanto o diálogo está aberto.
  'unknown-menus': {
    args: DEFAULT_ARGS,
    tool: 'none',
    prompt: 'diga oi',
    steps: [
      { wait: 'idle', timeout: 90_000 },
      ...slashMenu('permissions', 10),
      ...slashMenu('mcp', 20, false),
      // /agents não abre diálogo no 2.1.317 ("The /agents wizard has been removed.").
      ...slashMenu('agents', 30, false),
      ...slashMenu('hooks', 40),
      // /config já tem parser próprio (parseTuiPicker -> config); entra só como contraste.
      ...slashMenu('config', 50, false),
    ],
  },
}

const NAME = process.argv[2] ?? ''
const SC = SCENARIOS[NAME]
if (!SC) {
  console.error(`cenario desconhecido "${NAME}". Opcoes: ${Object.keys(SCENARIOS).join(', ')}`)
  process.exit(2)
}
const OUT = join(SB, NAME)
const CWD = join(OUT, 'cwd')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(CWD, { recursive: true })
for (const [rel, body] of Object.entries(SC.setup ?? {})) {
  mkdirSync(dirname(join(SB, rel)), { recursive: true })
  writeFileSync(join(SB, rel), body, { mode: 0o755 })
}
writeFileSync(join(CWD, 'README.md'), '# sandbox\n')
for (const [rel, body] of Object.entries(SC.cwdSetup ?? {})) {
  mkdirSync(dirname(join(CWD, rel)), { recursive: true })
  writeFileSync(join(CWD, rel), body)
}

const COLS = 120
const ROWS = 45
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 })
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v == null || k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') continue
  env[k] = v
}
env.TERM = 'xterm-256color'
Object.assign(env, SC.env)
const TOOL = SC.tool ?? 'ExitPlanMode'
const sessionId = randomUUID()
const args = ['--session-id', sessionId, '--setting-sources', 'project,local', ...SC.args]
const t0 = performance.now()
const proc = pty.spawn('claude', args, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: CWD,
  env,
})

const log: string[] = []
function say(line: string) {
  log.push(line)
  console.log(line)
  writeFileSync(join(OUT, 'log.txt'), log.join('\n') + `\nsession=${sessionId}\n`)
}
say(`[args] claude ${args.map((a) => (/\s|"/.test(a) ? `'${a}'` : a)).join(' ')}`)

function readTail(n: number): string {
  const buf = term.buffer.active
  let t = ''
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++)
    t += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
  return t
}
const parseNow = () => parseTuiMenuFull(readTail, term.buffer.active.length)

// Latência: CSI de avanço de cursor (C) e coluna absoluta (G, usada pelo 2.1.317 entre palavras) viram espaço antes de tirar o ANSI, senão palavras grudam.
const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[\d*[CG]/g, ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
const lat: { textAt?: number; textChunk?: number; textSplit?: boolean; parseAt?: number } = {}
// Epoch ms do 1º parse de cada kind de menu (só com hookLog), para comparar com a chegada dos hooks.
const menuFirstAt: Record<string, number> = {}
const hookArrivals: number[] = []
if (SC.hookLog) {
  setInterval(() => {
    if (!existsSync(SC.hookLog!)) return
    const n = readFileSync(SC.hookLog!, 'utf8').split('\n').filter(Boolean).length
    while (hookArrivals.length < n) hookArrivals.push(Date.now())
  }, 50).unref()
}
let chunkNo = 0
let prevStripped = ''
let raw = ''
let rawMark = 0
proc.onData((d) => {
  const at = performance.now()
  const n = ++chunkNo
  raw += d
  if (SC.latency && lat.textAt == null) {
    const s = stripAnsi(d)
    if (SC.latency.textRe.test(s))
      Object.assign(lat, { textAt: at, textChunk: n, textSplit: false })
    else if (SC.latency.textRe.test(prevStripped + s))
      Object.assign(lat, { textAt: at, textChunk: n, textSplit: true })
    prevStripped = s.slice(-200)
  }
  term.write(d, () => {
    if (SC.hookLog) {
      const k = parseNow()?.kind
      if (k && menuFirstAt[k] == null) menuFirstAt[k] = Date.now()
    }
    if (!SC.latency || lat.parseAt != null) return
    const m = parseNow()
    if (m?.kind === SC.latency.kind) lat.parseAt = performance.now()
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SESSION_KEYS_KNOWN = new Set([
  'asksForConvertedSkills',
  'cwd',
  'entrypoint',
  'kind',
  'messagingSocketPath',
  'name',
  'nameSince',
  'nameSource',
  'peerFeatures',
  'peerProtocol',
  'pid',
  'pidDomain',
  'procStart',
  'sessionId',
  'startedAt',
  'updatedAt',
  'version',
])
function ccSession(): Record<string, unknown> | null {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), '.claude', 'sessions', `${proc.pid}.json`), 'utf8'),
    )
  } catch {
    return null
  }
}
function ccStatus(): string {
  const s = ccSession()
  if (!s) return 'no-file'
  const extra = Object.fromEntries(Object.entries(s).filter(([k]) => !SESSION_KEYS_KNOWN.has(k)))
  return JSON.stringify(extra)
}

function jsonlPath(): string | null {
  const root = join(homedir(), '.claude', 'projects')
  const direct = join(root, CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}
function readJsonl(): any[] {
  const p = jsonlPath()
  if (!p) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}
// Só assistant/user: linhas api-request-blob repetem os mesmos blocos e duplicariam ids.
const blocks = (e: any): any[] =>
  (e?.type === 'assistant' || e?.type === 'user') && Array.isArray(e?.message?.content)
    ? e.message.content
    : []
function jsonlReport(label: string, TOOL = SC.tool ?? 'ExitPlanMode') {
  const entries = readJsonl()
  const uses = entries.flatMap((e) =>
    blocks(e)
      .filter((b) => b.type === 'tool_use' && b.name === TOOL)
      .map((b) => b.id),
  )
  const results = entries.flatMap((e) =>
    blocks(e)
      .filter((b) => b.type === 'tool_result' && uses.includes(b.tool_use_id))
      .map((b) => ({
        id: b.tool_use_id,
        is_error: b.is_error ?? false,
        text: JSON.stringify(b.content).slice(0, 240),
        toolDenialKind: e.toolDenialKind,
        userFeedback: e.userFeedback,
        permissionDecision: e.permissionDecision,
        toolUseResult: JSON.stringify(e.toolUseResult)?.slice(0, 400),
      })),
  )
  const modes = entries.filter((e) => e.permissionMode).map((e) => e.permissionMode)
  const modeEvents = entries
    .filter(
      (e) =>
        e.type !== 'user' &&
        e.type !== 'assistant' &&
        /mode/i.test(JSON.stringify(e).slice(0, 400)),
    )
    .map((e) => e.type + (e.subtype ? `:${e.subtype}` : ''))
  say(
    `[jsonl ${label}] entries=${entries.length} ${TOOL}Use=${JSON.stringify(uses)} results=${JSON.stringify(results)} permissionModes=${JSON.stringify([...new Set(modes)])} lastMode=${modes.at(-1) ?? 'none'} modeEvents=${JSON.stringify(modeEvents)}`,
  )
  writeFileSync(
    join(OUT, `jsonl-${label}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  )
  return { entries, uses }
}

// Só as linhas do ExitPlanMode (tool_use + tool_result), sem thinking nem paths do usuário.
function sanitizedPlanLines(entries: any[], uses: string[]): string {
  const home = homedir()
  return (
    entries
      .filter((e) =>
        blocks(e).some(
          (b) =>
            (b.type === 'tool_use' && uses.includes(b.id)) ||
            (b.type === 'tool_result' && uses.includes(b.tool_use_id)),
        ),
      )
      .map((e) => {
        const copy = {
          ...e,
          message: { ...e.message, content: blocks(e).filter((b) => b.type !== 'thinking') },
        }
        return JSON.stringify(copy)
          .split(CWD)
          .join('<cwd>')
          .split(SB)
          .join('<sb>')
          .split(home)
          .join('~')
      })
      .join('\n') + '\n'
  )
}

function hookReport(label: string, fixture?: string) {
  const lines = existsSync(SC.hookLog!)
    ? readFileSync(SC.hookLog!, 'utf8').split('\n').filter(Boolean)
    : []
  const rel = (at: number | undefined, kind: string) =>
    at != null && menuFirstAt[kind] != null ? at - menuFirstAt[kind] : null
  const rows = lines.map((l, i) => {
    let j: any
    try {
      j = JSON.parse(l)
    } catch {
      return { i, unparsed: l.slice(0, 120) }
    }
    const ti = j.tool_input ?? {}
    return {
      i,
      event: j.hook_event_name,
      tool: j.tool_name,
      permission_mode: j.permission_mode,
      keys: Object.keys(j),
      tool_input_keys: Object.keys(ti),
      plan: typeof ti.plan === 'string' ? `${ti.plan.length}ch:${JSON.stringify(ti.plan.slice(0, 80))}` : undefined,
      questions: Array.isArray(ti.questions) ? ti.questions.length : undefined,
      permission_suggestions: j.permission_suggestions,
      tool_use_id: j.tool_use_id ? 'present' : undefined,
      msVsPlanMenu: rel(hookArrivals[i], 'plan'),
      msVsQuestionMenu: rel(hookArrivals[i], 'question'),
    }
  })
  say(`[hooklog ${label}] n=${lines.length} menuFirstAt=${JSON.stringify(menuFirstAt)}`)
  for (const r of rows) say(`  ${JSON.stringify(r)}`)
  if (fixture && process.env.PROBE_FIXTURES === '1') {
    const home = homedir()
    const keep = lines.filter((l) => /"tool_name":"(ExitPlanMode|AskUserQuestion)"/.test(l))
    const f = join(FIXTURES_DIR, `claude-${CLAUDE_VERSION}-${fixture}.jsonl`)
    writeFileSync(
      f,
      keep
        .map((l) => {
          const j = JSON.parse(l)
          const o = { ...j, transcript_path: '<transcript>', scratchpad_dir: '<scratchpad>' }
          return JSON.stringify(o).split(CWD).join('<cwd>').split(SB).join('<sb>').split(home).join('~')
        })
        .join('\n') + '\n',
    )
    say(`[fixture] ${f}`)
  }
}

function dump(step: string, fixture?: string) {
  const txt = readTail(80)
  const ansi = raw.slice(rawMark)
  rawMark = raw.length
  writeFileSync(join(OUT, `${step}.txt`), txt)
  writeFileSync(join(OUT, `${step}.ansi`), ansi)
  const m = parseNow()
  say(
    `[${step}] t=${Math.round(performance.now() - t0)}ms status=${ccStatus()} menu=${m ? JSON.stringify({ kind: m.kind, q: m.question, opts: m.options.map((o) => ({ i: o.index, label: o.label, ...(o.sentinel ? { sentinel: o.sentinel } : {}) })), cursorIndex: m.cursorIndex, submitOnDigit: m.submitOnDigit, multiSelect: m.multiSelect }) : 'null'} picker=${JSON.stringify(parseTuiPicker(txt))}`,
  )
  if (fixture && process.env.PROBE_FIXTURES === '1') {
    const base = join(FIXTURES_DIR, `claude-${CLAUDE_VERSION}-${fixture}`)
    writeFileSync(`${base}.txt`, txt)
    writeFileSync(`${base}.ansi`, ansi)
    say(`[fixture] ${base}.{txt,ansi}`)
  }
}

async function waitFor(pred: () => boolean, timeout: number): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(250)
  }
  return false
}
const statusOf = () => String(ccSession()?.status ?? 'no-file')

const verdicts: { what: string; pass: boolean; evidence: string }[] = []
function verdict(what: string, pass: boolean, evidence: string) {
  verdicts.push({ what, pass, evidence })
  say(`[expect ${pass ? 'PASS' : 'FAIL'}] ${what} :: ${evidence}`)
}
const screenFooter = () =>
  readTail(ROWS)
    .split('\n')
    .filter((l) => l.trim())
    .slice(-4)
    .map((l) => l.trim())
function lastPlanResult(): any | null {
  const entries = readJsonl()
  const uses = new Set(
    entries.flatMap((e) =>
      blocks(e).filter((b) => b.type === 'tool_use' && b.name === 'ExitPlanMode').map((b) => b.id),
    ),
  )
  const found = entries.flatMap((e) =>
    blocks(e)
      .filter((b) => b.type === 'tool_result' && uses.has(b.tool_use_id))
      .map((b) => ({ block: b, entry: e })),
  )
  return found.at(-1) ?? null
}
let promised: string | null = null
// Labels marcados na tela e o texto do Other, lidos no último parse antes do submit-multi.
let checkedBeforeSubmit: string[] = []
function lastToolResult(tool: string): any | null {
  const entries = readJsonl()
  const uses = new Set(
    entries.flatMap((e) => blocks(e).filter((b) => b.type === 'tool_use' && b.name === tool).map((b) => b.id)),
  )
  const found = entries.flatMap((e) =>
    blocks(e)
      .filter((b) => b.type === 'tool_result' && uses.has(b.tool_use_id))
      .map((b) => ({ block: b, entry: e })),
  )
  return found.at(-1) ?? null
}

async function run(step: Step) {
  if ('wait' in step) {
    const timeout = step.timeout ?? 120_000
    let ok: boolean
    if (step.wait === 'menu') ok = await waitFor(() => parseNow()?.kind === step.kind, timeout)
    else if (step.wait === 'text') ok = await waitFor(() => step.re.test(readTail(80)), timeout)
    else if (step.wait === 'gone') ok = await waitFor(() => parseNow()?.kind !== step.kind, timeout)
    else {
      await sleep(1500)
      ok = await waitFor(() => statusOf() === 'idle' && parseNow() == null, timeout)
    }
    say(`[wait ${step.wait}${'kind' in step ? ` ${step.kind}` : ''}] ${ok ? 'ok' : 'TIMEOUT'}`)
    if (!ok) throw new Error(`timeout em wait ${step.wait}`)
    await sleep(600)
  } else if ('keys' in step) {
    for (const k of step.keys) {
      proc.write(KEYS[k])
      await sleep(step.gapMs ?? 300)
    }
    say(`[keys] ${step.keys.join(' ')}`)
  } else if ('type' in step) {
    proc.write(step.type)
    say(`[type] ${JSON.stringify(step.type)}`)
  } else if ('submit' in step) {
    proc.write(step.submit)
    await sleep(700)
    proc.write(KEYS.enter)
    say(`[submit] ${JSON.stringify(step.submit)}`)
  } else if ('paste' in step) {
    proc.write(KEYS['paste-start'] + step.paste + KEYS['paste-end'])
    say(`[paste] ${JSON.stringify(step.paste)}`)
  } else if ('planfile' in step) {
    const rel = readTail(80).match(/~\/\.claude\/plans\/[\w.-]+\.md/)?.[0]
    const p = rel?.replace('~', homedir())
    const body = p && existsSync(p) ? readFileSync(p, 'utf8') : null
    say(`[planfile ${step.planfile}] path=${rel ?? 'nao achado na tela'} bytes=${body?.length ?? null} hasEditorLine=${body?.includes(FAKE_EDITOR_LINE) ?? null} tail=${JSON.stringify(body?.trimEnd().split('\n').slice(-3) ?? null)}`)
    const calls = join(SB, 'fake-editor-calls.log')
    if (existsSync(calls)) say(`[editor calls] ${JSON.stringify(readFileSync(calls, 'utf8').trim().split('\n'))}`)
  } else if ('sleep' in step) await sleep(step.sleep)
  else if ('pick' in step) {
    const m = parseNow()
    const o = m?.options.find((x) => step.pick.test(x.label))
    if (!m || !o) throw new Error(`pick ${step.pick}: opcao nao encontrada (menu=${m?.kind ?? 'null'})`)
    proc.write(String(o.index + 1))
    say(`[pick] ${step.pick} -> digito ${o.index + 1} (${JSON.stringify(o.label)}) submitOnDigit=${m.submitOnDigit}`)
  } else if ('nav' in step) {
    const m = parseNow()
    const o = m?.options.find((x) => step.nav.test(x.label))
    if (!m || !o) throw new Error(`nav ${step.nav}: opcao nao encontrada (menu=${m?.kind ?? 'null'})`)
    const from = m.cursorIndex ?? 0
    const key = o.index > from ? KEYS.down : KEYS.up
    for (let k = 0; k < Math.abs(o.index - from); k++) {
      proc.write(key)
      await sleep(300)
    }
    say(`[nav] ${step.nav} cursor ${from} -> ${o.index} (${JSON.stringify(o.label)})`)
  } else if ('footer' in step) {
    const lines = readTail(ROWS).split('\n').filter((l) => l.trim()).slice(-4)
    say(`[footer ${step.footer}] ${JSON.stringify(lines.map((l) => l.trimEnd()))}`)
  }
  else if ('respond' in step) {
    const m = parseNow()
    if (m?.kind !== 'plan') throw new Error(`respond: menu atual=${m?.kind ?? 'null'}`)
    const keys = buildPlanKeys(m, step.respond, step.feedback)
    const opt = step.respond === 'reject' ? null : findPlanOption(m, step.respond)
    promised = opt?.planMode ?? (opt?.planIntent?.startsWith('approve-') ? opt.planIntent.slice(8) : null)
    say(
      `[respond] intent=${step.respond} opts=${JSON.stringify(m.options.map((o) => ({ i: o.index, label: o.label, planIntent: o.planIntent, planMode: o.planMode, submitOnDigit: o.submitOnDigit })))} cursor=${m.cursorIndex} chosen=${JSON.stringify(opt?.label ?? null)} planMode=${promised} keys=${JSON.stringify(keys)}`,
    )
    if (keys.length === 0) throw new Error(`respond ${step.respond}: buildPlanKeys devolveu []`)
    await playKeys(
      keys,
      (k) => proc.write(k),
      keys.length > 1 ? PLAN_KEY_DELAY_MS : undefined,
    )
  } else if ('expectFooter' in step) {
    const ok = await waitFor(() => step.expectFooter.test(screenFooter().join('\n')), step.timeout ?? 15_000)
    verdict(
      `footer ${step.expectFooter} (card prometia planMode=${promised})`,
      ok,
      JSON.stringify(screenFooter().filter((l) => /mode on|esc to/.test(l))),
    )
  } else if ('expectResult' in step) {
    const want = step.expectResult
    const match = (r: any) =>
      r &&
      (r.block.is_error ?? false) === want.isError &&
      (want.feedback == null || r.entry.userFeedback === want.feedback)
    // Último tool_result do ExitPlanMode: para o feedback, o 2º diálogo ainda não tem resultado.
    const ok = await waitFor(() => match(lastPlanResult()), step.timeout ?? 20_000)
    const r = lastPlanResult()
    verdict(
      `tool_result is_error=${want.isError}${want.feedback ? ` userFeedback=${JSON.stringify(want.feedback)}` : ''}`,
      ok,
      r
        ? JSON.stringify({
            is_error: r.block.is_error ?? false,
            toolDenialKind: r.entry.toolDenialKind,
            userFeedback: r.entry.userFeedback,
            content: JSON.stringify(r.block.content).slice(0, 90),
          })
        : 'sem tool_result',
    )
  } else if ('act' in step) {
    const m = parseNow()
    if (!m) throw new Error(`act ${step.act.kind}: sem menu na tela`)
    const pick = (l: RegExp | number) =>
      typeof l === 'number' ? m.options.find((o) => o.index === l) : m.options.find((o) => l.test(o.label))
    let action: AttentionAction
    const a = step.act
    if (a.kind === 'toggle' || a.kind === 'select') {
      const o = pick(a.label)
      if (!o) throw new Error(`act ${a.kind} ${a.label}: opcao nao encontrada (menu=${m.kind})`)
      action = { kind: a.kind, optionIndex: o.index }
    } else if (a.kind === 'other') {
      const o = m.options.find((x) => x.sentinel === 'other')
      if (!o) throw new Error('act other: sem sentinela other')
      action = { kind: 'other', optionIndex: o.index, text: a.text }
    } else action = a
    if (action.kind === 'submit-multi')
      checkedBeforeSubmit = m.options.filter((o) => o.checked).map((o) => o.otherText ?? o.label)
    const keys = keysForAction(m, action)
    const delay = actionKeyDelay(m, action)
    say(`[act] ${JSON.stringify(action)} menu=${m.kind} cursor=${m.cursorIndex} submitRow=${JSON.stringify(m.submitRow ?? null)} keys=${JSON.stringify(keys)} delay=${delay ?? 30}`)
    if (keys.length === 0) throw new Error(`act ${a.kind}: keysForAction devolveu []`)
    await playKeys(keys, (k) => proc.write(k), delay)
  } else if ('expectAnswers' in step) {
    const want = step.expectAnswers
    // 'checked': os labels marcados na tela antes do envio + o texto do Other.
    const lastAnswers = () => {
      const r = lastToolResult('AskUserQuestion')
      const answers = r?.entry.toolUseResult?.answers
      return answers ? (Object.values(answers) as string[]).join(' | ') : null
    }
    const expected = want === 'checked' ? checkedBeforeSubmit : want
    const ok = await waitFor(() => {
      const got = lastAnswers()
      return got != null && expected.every((w) => got.includes(w))
    }, step.timeout ?? 20_000)
    verdict(`answers contem ${JSON.stringify(expected)}`, ok, JSON.stringify(lastAnswers()))
  } else if ('expectRejected' in step) {
    const re = step.expectRejected
    const ok = await waitFor(() => {
      const r = lastToolResult('AskUserQuestion')
      return r != null && r.block.is_error === true && re.test(String(r.entry.userFeedback ?? ''))
    }, step.timeout ?? 20_000)
    const r = lastToolResult('AskUserQuestion')
    verdict(
      `tool_result rejeitado com userFeedback ${re}`,
      ok,
      r ? JSON.stringify({ is_error: r.block.is_error, toolDenialKind: r.entry.toolDenialKind, userFeedback: String(r.entry.userFeedback ?? '').slice(0, 80) }) : 'sem tool_result',
    )
  } else if ('expectMenu' in step) {
    const want = step.expectMenu
    const match = () => {
      const m = parseNow()
      if (want == null) return m == null
      return m?.kind === want.kind && (want.question == null || want.question.test(m.question ?? ''))
    }
    const ok = await waitFor(match, step.timeout ?? 3_000)
    const m = parseNow()
    verdict(
      `menu ${want ? `${want.kind} ${want.question ?? ''}` : 'fechado'}`,
      ok,
      JSON.stringify(m ? { kind: m.kind, q: m.question, opts: m.options.map((o) => o.label), cursor: m.cursorIndex, ctx: m.context?.slice(0, 60) } : null),
    )
  } else if ('expectStatus' in step) {
    const st = statusOf()
    verdict(`status ${step.expectStatus}`, st === step.expectStatus, ccStatus())
  } else if ('expectNoFile' in step) {
    const f = join(CWD, step.expectNoFile)
    verdict(`sem ${step.expectNoFile} no cwd`, !existsSync(f), existsSync(f) ? readFileSync(f, 'utf8').slice(0, 200) : 'ausente')
  } else if ('escUntilIdle' in step) {
    let n = 0
    while (n < step.escUntilIdle && !(statusOf() === 'idle' && parseNow() == null)) {
      proc.write(KEYS.esc)
      n++
      await sleep(1200)
    }
    say(`[escUntilIdle] ${n} Esc -> status=${statusOf()} menu=${parseNow()?.kind ?? 'null'}`)
  } else if ('expectUnchanged' in step) {
    const f = join(CWD, step.expectUnchanged)
    const want = SC.cwdSetup?.[step.expectUnchanged]
    const got = existsSync(f) ? readFileSync(f, 'utf8') : null
    verdict(`${step.expectUnchanged} intocado no cwd`, want != null && got === want, got == null ? 'ausente' : `${got.length}ch`)
  } else if ('dump' in step) dump(step.dump, step.fixture)
  else if ('hooklog' in step) hookReport(step.hooklog, step.fixture)
  else if ('jsonl' in step) {
    const TOOL = step.tool ?? SC.tool ?? 'ExitPlanMode'
    let r = jsonlReport(step.jsonl, TOOL)
    if (step.awaitUseMs && r.uses.length === 0) {
      const ok = await waitFor(() => readJsonl().some((e) => blocks(e).some((b) => b.type === 'tool_use' && b.name === TOOL)), step.awaitUseMs)
      const since = lat.parseAt != null ? Math.round(performance.now() - lat.parseAt) : null
      say(`[jsonl flush] ${TOOL} tool_use ${ok ? `chegou ~${since}ms depois do parse do dialogo` : 'NAO chegou'} (status=${statusOf()}, menu=${parseNow()?.kind ?? 'null'})`)
      r = jsonlReport(`${step.jsonl}-flushed`, TOOL)
    }
    if (step.fixture && process.env.PROBE_FIXTURES === '1' && r.uses.length > 0) {
      const f = join(FIXTURES_DIR, `claude-${CLAUDE_VERSION}-${step.fixture}.jsonl`)
      writeFileSync(f, sanitizedPlanLines(r.entries, r.uses))
      say(`[fixture] ${f}`)
    }
  }
}

let exitCode = 0
try {
  await sleep(3000)
  dump('00-start')
  if (await waitFor(() => parseNow()?.kind === 'trust', 8000)) {
    dump('01-trust')
    proc.write(KEYS.enter)
    await sleep(2500)
  }
  dump('02-ready')
  proc.write(SC.prompt)
  await sleep(700)
  proc.write(KEYS.enter)
  const promptAt = performance.now()
  for (const step of SC.steps) await run(step)
  if (verdicts.length > 0) {
    const pass = verdicts.every((v) => v.pass)
    say(`[verdict] ${NAME} ${pass ? 'PASS' : 'FAIL'} (${verdicts.filter((v) => v.pass).length}/${verdicts.length})`)
    if (!pass) exitCode = 1
  }
  if (SC.latency) {
    const r = (x?: number) => (x == null ? null : Math.round(x - promptAt))
    say(
      `[latency] textChunk=${lat.textChunk ?? null} split=${lat.textSplit ?? null} textAt=+${r(lat.textAt)}ms parseAt=+${r(lat.parseAt)}ms delta=${lat.textAt != null && lat.parseAt != null ? Math.round(lat.parseAt - lat.textAt) : null}ms`,
    )
  }
} catch (e) {
  exitCode = 1
  say(`[error] ${(e as Error).message}`)
  dump('99-error')
} finally {
  writeFileSync(join(OUT, 'raw.ansi'), raw)
  try {
    // node-pty abre sessão própria: matar o grupo leva junto os filhos do claude.
    process.kill(-proc.pid, 'SIGTERM')
  } catch {}
  try {
    proc.kill()
  } catch {}
  await sleep(800)
  say(`session ${sessionId} pid ${proc.pid}`)
  process.exit(exitCode)
}
