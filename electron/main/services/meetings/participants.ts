// Lista de participantes pros prompts: quem foi identificado pela voz
// (speakers da diarização), quem gravou ("Eu") e nomes citados no transcript
// ou nas notas. A citação é heurística por regex — só pt-BR, só maiúscula
// inicial, e nunca substitui um label de voz.
import type { MeetingSegment, MeetingSpeaker } from '../../../../shared/types/meetings'

export type ParticipantSource = 'me' | 'voice' | 'mentioned'

export interface ParticipantEntry {
  name: string
  source: ParticipantSource
}

export interface ParticipantsInput {
  speakers: Array<Pick<MeetingSpeaker, 'label'>>
  segments: Array<Pick<MeetingSegment, 'text'>>
  rawNotes: string
  /** Nome do usuário (pref meeting_my_name); sem ele, entra como "Eu". */
  myName?: string | null
}

export const ME_LABEL = 'Eu'

const MENTION_AFTER_PREPOSITION = /\b(?:o|a|do|da|pro|pra|com|e)\s+([A-ZÁ-Ú][a-zá-ú]{2,})\b/gu
const MENTION_BEFORE_VERB = /\b([A-ZÁ-Ú][a-zá-ú]{2,})\s+(?:vai|fica|faz|manda|envia|prepara)\b/gu

// Palavras que casam com os padrões acima mas não são nomes.
const NOT_NAMES = new Set(
  [
    'Então',
    'Mas',
    'Não',
    'Sim',
    'Ele',
    'Ela',
    'Eles',
    'Elas',
    'Isso',
    'Isto',
    'Esse',
    'Essa',
    'Este',
    'Esta',
    'Aqui',
    'Agora',
    'Hoje',
    'Amanhã',
    'Ontem',
    'Gente',
    'Pessoal',
    'Bom',
    'Boa',
    'Tudo',
    'Nada',
    'Todo',
    'Toda',
    'Todos',
    'Todas',
    'Cada',
    'Qual',
    'Quando',
    'Onde',
    'Como',
    'Que',
    'Quem',
    'Vou',
    'Vai',
    'Vamos',
    'Você',
    'Vocês',
    'Nós',
    'Depois',
    'Antes',
    'Segunda',
    'Terça',
    'Quarta',
    'Quinta',
    'Sexta',
    'Sábado',
    'Domingo',
    'Semana',
    'Mês',
    'Ano',
    'Dia',
    'Reunião',
    'Cliente',
    'Time',
    'Equipe',
    'Projeto',
    'Sistema',
    'Processo',
    'Brasil',
    'Pois',
    'Tipo',
    'Coisa',
    'Certo',
    'Claro',
    'Beleza',
    'Obrigado',
    'Obrigada',
    'Participante',
    'Eu',
  ].map((w) => w.toLowerCase()),
)

function mentionedNames(text: string): string[] {
  const found: string[] = []
  for (const re of [MENTION_AFTER_PREPOSITION, MENTION_BEFORE_VERB]) {
    for (const m of text.matchAll(re)) {
      const name = m[1]
      if (!NOT_NAMES.has(name.toLowerCase())) found.push(name)
    }
  }
  return found
}

export function collectParticipantEntries(input: ParticipantsInput): ParticipantEntry[] {
  const seen = new Set<string>()
  const out: ParticipantEntry[] = []
  const push = (name: string, source: ParticipantSource) => {
    const key = name.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ name: name.trim(), source })
  }

  push(input.myName?.trim() || ME_LABEL, 'me')
  for (const s of input.speakers) push(s.label, 'voice')
  const text = [...input.segments.map((s) => s.text), input.rawNotes].join('\n')
  for (const name of mentionedNames(text)) push(name, 'mentioned')
  return out
}

export function collectParticipants(input: ParticipantsInput): string[] {
  return collectParticipantEntries(input).map((p) => p.name)
}
