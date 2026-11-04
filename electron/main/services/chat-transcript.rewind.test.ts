import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseChatMessages, rewoundUuids } from './chat-transcript'

// JSONL real (sonda e2e-rewind-restore, claude 2.1.318): 10 mensagens, "Voltar a este
// ponto" na 5ª ("Crie o arquivo extra.txt…") + Restore conversation, e uma mensagem nova.
// O restore não reescreve o arquivo: "ok depois" nasce do pai da mensagem restaurada.
// Anexos ficam só com uuid/parentUuid/tipo (a cadeia passa por eles; o payload é da conta).
const jsonl = readFileSync(
  join(__dirname, '../../../shared/tui/__fixtures__/claude-2.1.318-rewind-e2e-restored.jsonl'),
  'utf8',
)
const userTexts = (text: string) =>
  parseChatMessages(text)
    .filter((m) => m.kind === 'user')
    .map((m) => (m as { text: string }).text)

describe('chat depois de um rewind', () => {
  it('só o ramo vivo: as mensagens desfeitas saem do chat', () => {
    expect(userTexts(jsonl)).toEqual([
      'Responda só: ok zero.',
      'Crie o arquivo notas.txt contendo só a linha: um. Não faça mais nada.',
      'Responda só: ok dois.',
      "Acrescente a linha 'tres' ao final de notas.txt. Não faça mais nada.",
      'Responda só: ok depois.',
    ])
    const all = parseChatMessages(jsonl)
    expect(
      all.some((m) => m.kind === 'assistant' && /nove/i.test((m as { text: string }).text)),
    ).toBe(false)
  })

  it('a janela do tail (sem o começo do arquivo) também descarta', () => {
    const lines = jsonl.trimEnd().split('\n')
    const tail = lines.slice(Math.floor(lines.length / 3)).join('\n')
    const texts = userTexts(tail)
    expect(texts).toContain('Responda só: ok depois.')
    expect(texts).not.toContain('Responda só: ok nove.')
  })

  it('antes da mensagem nova o arquivo não tem bifurcação: nada sai', () => {
    const lines = jsonl.trimEnd().split('\n')
    const cut = lines.findIndex((l) => l.includes('Responda só: ok depois.'))
    const before = lines.slice(0, cut).join('\n')
    expect(rewoundUuids(before.split('\n').map((l) => JSON.parse(l))).size).toBe(0)
    expect(userTexts(before)).toContain('Responda só: ok nove.')
  })

  it('irmãos assistant/user (comuns em sessão normal) não contam como rewind', () => {
    const line = (o: object) => JSON.stringify(o)
    const text = [
      line({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: 'oi' },
      }),
      line({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'olá' }] },
      }),
      line({
        type: 'user',
        uuid: 'r1',
        parentUuid: 'u1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }],
        },
      }),
      line({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: { role: 'user', content: 'e aí' },
      }),
    ].join('\n')
    expect(userTexts(text)).toEqual(['oi', 'e aí'])
  })
})
