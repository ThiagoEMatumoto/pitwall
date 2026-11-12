import { describe, expect, it } from 'vitest'
import { REPLAY_PENDING, replayStep, type ReplayEvent } from './backlog-replay'

const data = (chunk: string): ReplayEvent => ({ kind: 'data', data: chunk })
const backlog = (snapshot: string): ReplayEvent => ({ kind: 'backlog', backlog: snapshot })

// O que o xterm recebe, na ordem, para os eventos que a pane viu desde o mount.
function writes(events: ReplayEvent[]): string[] {
  return events.reduce(
    (acc, event) => {
      const step = replayStep(acc.state, event)
      return { state: step.state, written: step.write ? [...acc.written, step.write] : acc.written }
    },
    { state: REPLAY_PENDING, written: [] as string[] },
  ).written
}

describe('replay do backlog', () => {
  it('o que chegou antes da resposta não é escrito: o backlog já cobre', () => {
    expect(
      writes([data('banner\r\n'), data('linha 1\r\n'), backlog('banner\r\nlinha 1\r\n')]),
    ).toEqual(['banner\r\nlinha 1\r\n'])
  })

  it('backlog cortado, com mais live visto do que ele tem: nada se repete', () => {
    const seen = ['linha 1\r\n', 'linha 2\r\n', 'linha 3\r\n']
    const capped = seen.join('').slice(-16)

    expect(writes([...seen.map(data), backlog(capped)])).toEqual([capped])
  })

  it('o que chega depois da resposta é escrito inteiro, na ordem', () => {
    expect(writes([data('a'), backlog('a'), data('b'), data('c'), data('d')])).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('backlog cortado seguido de mais saída: backlog e depois só o que veio depois', () => {
    const capped = 'x'.repeat(8)
    const after = 'y'.repeat(20)

    expect(writes([data('x'.repeat(30)), backlog(capped), data(after)])).toEqual([capped, after])
  })

  it('sessão sem saída: backlog vazio não escreve nada e libera o live', () => {
    expect(writes([backlog(''), data('primeiro byte')])).toEqual(['primeiro byte'])
  })

  it('backlog que falhou: o live visto desde o mount é o que resta para mostrar', () => {
    expect(
      writes([
        data('linha 1\r\n'),
        data('linha 2\r\n'),
        { kind: 'backlog-failed' },
        data('linha 3\r\n'),
      ]),
    ).toEqual(['linha 1\r\nlinha 2\r\n', 'linha 3\r\n'])
  })

  it('não muta o estado recebido', () => {
    const before = replayStep(REPLAY_PENDING, data('a')).state
    const snapshot = { ...before }

    replayStep(before, data('b'))
    replayStep(before, backlog('ab'))

    expect(before).toEqual(snapshot)
    expect(REPLAY_PENDING).toEqual({ replied: false, held: '' })
  })
})
