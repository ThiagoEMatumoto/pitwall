import type Database from 'better-sqlite3'

export const version = 39
export const name = '039_diagram_library'

// Biblioteca de shapes do Excalidraw (.excalidrawlib). Molde de 038: enum por
// CHECK no banco (a regra não pode depender de quem escreve — IPC, MCP ou
// teste), JSON cru em TEXT.
//
// INVARIANTES declaradas aqui porque é o schema que as sustenta:
//
// 1. A biblioteca é GLOBAL — uma por app, compartilhada por todos os canvases
//    (mesmo comportamento do Excalidraw web). Não há FK pra diagrams.
// 2. `id` é o LibraryItem.id do Excalidraw: vem do arquivo importado quando
//    existe, gerado no parse quando não. O merge do store é POR ID — instalar
//    de novo a mesma biblioteca sobrescreve o item, nunca duplica (PK).
// 3. `position` é a ordem estável do painel de biblioteca. replaceAll regrava
//    0..N-1 na ordem recebida do editor (o onLibraryChange manda o array
//    completo já ordenado); addItems põe ids inéditos no fim.
// 4. `elements` é JSON array cru do Excalidraw — não validado elemento a
//    elemento, mesma regra da cena em 038.
// 5. `created` é o epoch ms do ITEM (vem do arquivo); `updated_at` é nosso
//    (última escrita da row).
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE diagram_library_items (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'unpublished' CHECK (status IN ('published', 'unpublished')),
      elements TEXT NOT NULL,
      created INTEGER NOT NULL,
      position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}
