import { describe, expect, it } from 'vitest'
import { collectParticipantEntries, collectParticipants } from './participants'

const seg = (text: string) => ({ text })

describe('collectParticipants', () => {
  it('lista Eu, os speakers da diarização e nomes citados, sem repetir', () => {
    const names = collectParticipants({
      speakers: [{ label: 'Bianca' }, { label: 'Participante 2' }],
      segments: [
        seg('Então a Bianca vai preparar o parecer e o Pedro manda o e-mail.'),
        seg('Combinei com a Bianca e com o Rodrigo.'),
        seg('Rodrigo fica com a revisão.'),
      ],
      rawNotes: '- [00:10] falar pra Ana sobre o prazo',
    })
    expect(names).toEqual(['Eu', 'Bianca', 'Participante 2', 'Pedro', 'Rodrigo', 'Ana'])
  })

  it('ignora palavras comuns com maiúscula e nomes curtos', () => {
    const names = collectParticipants({
      speakers: [],
      segments: [seg('Então a Gente vai ver. Mas o Sistema fica pronto na Sexta. E o Jo vai.')],
      rawNotes: '',
    })
    expect(names).toEqual(['Eu'])
  })

  it('usa o nome do usuário no lugar de Eu e marca a origem de cada entrada', () => {
    const entries = collectParticipantEntries({
      speakers: [{ label: 'Bianca' }],
      segments: [seg('O Pedro vai fechar o escopo.')],
      rawNotes: '',
      myName: 'Thiago',
    })
    expect(entries).toEqual([
      { name: 'Thiago', source: 'me' },
      { name: 'Bianca', source: 'voice' },
      { name: 'Pedro', source: 'mentioned' },
    ])
  })

  it('label de voz vence a citação com o mesmo nome (case-insensitive)', () => {
    const entries = collectParticipantEntries({
      speakers: [{ label: 'pedro' }],
      segments: [seg('Falei com o Pedro.')],
      rawNotes: '',
    })
    expect(entries.filter((e) => e.name.toLowerCase() === 'pedro')).toEqual([{ name: 'pedro', source: 'voice' }])
  })
})
