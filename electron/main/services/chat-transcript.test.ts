import { describe, expect, it } from 'vitest'
import {
  lastPlanFilePath,
  parseChatMessages,
  parseSubagentTurns,
  stripAnsi,
  type SubagentInfo,
} from './chat-transcript'

// Fixture representativo: prompt do usuário, resposta assistant com texto +
// tool_use, tool_result do usuário (string e array), uma linha não-mensagem, uma
// linha malformada e um turno de subagente (isSidechain). Cada linha é um JSON.
const FIXTURE = [
  JSON.stringify({ type: 'ai-title', aiTitle: 'Some title' }), // não-mensagem → ignorada
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Read /a and tell me' } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Sure, let me read it.' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body', is_error: false }],
    },
  }),
  '{ this is not valid json', // malformada → pulada
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: '' }, // texto vazio → não vira bubble
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_2',
          content: [{ type: 'text', text: 'permission denied' }],
          is_error: true,
        },
      ],
    },
  }),
  // turno de subagente: deve ser ignorado mesmo sendo user/assistant válido.
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'subagent internal' }] },
  }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
].join('\n')

describe('parseChatMessages', () => {
  const messages = parseChatMessages(FIXTURE)

  it('produces messages in transcript order', () => {
    expect(messages.map((m) => m.kind)).toEqual([
      'user', // "Read /a and tell me"
      'assistant', // "Sure, let me read it."
      'tool_use', // Read tu_1
      'tool_result', // tu_1
      'tool_use', // Bash tu_2 (texto vazio da mesma linha não entra)
      'tool_result', // tu_2 (array content)
      'assistant', // "Done."
    ])
  })

  it('captures user text and assistant text verbatim', () => {
    expect(messages[0]).toEqual({ kind: 'user', text: 'Read /a and tell me' })
    expect(messages[1]).toEqual({ kind: 'assistant', text: 'Sure, let me read it.' })
    expect(messages[6]).toEqual({ kind: 'assistant', text: 'Done.' })
  })

  it('captures tool_use blocks with id/name/input', () => {
    expect(messages[2]).toEqual({
      kind: 'tool_use',
      id: 'tu_1',
      name: 'Read',
      input: { file_path: '/a' },
    })
    expect(messages[4]).toEqual({
      kind: 'tool_use',
      id: 'tu_2',
      name: 'Bash',
      input: { command: 'ls' },
    })
  })

  it('captures tool_result (string and array content) with forId/isError', () => {
    expect(messages[3]).toEqual({
      kind: 'tool_result',
      forId: 'tu_1',
      content: 'file body',
      isError: false,
    })
    expect(messages[5]).toEqual({
      kind: 'tool_result',
      forId: 'tu_2',
      content: 'permission denied', // array de blocos de texto → string
      isError: true,
    })
  })

  it('ignores malformed lines, non-message lines and subagent (sidechain) turns', () => {
    // 7 mensagens apesar de 1 linha malformada, 1 ai-title, 1 sidechain e 1 texto vazio.
    expect(messages).toHaveLength(7)
    expect(messages.some((m) => m.kind === 'assistant' && m.text === 'subagent internal')).toBe(
      false,
    )
  })

  it('returns an empty list for empty or whitespace input', () => {
    expect(parseChatMessages('')).toEqual([])
    expect(parseChatMessages('   \n  \n')).toEqual([])
  })
})

// Momentos interativos: ExitPlanMode (aprovado), AskUserQuestion (respondido) e
// um AskUserQuestion PENDENTE (tool_use sem tool_result depois). O toolUseResult é
// IRMÃO de message no nível da linha (não dentro de content).
const INTERACTIVE_FIXTURE = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Plan it' } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'plan_1',
          name: 'ExitPlanMode',
          input: { plan: '# My Plan\n\nDo the thing.', allowedPrompts: ['edit'] },
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'plan_1', content: 'User has approved your plan. You can now start coding.' }],
    },
    toolUseResult: { plan: '# My Plan\n\nDo the thing.', isAgent: false, filePath: '/tmp/p.md' },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'ask_1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Which deliverable?',
                header: 'Deliverable',
                multiSelect: false,
                options: [
                  { label: 'Diagnosis', description: 'just analysis' },
                  { label: 'Both', description: 'analysis + code' },
                ],
              },
              {
                question: 'Top priority?',
                header: 'Priority',
                multiSelect: true,
                options: [{ label: 'Reliability', description: 'proof' }],
              },
            ],
          },
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'ask_1', content: 'Your questions have been answered.' }],
    },
    toolUseResult: {
      answers: { 'Which deliverable?': 'Both', 'Top priority?': 'Reliability' },
    },
  }),
  // PENDENTE: tool_use de AskUserQuestion sem tool_result depois.
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'ask_pending',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Proceed?', header: 'Go', multiSelect: false, options: [{ label: 'Yes', description: '' }] }] },
        },
      ],
    },
  }),
].join('\n')

describe('parseChatMessages — interactive prompts', () => {
  const m = parseChatMessages(INTERACTIVE_FIXTURE)

  it('emits dedicated kinds (not generic tool_use/tool_result)', () => {
    expect(m.map((x) => x.kind)).toEqual([
      'user',
      'exit_plan_mode',
      'plan_decision',
      'ask_user_question',
      'ask_user_question_answered',
      'ask_user_question', // pendente
    ])
  })

  it('parses ExitPlanMode plan + allowedPrompts and its approval', () => {
    expect(m[1]).toEqual({
      kind: 'exit_plan_mode',
      id: 'plan_1',
      plan: '# My Plan\n\nDo the thing.',
      planFilePath: null,
      allowedPrompts: ['edit'],
    })
    expect(m[2]).toEqual({ kind: 'plan_decision', forId: 'plan_1', approved: true })
  })

  it('parses AskUserQuestion questions/options and the answers map', () => {
    const ask = m[3]
    expect(ask.kind).toBe('ask_user_question')
    if (ask.kind !== 'ask_user_question') throw new Error('narrow')
    expect(ask.id).toBe('ask_1')
    expect(ask.questions).toHaveLength(2)
    expect(ask.questions[0]).toEqual({
      question: 'Which deliverable?',
      header: 'Deliverable',
      multiSelect: false,
      options: [
        { label: 'Diagnosis', description: 'just analysis' },
        { label: 'Both', description: 'analysis + code' },
      ],
    })
    expect(ask.questions[1].multiSelect).toBe(true)
    expect(m[4]).toEqual({
      kind: 'ask_user_question_answered',
      forId: 'ask_1',
      answers: { 'Which deliverable?': 'Both', 'Top priority?': 'Reliability' },
    })
  })

  it('leaves a pending AskUserQuestion without an answer message', () => {
    const last = m[5]
    expect(last.kind).toBe('ask_user_question')
    if (last.kind !== 'ask_user_question') throw new Error('narrow')
    expect(last.id).toBe('ask_pending')
    expect(m.some((x) => x.kind === 'ask_user_question_answered' && x.forId === 'ask_pending')).toBe(
      false,
    )
  })

  it('marks a non-approved plan decision (rejection/feedback)', () => {
    const rejected = parseChatMessages(
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'plan_r', name: 'ExitPlanMode', input: { plan: 'P' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'plan_r',
                content: "The user doesn't want to proceed with this plan.",
              },
            ],
          },
        }),
      ].join('\n'),
    )
    expect(rejected[1]).toEqual({ kind: 'plan_decision', forId: 'plan_r', approved: false })
  })

  it('defaults allowedPrompts to null when absent', () => {
    const [plan] = parseChatMessages(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'p', name: 'ExitPlanMode', input: { plan: 'X' } }],
        },
      }),
    )
    expect(plan).toEqual({
      kind: 'exit_plan_mode',
      id: 'p',
      plan: 'X',
      planFilePath: null,
      allowedPrompts: null,
    })
  })

  it('extracts planFilePath from the ExitPlanMode input when present', () => {
    const [plan] = parseChatMessages(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'p2',
              name: 'ExitPlanMode',
              input: { plan: 'X', planFilePath: '~/.claude/plans/some-plan.md' },
            },
          ],
        },
      }),
    )
    expect(plan).toMatchObject({
      kind: 'exit_plan_mode',
      planFilePath: '~/.claude/plans/some-plan.md',
    })
  })
})

// lastPlanFilePath: último Write/Edit do transcript mirando ~/.claude/plans/*.md
// — o dado que permite mostrar o plano no card de aprovação PENDENTE.
describe('lastPlanFilePath', () => {
  const write = (id: string, filePath: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: filePath } }],
      },
    })
  const edit = (id: string, filePath: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: filePath } }],
      },
    })

  it('resolves the LAST Write/Edit targeting ~/.claude/plans/*.md', () => {
    const m = parseChatMessages(
      [
        write('w1', '/home/u/.claude/plans/first-plan.md'),
        write('w2', '/home/u/project/src/index.ts'), // fora de plans → ignorado
        edit('e1', '/home/u/.claude/plans/second-plan.md'),
      ].join('\n'),
    )
    expect(lastPlanFilePath(m)).toBe('/home/u/.claude/plans/second-plan.md')
  })

  it('ignores non-Write/Edit tools and non-plan paths', () => {
    const m = parseChatMessages(
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/home/u/.claude/plans/x.md' } },
            ],
          },
        }),
        write('w1', '/home/u/.claude/plans-other/x.md'),
      ].join('\n'),
    )
    expect(lastPlanFilePath(m)).toBeNull()
  })

  it('is null when the transcript never wrote a plan file', () => {
    expect(lastPlanFilePath(parseChatMessages(FIXTURE))).toBeNull()
  })
})

// Classificação fail-safe de strings gravadas como turno de usuário: a CLI grava
// como type:'user' muita coisa que o humano não digitou. Só string sem marker
// conhecido pode virar bolha 'user'. Shapes espelham transcripts reais.
describe('parseChatMessages — fail-safe user classification', () => {
  const line = (o: object) => JSON.stringify(o)

  it('turns isMeta:true strings into meta, never user', () => {
    const m = parseChatMessages(
      line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: '# SKILL.md\n\nInjected skill body.' },
      }),
    )
    expect(m).toHaveLength(1)
    expect(m[0]).toEqual({
      kind: 'meta',
      text: '# SKILL.md\n\nInjected skill body.',
      label: 'SKILL.md',
    })
  })

  it('turns current-format slash commands into command with name/args', () => {
    const m = parseChatMessages(
      line({
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-message>goal is running…</command-message>\n<command-name>/goal</command-name>\n<command-args>review the PR</command-args>',
        },
      }),
    )
    expect(m).toEqual([{ kind: 'command', name: 'goal', args: 'review the PR' }])
  })

  it('turns <local-command-stdout> into command_output with ANSI stripped', () => {
    const m = parseChatMessages(
      line({
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stdout>\u001B[1mSet model to\u001B[22m opus</local-command-stdout>',
        },
      }),
    )
    expect(m).toEqual([{ kind: 'command_output', text: 'Set model to opus' }])
  })

  it('drops empty <local-command-stdout> instead of emitting an empty chip', () => {
    const m = parseChatMessages(
      line({
        type: 'user',
        message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' },
      }),
    )
    expect(m).toEqual([])
  })

  it('turns <local-command-caveat> into meta', () => {
    const m = parseChatMessages(
      line({
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: the messages below were generated…</local-command-caveat>',
        },
      }),
    )
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ kind: 'meta' })
  })

  it('turns task-notification and interruption markers into system chips', () => {
    const m = parseChatMessages(
      [
        line({
          type: 'user',
          message: {
            role: 'user',
            content: '<task-notification>\n<task-id>abc</task-id>\nBackground task done.\n</task-notification>',
          },
        }),
        line({
          type: 'user',
          message: { role: 'user', content: '[Request interrupted by user for tool use]' },
        }),
      ].join('\n'),
    )
    expect(m.map((x) => x.kind)).toEqual(['system', 'system'])
    expect(m[0]).toMatchObject({ kind: 'system', label: 'Tarefa em background', level: 'info' })
    // 'warning', não 'info': cancelar muda o que de fato aconteceu no turno.
    expect(m[1]).toMatchObject({ kind: 'system', label: 'Interrompido pelo usuário', level: 'warning' })
  })

  it('classifies <system-reminder> text blocks alongside tool_results as meta, not user', () => {
    const m = parseChatMessages(
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_9', content: 'ok', is_error: false },
            { type: 'text', text: '<system-reminder>Hook context: lint passed.</system-reminder>' },
          ],
        },
      }),
    )
    expect(m.map((x) => x.kind)).toEqual(['tool_result', 'meta'])
    expect(m.some((x) => x.kind === 'user')).toBe(false)
  })

  it('keeps plain strings as user (fail-safe default)', () => {
    const m = parseChatMessages(
      line({ type: 'user', message: { role: 'user', content: 'please fix the bug' } }),
    )
    expect(m).toEqual([{ kind: 'user', text: 'please fix the bug' }])
  })

  it('turns isCompactSummary:true into compact_summary, never a user bubble', () => {
    const summary = 'This session is being continued from a previous conversation…'
    const m = parseChatMessages(
      line({ type: 'user', isCompactSummary: true, message: { role: 'user', content: summary } }),
    )
    expect(m).toEqual([{ kind: 'compact_summary', text: summary }])
  })
})

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences, keeping the text', () => {
    expect(stripAnsi('\u001B[1;32mbold green\u001B[0m plain')).toBe('bold green plain')
    expect(stripAnsi('\u001B]0;title\u0007body')).toBe('body')
    expect(stripAnsi('no ansi [here]')).toBe('no ansi [here]')
  })
})

// Agrupamento assistant: blocos text ADJACENTES do mesmo message.id fundem numa
// única mensagem; ids distintos e tool_use no meio NÃO fundem.
describe('parseChatMessages — assistant text grouping', () => {
  const asst = (id: string, items: object[]) =>
    JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: items } })

  it('merges three adjacent text lines sharing a message.id into one message', () => {
    const m = parseChatMessages(
      [
        asst('msg_1', [{ type: 'text', text: 'Part one.' }]),
        asst('msg_1', [{ type: 'text', text: 'Part two.' }]),
        asst('msg_1', [{ type: 'text', text: 'Part three.' }]),
      ].join('\n'),
    )
    expect(m).toEqual([{ kind: 'assistant', text: 'Part one.\n\nPart two.\n\nPart three.' }])
  })

  it('does not merge across distinct message ids', () => {
    const m = parseChatMessages(
      [
        asst('msg_1', [{ type: 'text', text: 'Turn one.' }]),
        asst('msg_2', [{ type: 'text', text: 'Turn two.' }]),
      ].join('\n'),
    )
    expect(m).toEqual([
      { kind: 'assistant', text: 'Turn one.' },
      { kind: 'assistant', text: 'Turn two.' },
    ])
  })

  it('does not merge through a tool_use in between (interleaving preserved)', () => {
    const m = parseChatMessages(
      [
        asst('msg_1', [{ type: 'text', text: 'Before.' }]),
        asst('msg_1', [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }]),
        asst('msg_1', [{ type: 'text', text: 'After.' }]),
      ].join('\n'),
    )
    expect(m.map((x) => x.kind)).toEqual(['assistant', 'tool_use', 'assistant'])
    expect(m[0]).toEqual({ kind: 'assistant', text: 'Before.' })
    expect(m[2]).toEqual({ kind: 'assistant', text: 'After.' })
  })

  it('does not merge lines without a message.id', () => {
    const m = parseChatMessages(
      [
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'A.' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'B.' }] },
        }),
      ].join('\n'),
    )
    expect(m).toHaveLength(2)
  })
})

// Troca de modelo mid-session: message.model muda entre linhas assistant.
// Marcador só entre ocorrências reais — 1ª ocorrência e <synthetic> não contam.
describe('parseChatMessages — model change', () => {
  const asstModel = (id: string, model: string, text: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, role: 'assistant', model, content: [{ type: 'text', text }] },
    })

  it('emits model_change when message.model differs from the previous assistant turn', () => {
    const m = parseChatMessages(
      [asstModel('m1', 'claude-fable-5', 'first'), asstModel('m2', 'claude-opus-4-8', 'second')].join('\n'),
    )
    expect(m.map((x) => x.kind)).toEqual(['assistant', 'model_change', 'assistant'])
    expect(m[1]).toEqual({ kind: 'model_change', from: 'claude-fable-5', to: 'claude-opus-4-8' })
  })

  it('emits no marker for the first occurrence or a repeated model', () => {
    const m = parseChatMessages(
      [asstModel('m1', 'claude-sonnet-5', 'a'), asstModel('m2', 'claude-sonnet-5', 'b')].join('\n'),
    )
    expect(m.map((x) => x.kind)).toEqual(['assistant', 'assistant'])
  })

  it('ignores <synthetic> model values (no marker, no lastModel update)', () => {
    const m = parseChatMessages(
      [
        asstModel('m1', 'claude-sonnet-5', 'a'),
        asstModel('m2', '<synthetic>', 'b'),
        asstModel('m3', 'claude-opus-4-8', 'c'),
      ].join('\n'),
    )
    expect(m.map((x) => x.kind)).toEqual(['assistant', 'assistant', 'model_change', 'assistant'])
    expect(m[2]).toEqual({ kind: 'model_change', from: 'claude-sonnet-5', to: 'claude-opus-4-8' })
  })
})

// Blocos de raciocínio (extended thinking): texto não-vazio vira kind 'thinking';
// bloco vazio (só assinatura) é descartado; redacted_thinking vira placeholder.
const THINKING_FIXTURE = [
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me reason about this.', signature: 'abc' },
        { type: 'text', text: 'Here is the answer.' },
      ],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'def' }, // vazio → descartado
        { type: 'redacted_thinking', data: 'encrypted' }, // → placeholder
        { type: 'text', text: 'Done.' },
      ],
    },
  }),
].join('\n')

describe('parseChatMessages — thinking', () => {
  const m = parseChatMessages(THINKING_FIXTURE)

  it('emits thinking for non-empty blocks, drops empty, placeholders redacted', () => {
    expect(m.map((x) => x.kind)).toEqual([
      'thinking', // "Let me reason about this."
      'assistant', // "Here is the answer."
      'thinking', // redacted placeholder (bloco vazio anterior descartado)
      'assistant', // "Done."
    ])
    expect(m[0]).toEqual({ kind: 'thinking', text: 'Let me reason about this.' })
    expect(m[2]).toEqual({ kind: 'thinking', text: '(raciocínio oculto)' })
  })
})

// Linhas type:'system': só subtypes whitelistados viram chip; o ruído de alto
// volume (stop_hook_summary, turn_duration) é descartado.
const SYSTEM_FIXTURE = [
  JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', level: 'suggestion' }), // ruído → fora
  JSON.stringify({ type: 'system', subtype: 'turn_duration', isMeta: false }), // ruído → fora
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', level: 'info', content: 'Conversation compacted' }),
  JSON.stringify({ type: 'system', subtype: 'api_error', level: 'error', error: 'rate limited' }),
  JSON.stringify({
    type: 'system',
    subtype: 'local_command',
    level: 'info',
    content: '<command-name>/model</command-name>\n<command-args></command-args>',
  }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
].join('\n')

describe('parseChatMessages — system context (curated)', () => {
  const m = parseChatMessages(SYSTEM_FIXTURE)

  it('keeps whitelisted subtypes as system chips, drops noise, unifies local_command', () => {
    expect(m.map((x) => x.kind)).toEqual(['system', 'system', 'command', 'user'])
  })

  it('maps subtype to label/detail/level', () => {
    expect(m[0]).toEqual({ kind: 'system', label: 'Conversa compactada', detail: 'Conversation compacted', level: 'info' })
    expect(m[1]).toEqual({ kind: 'system', label: 'Erro de API', detail: 'rate limited', level: 'error' })
  })

  it('emits the SAME command kind as the current user-string format', () => {
    expect(m[2]).toEqual({ kind: 'command', name: 'model', args: '' })
  })

  it('extracts command_output from old-format local_command content, ANSI stripped', () => {
    const old = parseChatMessages(
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        level: 'info',
        content:
          '<command-name>/cost</command-name>\n<command-args></command-args>\n<local-command-stdout>\u001B[1mTotal:\u001B[22m $1.23</local-command-stdout>',
      }),
    )
    expect(old).toEqual([
      { kind: 'command', name: 'cost', args: '' },
      { kind: 'command_output', text: 'Total: $1.23' },
    ])
    // Mesmo output do formato atual (user-string) pros mesmos dados.
    const current = parseChatMessages(
      [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '<command-name>/cost</command-name>\n<command-args></command-args>' },
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '<local-command-stdout>\u001B[1mTotal:\u001B[22m $1.23</local-command-stdout>' },
        }),
      ].join('\n'),
    )
    expect(current).toEqual(old)
  })

  it('propagates compactMetadata (trigger/preTokens/postTokens) on compact_boundary', () => {
    const m2 = parseChatMessages(
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        level: 'info',
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 355910, postTokens: 19363 },
      }),
    )
    expect(m2).toEqual([
      {
        kind: 'system',
        label: 'Conversa compactada',
        detail: 'Conversation compacted',
        level: 'info',
        trigger: 'auto',
        preTokens: 355910,
        postTokens: 19363,
      },
    ])
  })
})

// Conteúdo de um agent-<hash>.jsonl: turnos do subagente (isSidechain). Cada linha
// assistant é um turno; o resumo junta o texto, ou lista ferramentas se for só
// tool_use. A 1ª linha user (o prompt) e linhas malformadas não contam como turno.
const SUBAGENT_JSONL = [
  JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'go' } }),
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Looking into it.' }] },
  }),
  '{ broken',
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
  }),
].join('\n')

describe('parseSubagentTurns', () => {
  it('counts assistant turns and summarizes text / tool-only turns', () => {
    const { turnCount, turns } = parseSubagentTurns(SUBAGENT_JSONL)
    expect(turnCount).toBe(2) // dois assistant; user e linha quebrada não contam
    expect(turns).toEqual(['Looking into it.', '⚙ Bash'])
  })

  it('returns zeroes for empty input', () => {
    expect(parseSubagentTurns('')).toEqual({ turnCount: 0, turns: [] })
  })
})

// Invocação Task/Agent no JSONL principal + dados do subagente (montados a partir
// de SUBAGENT_JSONL) → o tool_use vira o kind 'subagent'.
const MAIN_WITH_TASK = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'investigate' } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_sub',
          name: 'Agent',
          input: { subagent_type: 'Explore', description: 'Map the area' },
        },
      ],
    },
  }),
].join('\n')

describe('parseChatMessages — subagents', () => {
  function subMap(): Map<string, SubagentInfo> {
    const { turnCount, turns } = parseSubagentTurns(SUBAGENT_JSONL)
    return new Map([['toolu_sub', { name: 'Explore', description: 'Map the area', turnCount, turns }]])
  }

  it('emits a subagent kind with name/turnCount when data is provided', () => {
    const m = parseChatMessages(MAIN_WITH_TASK, subMap())
    expect(m.map((x) => x.kind)).toEqual(['user', 'subagent'])
    expect(m[1]).toEqual({
      kind: 'subagent',
      id: 'toolu_sub',
      name: 'Explore',
      description: 'Map the area',
      turnCount: 2,
      turns: ['Looking into it.', '⚙ Bash'],
    })
  })

  it('falls back to a generic tool_use when no subagent data matches the id', () => {
    const m = parseChatMessages(MAIN_WITH_TASK)
    expect(m[1].kind).toBe('tool_use')
    expect(m[1]).toMatchObject({ kind: 'tool_use', id: 'toolu_sub', name: 'Agent' })
  })

  it('folds the Task tool_result into a subagent_result (status), not a generic tool_result', () => {
    const withResult = [
      MAIN_WITH_TASK,
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', content: 'done', is_error: true }],
        },
      }),
    ].join('\n')
    const m = parseChatMessages(withResult, subMap())
    expect(m.map((x) => x.kind)).toEqual(['user', 'subagent', 'subagent_result'])
    expect(m[2]).toEqual({ kind: 'subagent_result', forId: 'toolu_sub', isError: true })
  })
})

// Interrupção (Ctrl+C). Shapes copiados de transcripts reais: a CLI grava uma
// linha type:'user' com o texto "[Request interrupted…]" + a chave top-level
// `interruptedMessageId` apontando o message.id do turno cortado, e marca
// `toolUseResult.interrupted` no tool_result de uma ferramenta abortada.
describe('parseChatMessages — interrupção por Ctrl+C', () => {
  it('marca o tool_use órfão do turno interrompido (nunca recebeu tool_result)', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_int1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Vou rodar o comando.' },
            { type: 'tool_use', id: 'tu_orfao', name: 'Bash', input: { command: 'sleep 120' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        interruptedMessageId: 'msg_int1',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
      }),
    ].join('\n')
    const msgs = parseChatMessages(jsonl)
    const toolUse = msgs.find((m) => m.kind === 'tool_use')
    expect(toolUse).toMatchObject({ kind: 'tool_use', name: 'Bash', interrupted: true })
    // O texto do mesmo turno também ficou pela metade.
    expect(msgs.find((m) => m.kind === 'assistant')).toMatchObject({ interrupted: true })
    // E o chip de sistema sobe pra 'warning' — não é um aviso cinza qualquer.
    expect(msgs.find((m) => m.kind === 'system')).toMatchObject({
      label: 'Interrompido pelo usuário',
      level: 'warning',
    })
  })

  it('NÃO marca o tool_use que chegou a responder antes da interrupção', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_int2',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_ok', name: 'Read', input: { file_path: '/a' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ok', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'user',
        interruptedMessageId: 'msg_int2',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      }),
    ].join('\n')
    const msgs = parseChatMessages(jsonl)
    expect(msgs.find((m) => m.kind === 'tool_use')).not.toHaveProperty('interrupted')
    expect(msgs.find((m) => m.kind === 'tool_result')).not.toHaveProperty('interrupted')
  })

  it('marca o tool_result parcial via toolUseResult.interrupted', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_int3',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_parcial', name: 'Bash', input: { command: 'npm test' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        toolUseResult: { stdout: 'rodando…', stderr: '', interrupted: true, isImage: false },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_parcial', content: 'rodando…', is_error: false }],
        },
      }),
    ].join('\n')
    const msgs = parseChatMessages(jsonl)
    expect(msgs.find((m) => m.kind === 'tool_result')).toMatchObject({
      kind: 'tool_result',
      isError: false,
      interrupted: true,
    })
  })

  it('interruptedMessageId sem correspondência não marca nada (fail-safe)', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text: 'pronto' }] },
      }),
      JSON.stringify({
        type: 'user',
        interruptedMessageId: 'msg_que_nao_existe',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      }),
    ].join('\n')
    const msgs = parseChatMessages(jsonl)
    expect(msgs.find((m) => m.kind === 'assistant')).not.toHaveProperty('interrupted')
  })
})
