import type Database from 'better-sqlite3'

export const version = 44
export const name = '044_drop_removed_features'

// Remoção das features mortas: Dossiês, Reuniões, Jobs agendados e Contratos de
// conteúdo. O código (IPC, stores, UI, tools MCP) saiu junto nesta mudança; esta
// migration só recolhe o schema que ficou órfão.
//
// Decisões:
//
// 1. As migrations 022-025, 028, 029 e 035 continuam no array. Um banco antigo
//    precisa poder aplicar a cadeia inteira em ordem — reescrever o passado
//    quebraria qualquer instalação que ainda não chegou aqui. Cria e depois
//    derruba é mais barato que uma cadeia não-linear.
// 2. DROP na ordem filha → mãe (e a FTS5 antes das tabelas que a alimentam), pra
//    que nenhum DROP encoste numa FK ainda apontada. Os triggers de
//    `meeting_search` caem junto com as tabelas que os hospedam.
// 3. `diagram_links` SOBREVIVE: só apagamos as linhas cujo parent_type era uma
//    das entidades removidas. O CHECK da 038 segue aceitando esses valores — é
//    constraint de tabela recriada, e recriar `diagram_links` só pra estreitar o
//    enum custaria um 12-step sem ganho (o TypeScript já não emite os valores).
export function up(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS meeting_search;
    DROP TABLE IF EXISTS meeting_extractions;
    DROP TABLE IF EXISTS meeting_segments;
    DROP TABLE IF EXISTS meeting_speakers;
    DROP TABLE IF EXISTS meetings;

    DROP TABLE IF EXISTS evidence_records;
    DROP TABLE IF EXISTS sources;
    DROP TABLE IF EXISTS dossier_runs;
    DROP TABLE IF EXISTS dossiers;

    DROP TABLE IF EXISTS job_runs;
    DROP TABLE IF EXISTS scheduled_jobs;

    DROP TABLE IF EXISTS content_gate_runs;
    DROP TABLE IF EXISTS content_contract_versions;
    DROP TABLE IF EXISTS content_contracts;

    DELETE FROM diagram_links
     WHERE parent_type IN ('dossier', 'meeting', 'content_contract');
  `)
}
