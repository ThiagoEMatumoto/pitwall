import type Database from 'better-sqlite3'

export const version = 60
export const name = '060_composer_drafts'

// Rascunho do Composer por pane, durável: sobrevive a kill do main, reboot e
// queda de energia. draft_key é 'pane:<paneId>' (o paneId atravessa o restore,
// inclusive quando a sessão sem transcript renasce com outro cc) ou 'cc:<cc>'
// quando o terminal não tem pane (quick look). attachments é JSON [{name,path}].
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE composer_drafts (
      draft_key     TEXT PRIMARY KEY,
      cc_session_id TEXT,
      pane_id       TEXT,
      text          TEXT NOT NULL,
      attachments   TEXT NOT NULL DEFAULT '[]',
      updated_at    INTEGER NOT NULL
    )
  `)
}
