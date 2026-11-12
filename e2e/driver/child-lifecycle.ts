// Vereditos do cenário validate-child-lifecycle que dependem só do que ele leu.

export const ENDED_BY_USER = /encerrada pelo usuário/i

// A linha do aviso de encerramento no trecho do log escrito depois de `from` (o
// tamanho do log antes do passo). Um aviso mais antigo não é o deste passo.
export const endedNoticeSince = (log: string, from: number): string | null =>
  log
    .slice(from)
    .split('\n')
    .find((line) => ENDED_BY_USER.test(line)) ?? null

// O que o passo "X na filha trabalhando + Desfazer" leu.
export interface UndoRead {
  pediuConfirmacao: number
  marcaNoClique: number | null
  processoVivo: boolean
  pidVivo: boolean
  ended_by_user_at: number | null
  handoff: string
  abaDeVolta: number
  avisoAMae: string | null
}

// O X perguntou uma vez e marcou no clique; depois do Desfazer não sobrou nada
// do encerramento, nem o aviso à mãe.
export const undoOk = (read: UndoRead): boolean =>
  read.pediuConfirmacao === 1 &&
  read.marcaNoClique !== null &&
  read.processoVivo &&
  read.pidVivo &&
  read.ended_by_user_at === null &&
  read.handoff === 'running' &&
  read.abaDeVolta === 1 &&
  read.avisoAMae === null

// As abas que o passo "recado do usuário à filha fora da tela" contou: todas as
// da janela antes do Enter, na chegada do envio ao main (null se o espião não o
// viu) e depois dele; e, no fim, as que levam o rótulo da filha.
export interface SendTabsRead {
  antes: number
  noEnvio: number | null
  depois: number
  daFilha: number
}

// O envio encontrou a aba da filha aberta: uma aba a mais já na chegada, nenhuma
// outra depois, e a que entrou é a da filha.
export const tabOpenAtSend = (read: SendTabsRead): boolean =>
  read.noEnvio === read.antes + 1 && read.depois === read.noEnvio && read.daFilha === 1
