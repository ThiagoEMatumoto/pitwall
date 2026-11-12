// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  endedNoticeSince,
  tabOpenAtSend,
  undoOk,
  type SendTabsRead,
  type UndoRead,
} from './child-lifecycle'

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

// O que o passo (6) conta quando a aba abre antes do envio. Montado à mão pelo
// mesmo motivo do UNDONE.
const OPEN_AT_SEND: SendTabsRead = { antes: 2, noEnvio: 3, depois: 3, daFilha: 1 }

describe('tabOpenAtSend', () => {
  it('uma aba a mais na chegada do envio, a mesma conta depois e ela é a da filha: passa', () => {
    expect(tabOpenAtSend(OPEN_AT_SEND)).toBe(true)
  })

  it('aba que só abriu com o envio já no main: reprova', () => {
    expect(tabOpenAtSend({ ...OPEN_AT_SEND, noEnvio: 2 })).toBe(false)
  })

  it('envio que o espião não viu: reprova', () => {
    expect(tabOpenAtSend({ ...OPEN_AT_SEND, noEnvio: null })).toBe(false)
  })

  it('outra aba abriu depois do envio: a da chegada pode não ser a da filha, reprova', () => {
    expect(tabOpenAtSend({ ...OPEN_AT_SEND, depois: 4 })).toBe(false)
  })

  it('a aba que entrou não leva o rótulo da filha: reprova', () => {
    expect(tabOpenAtSend({ ...OPEN_AT_SEND, daFilha: 0 })).toBe(false)
  })
})
