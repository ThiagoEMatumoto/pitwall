import type Database from 'better-sqlite3'

export const version = 64
export const name = '064_drop_meetings_video'

// Remoção de Reuniões (v2, migrations 045/047) e Video Lab (041). O código saiu
// junto nesta mudança; esta migration só recolhe o schema órfão. Mesmo
// raciocínio da 044:
//
// 1. 041, 045 e 047 continuam no array — um banco antigo precisa aplicar a
//    cadeia inteira em ordem.
// 2. DROP filha → mãe. Com foreign_keys ON, DROP TABLE faz um DELETE implícito
//    e falha se outra tabela ainda referencia a que cai. O Video Lab tem um
//    ciclo (video_brand_kits.logo_asset_id → video_assets → video_projects →
//    video_brand_kits): video_assets cai antes de video_brand_kits e o SET NULL
//    do logo resolve o ciclo. Nenhuma das tabelas tem FTS nem trigger; os
//    índices caem com elas.
// 3. `diagram_links` sobrevive: só apagamos as linhas de reunião. O CHECK da 038
//    segue aceitando 'meeting' (recriar a tabela custaria um 12-step sem ganho).
//    `design_links` nunca aceitou 'meeting' nem 'video'.
export function up(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS video_renders;
    DROP TABLE IF EXISTS video_character_refs;
    DROP TABLE IF EXISTS video_assets;
    DROP TABLE IF EXISTS video_script_lines;
    DROP TABLE IF EXISTS video_scenes;
    DROP TABLE IF EXISTS video_project_cast;
    DROP TABLE IF EXISTS video_projects;
    DROP TABLE IF EXISTS video_templates;
    DROP TABLE IF EXISTS video_characters;
    DROP TABLE IF EXISTS video_brand_kits;

    DROP TABLE IF EXISTS meeting_v2_speakers;
    DROP TABLE IF EXISTS meeting_v2_voices;
    DROP TABLE IF EXISTS meeting_v2_action_items;
    DROP TABLE IF EXISTS meeting_v2_segments;
    DROP TABLE IF EXISTS meetings_v2;

    DELETE FROM diagram_links WHERE parent_type = 'meeting';
  `)
}
