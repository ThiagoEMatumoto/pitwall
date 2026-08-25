import type Database from "better-sqlite3";

export const version = 41;
export const name = "041_video_lab";

// Video Lab. Molde de 038_diagrams/035_content_contracts: persistência
// SQLite-only, listas e mapas como JSON em TEXT, enums garantidos por CHECK no
// banco porque a regra não pode depender de quem escreve (IPC, MCP ou teste).
//
// O eixo da área é REUSO: uma peça nunca nasce do zero, ela herda de um
// template (estilo + blueprint de cenas + elenco). INVARIANTES declaradas aqui
// porque é o schema que as sustenta:
//
// 1. REUSO É ESTRUTURAL, não convenção. `video_brand_kits`, `video_characters` e
//    `video_templates` NÃO têm project_id — não pertencem a peça nenhuma.
//    Apagar uma peça (`video_projects`) cascateia SÓ o que é dela: cenas,
//    linhas de roteiro, elenco escalado, assets e renders. Personagem e brand
//    kit sobrevivem, senão a segunda peça perderia o elenco da primeira.
// 2. `video_assets.project_id` é NULLABLE de propósito: NULL = asset
//    COMPARTILHADO (logo do brand kit, imagem de referência de personagem), que
//    não pode morrer junto com uma peça. Asset de peça tem project_id e
//    cascateia. É o que impede o delete de um projeto destruir a referência
//    visual que mantém o personagem consistente nas OUTRAS peças.
// 3. CONSISTÊNCIA É REPRODUTIBILIDADE. Toda imagem gerada registra
//    `provider`/`model`/`prompt`/`ref_ids` — o que a produziu. A peça é
//    reproduzível, não sorteada de novo. `video_characters.visual_spec` guarda
//    os traços INVARIANTES injetados em todo prompt do personagem, e
//    `video_character_refs` (com `is_approved`) é o conjunto de imagens que vai
//    como referência ao gerador.
// 4. IDEMPOTÊNCIA POR HASH é do banco, não do script. O índice único parcial
//    (project_id, kind, hash) WHERE hash IS NOT NULL espelha a convenção que já
//    existe no motor (`video/scripts/tts.mjs`: sha256(text+voiceId+modelId)) —
//    sem ele cada preview re-paga a API. hash NULL = asset sem chave de reuso
//    (importado à mão), e aí nada é deduplicado.
// 5. `video_scenes.scene_id` é o id TEXTUAL da cena ('cold-open', 'logo'), o
//    mesmo do contrato que o motor Remotion já consome. UNIQUE(project_id,
//    scene_id) existe pra sustentar a FK COMPOSTA de `video_script_lines` e
//    `video_assets` — é o que impede linha de roteiro ou asset apontando pra
//    cena que não existe mais.
// 6. `kind` de template e projeto é coluna ABERTA (só não-vazia): categoria
//    nova ('promo', 'character-story', o que vier) não pode exigir migration.
//    Os enums fechados são os que a máquina lê: kind de asset e status de
//    render/projeto.
// 7. `status` do projeto é a ETAPA DA ESTEIRA (draft → scripting → assets →
//    rendering → done); arquivar é `archived_at`, coluna separada — as duas
//    coisas são ortogonais e uma peça pronta pode ser arquivada.
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE video_brand_kits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (TRIM(name) <> ''),
      tokens TEXT NOT NULL DEFAULT '{}',
      tone_of_voice TEXT NOT NULL DEFAULT '',
      do_dont TEXT NOT NULL DEFAULT '{"do":[],"dont":[]}',
      logo_asset_id TEXT REFERENCES video_assets(id) ON DELETE SET NULL,
      tts_voices TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_video_brand_kits_updated ON video_brand_kits(updated_at DESC);
    CREATE INDEX idx_video_brand_kits_logo ON video_brand_kits(logo_asset_id);

    CREATE TABLE video_characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (TRIM(name) <> ''),
      canonical_description TEXT NOT NULL DEFAULT '',
      visual_spec TEXT NOT NULL DEFAULT '{}',
      voice_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX idx_video_characters_archived
      ON video_characters(archived_at, updated_at DESC);

    CREATE TABLE video_templates (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (TRIM(kind) <> ''),
      name TEXT NOT NULL CHECK (TRIM(name) <> ''),
      description TEXT NOT NULL DEFAULT '',
      scene_blueprint TEXT NOT NULL DEFAULT '[]',
      brand_kit_id TEXT REFERENCES video_brand_kits(id) ON DELETE SET NULL,
      default_cast TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_video_templates_kind ON video_templates(kind, updated_at DESC);
    CREATE INDEX idx_video_templates_brand_kit ON video_templates(brand_kit_id);

    CREATE TABLE video_projects (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE CHECK (TRIM(slug) <> ''),
      title TEXT NOT NULL CHECK (TRIM(title) <> ''),
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (TRIM(kind) <> ''),
      template_id TEXT REFERENCES video_templates(id) ON DELETE SET NULL,
      brand_kit_id TEXT REFERENCES video_brand_kits(id) ON DELETE SET NULL,
      locales TEXT NOT NULL DEFAULT '[]',
      theme_preset TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'scripting', 'assets', 'rendering', 'done')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX idx_video_projects_status ON video_projects(status, updated_at DESC);
    CREATE INDEX idx_video_projects_archived
      ON video_projects(archived_at, updated_at DESC);
    CREATE INDEX idx_video_projects_template ON video_projects(template_id);
    CREATE INDEX idx_video_projects_brand_kit ON video_projects(brand_kit_id);

    CREATE TABLE video_project_cast (
      project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES video_characters(id) ON DELETE CASCADE,
      role_in_piece TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_id, character_id)
    );
    CREATE INDEX idx_video_project_cast_character ON video_project_cast(character_id);

    CREATE TABLE video_scenes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
      scene_id TEXT NOT NULL CHECK (TRIM(scene_id) <> ''),
      ord INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT '',
      target_sec REAL NOT NULL DEFAULT 0,
      visual TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (project_id, scene_id)
    );
    CREATE INDEX idx_video_scenes_project ON video_scenes(project_id, ord);

    CREATE TABLE video_script_lines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      locale TEXT NOT NULL CHECK (TRIM(locale) <> ''),
      kind TEXT NOT NULL CHECK (kind IN ('narration', 'on_screen')),
      text TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      ord INTEGER NOT NULL DEFAULT 0,
      UNIQUE (project_id, scene_id, locale, kind, ord),
      FOREIGN KEY (project_id, scene_id)
        REFERENCES video_scenes(project_id, scene_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_video_script_lines_project
      ON video_script_lines(project_id, locale, ord);
    CREATE INDEX idx_video_script_lines_hash ON video_script_lines(text_hash);

    CREATE TABLE video_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES video_projects(id) ON DELETE CASCADE,
      scene_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN (
        'audio', 'texture', 'keyvisual', 'character', 'sfx', 'music'
      )),
      locale TEXT,
      path TEXT NOT NULL CHECK (TRIM(path) <> ''),
      hash TEXT,
      provider TEXT,
      model TEXT,
      prompt TEXT,
      ref_ids TEXT NOT NULL DEFAULT '[]',
      cost_cents INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER,
      duration_sec REAL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id, scene_id)
        REFERENCES video_scenes(project_id, scene_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_video_assets_project ON video_assets(project_id, created_at DESC);
    CREATE INDEX idx_video_assets_scene ON video_assets(project_id, scene_id);
    CREATE INDEX idx_video_assets_hash ON video_assets(hash);
    CREATE UNIQUE INDEX idx_video_assets_dedupe
      ON video_assets(project_id, kind, hash) WHERE hash IS NOT NULL;

    CREATE TABLE video_character_refs (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES video_characters(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
      is_approved INTEGER NOT NULL DEFAULT 0 CHECK (is_approved IN (0, 1)),
      ord INTEGER NOT NULL DEFAULT 0,
      UNIQUE (character_id, asset_id)
    );
    CREATE INDEX idx_video_character_refs_character
      ON video_character_refs(character_id, ord);
    CREATE INDEX idx_video_character_refs_asset ON video_character_refs(asset_id);

    CREATE TABLE video_renders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
      locale TEXT NOT NULL CHECK (TRIM(locale) <> ''),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'failed')),
      out_path TEXT,
      bytes INTEGER,
      duration_sec REAL,
      log TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX idx_video_renders_project ON video_renders(project_id, created_at DESC);
    CREATE INDEX idx_video_renders_status ON video_renders(status, created_at DESC);
  `);
}
