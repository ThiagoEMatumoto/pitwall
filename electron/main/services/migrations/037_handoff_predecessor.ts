import type Database from 'better-sqlite3'

export const version = 37
export const name = '037_handoff_predecessor'

// Linhagem da passagem de bastão: quando a sessão-filha de um handoff fica com o
// contexto cheio, uma sessão LIMPA assume o papel dela (mesmo handoff, mesmo
// lugar no painel) e child_session_id passa a apontar pra sucessora. Sem esta
// coluna o elo com a antecessora se perde no instante do relink — e a antecessora
// continua VIVA (o humano é quem a encerra), então "quem veio antes desta filha"
// é uma pergunta com resposta real, não histórico morto.
//
// Coluna, não context_json: aquele campo é texto livre serializado pela mãe e não
// sustenta consulta ("qual handoff veio desta sessão?") nem índice.
//
// TEXT sem FK, igual a child_session_id/from_repo_id: SQLite não cria FK enforced
// via ADD COLUMN, e a linhagem deve sobreviver à limpeza da sessão antecessora.
// Aditiva: ALTER ADD COLUMN não recria tabela nem toca a FK CASCADE da 018.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE handoffs ADD COLUMN predecessor_session_id TEXT;
  `)
}
