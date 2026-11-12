// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { endedNoticeSince, undoOk, type UndoRead } from './child-lifecycle'

const NOTICE = 'stdin: a filha "kid" foi encerrada pelo usuário e segue vinculada'

describe('endedNoticeSince', () => {
  it('aviso gravado antes da marca não conta', () => {
    const before = `stdin: oi\n${NOTICE}\n`

    expect(endedNoticeSince(`${before}stdin: outra coisa\n`, before.length)).toBeNull()
  })

  it('aviso gravado depois da marca devolve a linha dele', () => {
    const before = 'stdin: oi\n'

    expect(endedNoticeSince(`${before}${NOTICE}\nstdin: fim\n`, before.length)).toBe(NOTICE)
  })

  it('log que não cresceu desde a marca: sem aviso', () => {
    const log = `${NOTICE}\n`

    expect(endedNoticeSince(log, log.length)).toBeNull()
  })
})

// O que o passo (3) lê quando o Desfazer funciona. Montado à mão: quem produz
// este objeto é o próprio cenário, que só roda com o app buildado.
const UNDONE: UndoRead = {
  pediuConfirmacao: 1,
  marcaNoClique: 1_700_000_000_000,
  processoVivo: true,
  pidVivo: true,
  ended_by_user_at: null,
  handoff: 'running',
  abaDeVolta: 1,
  avisoAMae: null,
}

describe('undoOk', () => {
  it('perguntou uma vez, marcou no clique e o Desfazer devolveu tudo: passa', () => {
    expect(undoOk(UNDONE)).toBe(true)
  })

  it('X na filha trabalhando que fechou sem perguntar: reprova', () => {
    expect(undoOk({ ...UNDONE, pediuConfirmacao: 0 })).toBe(false)
  })

  it('mãe avisada do encerramento antes do Desfazer: reprova', () => {
    expect(undoOk({ ...UNDONE, avisoAMae: NOTICE })).toBe(false)
  })

  it.each<Partial<UndoRead>>([
    { marcaNoClique: null },
    { processoVivo: false },
    { pidVivo: false },
    { ended_by_user_at: 1_700_000_000_000 },
    { handoff: 'interrupted' },
    { abaDeVolta: 0 },
  ])('o que já reprovava segue reprovando: %j', (broken) => {
    expect(undoOk({ ...UNDONE, ...broken })).toBe(false)
  })
})
