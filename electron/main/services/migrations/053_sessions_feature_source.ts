import type Database from 'better-sqlite3'

export const version = 53
export const name = '053_sessions_feature_source'

// De onde veio o vínculo sessão↔feature. A resolução contínua só mexe no que
// ela mesma pôs ('resolver:<sinal>') e nunca no que o usuário escolheu
// ('manual', inclusive "sem feature"). Guardado no banco para sobreviver ao
// restart do app: em memória, todo vínculo do resolvedor virava do usuário e a
// sessão parava de seguir a branch. NULL = legado/spawn/herança (não é do
// resolvedor). `sessions` é machine-local e fica fora do sync.
export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE sessions ADD COLUMN feature_source TEXT;`)
}
