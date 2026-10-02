import { describe, expect, it } from 'vitest'
import {
  absorbUserSections,
  BUSINESS_RULES_SECTION,
  FIXED_NOTES_SECTION,
  appendFixedNote,
  getSection,
  replaceSection,
  spliceUserSections,
  splitFixedNotes,
  stripUserSections,
} from './feature-sections'

const DISK = `
## Visão geral

Checkout novo.

## Regras de negócio

- Desconto máx 10%
- Frete grátis acima de R$ 200

## Notas fixadas

Lembrar do **PIX**.

---

Falar com o jurídico.

## Estado atual

Metade pronta.

## Decisões

- Usar Stripe.
`

describe('getSection', () => {
  it('devolve o conteúdo da seção sem o heading', () => {
    expect(getSection(DISK, 'Estado atual')).toBe('Metade pronta.')
    expect(getSection(DISK, BUSINESS_RULES_SECTION)).toContain('Desconto máx 10%')
  })

  it('seção ausente vira string vazia', () => {
    expect(getSection(DISK, 'Linha do tempo')).toBe('')
  })
})

describe('replaceSection', () => {
  it('troca só a seção alvo e deixa o resto byte a byte', () => {
    const next = replaceSection(DISK, 'Estado atual', 'Quase pronto.')
    expect(getSection(next, 'Estado atual')).toBe('Quase pronto.')
    expect(next.replace('Quase pronto.', 'Metade pronta.')).toBe(DISK)
  })

  it('seção ausente: doc antigo ganha a seção na posição canônica', () => {
    const old = '\n## Visão geral\n\nX.\n\n## Estado atual\n\nY.\n'
    const next = replaceSection(old, BUSINESS_RULES_SECTION, 'Desconto máx 10%')
    expect(getSection(next, BUSINESS_RULES_SECTION)).toBe('Desconto máx 10%')
    expect(next.indexOf('## Regras de negócio')).toBeGreaterThan(next.indexOf('## Visão geral'))
    expect(next.indexOf('## Regras de negócio')).toBeLessThan(next.indexOf('## Estado atual'))
    expect(getSection(next, 'Estado atual')).toBe('Y.')
  })
})

describe('stripUserSections', () => {
  it('tira as seções do usuário do que vai pro prompt da síntese', () => {
    const stripped = stripUserSections(DISK)
    expect(stripped).not.toContain('Regras de negócio')
    expect(stripped).not.toContain('Desconto')
    expect(stripped).not.toContain('Notas fixadas')
    expect(getSection(stripped, 'Estado atual')).toBe('Metade pronta.')
  })
})

describe('spliceUserSections', () => {
  const hostileLlm = `
## Visão geral

Checkout novo, reescrito.

## Regras de negócio

- Desconto máx 50%

## Notas fixadas

(o modelo apagou as notas)

## Estado atual

Pronto.
`

  it('as seções do usuário saem byte a byte iguais às do disco, venha o que vier do modelo', () => {
    const out = spliceUserSections(hostileLlm, DISK)
    const chunk = (body: string, h: string) => {
      const start = body.indexOf(`## ${h}\n`)
      const end = body.indexOf('\n## ', start + 1)
      return body.slice(start, end)
    }
    expect(chunk(out, BUSINESS_RULES_SECTION)).toBe(chunk(DISK, BUSINESS_RULES_SECTION))
    expect(chunk(out, FIXED_NOTES_SECTION)).toBe(chunk(DISK, FIXED_NOTES_SECTION))
    expect(out).not.toContain('50%')
    expect(out).not.toContain('o modelo apagou')
    expect(getSection(out, 'Estado atual')).toBe('Pronto.')
    expect(getSection(out, 'Visão geral')).toBe('Checkout novo, reescrito.')
  })

  it('o modelo omitiu as seções: elas voltam do disco, logo após a Visão geral', () => {
    const llm = '\n## Visão geral\n\nV.\n\n## Estado atual\n\nE.\n'
    const out = spliceUserSections(llm, DISK)
    expect(getSection(out, BUSINESS_RULES_SECTION)).toBe(getSection(DISK, BUSINESS_RULES_SECTION))
    expect(getSection(out, FIXED_NOTES_SECTION)).toBe(getSection(DISK, FIXED_NOTES_SECTION))
    const order = ['Visão geral', BUSINESS_RULES_SECTION, FIXED_NOTES_SECTION, 'Estado atual'].map(
      (h) => out.indexOf(`## ${h}\n`),
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('doc antigo sem as seções: entram vazias (lazy, no primeiro write)', () => {
    const out = spliceUserSections('\n## Visão geral\n\nV.\n', '\n## Visão geral\n\nantigo\n')
    expect(out).toContain('## Regras de negócio')
    expect(out).toContain('## Notas fixadas')
    expect(getSection(out, BUSINESS_RULES_SECTION)).toBe('')
  })
})

describe('notas fixadas', () => {
  it('separa as notas pela linha ---', () => {
    expect(splitFixedNotes(getSection(DISK, FIXED_NOTES_SECTION))).toEqual([
      'Lembrar do **PIX**.',
      'Falar com o jurídico.',
    ])
    expect(splitFixedNotes('')).toEqual([])
  })

  it('anexar nota acrescenta no fim com separador', () => {
    expect(appendFixedNote('', '  Nova  ')).toBe('Nova')
    expect(splitFixedNotes(appendFixedNote('A\n\n---\n\nB', 'C'))).toEqual(['A', 'B', 'C'])
  })
})

describe('`## ` digitado dentro de uma seção do usuário', () => {
  const BASE = `## Visão geral\n\nX.\n\n## Notas fixadas\n\n## Estado atual\n\nY.\n`

  it('é rebaixado para `### ` e o texto inteiro continua nas notas', () => {
    const body = replaceSection(BASE, FIXED_NOTES_SECTION, 'Lembrete\n\n## Checklist\n- a')
    expect(getSection(body, FIXED_NOTES_SECTION)).toBe('Lembrete\n\n### Checklist\n- a')
    expect(stripUserSections(body)).not.toContain('Checklist')
    expect(getSection(body, 'Estado atual')).toBe('Y.')
  })

  it('salvar de novo substitui tudo (não acumula o trecho antigo)', () => {
    const once = replaceSection(BASE, FIXED_NOTES_SECTION, 'Lembrete\n\n## Checklist\n- a')
    const twice = replaceSection(once, FIXED_NOTES_SECTION, 'Outro')
    expect(getSection(twice, FIXED_NOTES_SECTION)).toBe('Outro')
    expect(twice).not.toContain('Checklist')
  })

  it('a síntese devolve as notas do disco byte a byte, mesmo com sub-heading', () => {
    const disk = replaceSection(BASE, FIXED_NOTES_SECTION, 'PIX\n\n## Pagamento\nsó acima de R$50')
    const llm = `## Visão geral\n\nNovo.\n\n## Notas fixadas\n\nreescrito\n\n## Estado atual\n\nZ.\n`
    const out = spliceUserSections(llm, disk)
    expect(getSection(out, FIXED_NOTES_SECTION)).toBe(getSection(disk, FIXED_NOTES_SECTION))
    expect(out).not.toContain('reescrito')
  })

  it('`## ` dentro de bloco de código não corta a seção nem é reescrito', () => {
    const md = 'Exemplo:\n\n```md\n## não é seção\n```'
    const body = replaceSection(BASE, BUSINESS_RULES_SECTION, md)
    expect(getSection(body, BUSINESS_RULES_SECTION)).toBe(md)
  })

  it('heading da seção do usuário com outra caixa/acento na saída do LLM também sai', () => {
    const llm = `## Visão geral\n\nA.\n\n## Regras de Negócio\n\ninventada\n\n## notas  fixadas\n\nidem\n`
    expect(stripUserSections(llm)).not.toContain('inventada')
    expect(stripUserSections(llm)).not.toContain('idem')
  })
})

describe('bloco de código sem fechar numa seção do usuário', () => {
  const BODY =
    '## Visão geral\n\nV.\n\n## Regras de negócio\n\nR.\n\n## Notas fixadas\n\nN.\n\n## Estado atual\n\nEstado X\n\n## Decisões\n\nD1\n\n## Linha do tempo\n\nT1\n'

  it('o autosave no meio da cerca não engole as seções seguintes', () => {
    const mid = replaceSection(BODY, FIXED_NOTES_SECTION, 'Nota A\n\n```bash\nnpm test')
    expect(getSection(mid, 'Estado atual')).toBe('Estado X')
    expect(getSection(mid, 'Decisões')).toBe('D1')
    const done = replaceSection(mid, FIXED_NOTES_SECTION, 'Nota A\n\n```bash\nnpm test\n```')
    expect(getSection(done, 'Estado atual')).toBe('Estado X')
    expect(getSection(done, 'Linha do tempo')).toBe('T1')
    expect(getSection(done, FIXED_NOTES_SECTION)).toBe('Nota A\n\n```bash\nnpm test\n```')
  })

  it('cerca aberta digitada à mão no .md não engole a seção canônica seguinte', () => {
    const body = BODY.replace('R.', 'R.\n\n```js\nconst x = 1')
    expect(getSection(body, FIXED_NOTES_SECTION)).toBe('N.')
    expect(getSection(body, 'Estado atual')).toBe('Estado X')
  })

  it('a síntese não duplica as seções seguintes', () => {
    const mid = replaceSection(BODY, BUSINESS_RULES_SECTION, 'R.\n```js')
    const llm = '## Visão geral\n\nV2.\n\n## Estado atual\n\nEstado Y\n\n## Decisões\n\nD2\n\n## Linha do tempo\n\nT2\n'
    const out = spliceUserSections(llm, mid)
    expect(out.match(/^## Estado atual$/gm)).toHaveLength(1)
    expect(getSection(out, 'Estado atual')).toBe('Estado Y')
    expect(getSection(out, FIXED_NOTES_SECTION)).toBe('N.')
  })
})

describe('heading do usuário com outra caixa/acento no disco', () => {
  const disk = '## Visão geral\n\nV.\n\n## Regras de Negócio\n\nSó PJ\n\n## notas fixadas\n\nN.\n\n## Estado atual\n\nE.\n'

  it('o painel e o system prompt enxergam a seção', () => {
    expect(getSection(disk, BUSINESS_RULES_SECTION)).toBe('Só PJ')
    expect(getSection(disk, FIXED_NOTES_SECTION)).toBe('N.')
  })

  it('a síntese preserva o conteúdo sob o heading canônico', () => {
    const out = spliceUserSections('## Visão geral\n\nV2.\n\n## Estado atual\n\nE2.\n', disk)
    expect(getSection(out, BUSINESS_RULES_SECTION)).toBe('Só PJ')
    expect(out).toContain('## Regras de negócio\n\nSó PJ')
    expect(out).not.toContain('Regras de Negócio')
  })

  it('o autosave substitui a variante em vez de criar uma segunda seção', () => {
    const out = replaceSection(disk, BUSINESS_RULES_SECTION, 'Só PJ e MEI')
    expect(out.match(/^## regras de neg/gim)).toHaveLength(1)
    expect(getSection(out, BUSINESS_RULES_SECTION)).toBe('Só PJ e MEI')
  })
})

describe('absorbUserSections (merge de duplicata)', () => {
  const target = '## Visão geral\n\nT.\n\n## Regras de negócio\n\n- Só PJ\n\n## Notas fixadas\n\nNota T\n\n## Estado atual\n\nE.\n'
  const source = '## Visão geral\n\nS.\n\n## Regras de negócio\n\n- Desconto máx 10%\n\n## Notas fixadas\n\nNota T\n\n---\n\nNota S\n'

  it('regras e notas da origem entram no destino, sem repetir o que já está lá', () => {
    const out = absorbUserSections(target, source)
    expect(getSection(out, BUSINESS_RULES_SECTION)).toBe('- Só PJ\n\n- Desconto máx 10%')
    expect(splitFixedNotes(getSection(out, FIXED_NOTES_SECTION))).toEqual(['Nota T', 'Nota S'])
    expect(getSection(out, 'Estado atual')).toBe('E.')
    expect(absorbUserSections(out, source)).toBe(out)
  })

  it('origem sem seções do usuário: destino intacto', () => {
    expect(absorbUserSections(target, '## Visão geral\n\nS.\n')).toBe(target)
  })
})
