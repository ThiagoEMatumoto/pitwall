// Motivo gravado quando a filha encerrada pelo usuário deixa de estar em voo: no
// exit da PTY ou, se o app fechou antes, no sweep do boot. É o texto que a mãe lê
// no aviso: sem ele ela veria uma filha que "caiu" e re-despacharia. Fica fora do
// handoff-store porque o sweep roda dentro do getDb, que o store importa.
export const ENDED_BY_USER_ERROR =
  'Sessão-filha encerrada pelo usuário no Pitwall (não caiu nem falhou). Não re-despache este trabalho por conta própria: ela segue vinculada e o usuário a retoma quando quiser.'
