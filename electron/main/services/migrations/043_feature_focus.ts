import type Database from 'better-sqlite3'

export const version = 43
export const name = '043_feature_focus'

// Foco da parede de features: o que o humano puxou pra frente (pinned +
// focus_rank) e o que o auto-registro DESCONFIA ser repetido (duplicate_of +
// duplicate_score). Puramente aditiva — só ALTER TABLE ADD COLUMN, nenhuma
// tabela reconstruída, então não precisa de disableForeignKeys.
//
// Decisões que o schema sustenta:
//
// 1. `pinned` e `focus_rank` são colunas de `features`, não tabela à parte: são
//    atributos 1:1 da feature, e `features` já é sincronizada inteira (o
//    exporter usa SELECT * + PRAGMA table_info) — as colunas entram no bundle
//    sozinhas, sem tocar em sync/bundle-format.ts.
// 2. `focus_rank` é REAL, não INTEGER: a ordenação manual da parede insere ENTRE
//    dois vizinhos (rank = (a+b)/2) sem reescrever a coluna inteira a cada
//    arrasto. NULL = "sem posição explícita" — a UI ordena essas por atividade,
//    como já fazia. Materializar um índice aqui obrigaria a renumerar todo mundo
//    no primeiro drag.
// 3. `duplicate_of` é auto-referência com ON DELETE SET NULL: a suspeita morre
//    com o candidato, sem sobrar ponteiro pendurado. O SQLite só aceita
//    REFERENCES em ADD COLUMN quando o default é NULL — é o caso.
// 4. A suspeita mora aqui e não numa tabela de issues porque é um fato de UMA
//    feature (este rascunho parece o F1), não um relacionamento n:n: o
//    auto-registro guarda o MELHOR candidato, e mesclar/dispensar limpa o par.
//    Os issues continuam DERIVADOS na leitura (issuesOf) — o que se persiste é
//    o candidato, não a issue.
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE features ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE features ADD COLUMN focus_rank REAL;
    ALTER TABLE features ADD COLUMN duplicate_of TEXT REFERENCES features(id) ON DELETE SET NULL;
    ALTER TABLE features ADD COLUMN duplicate_score REAL;
  `)
}
