// Shared between the scenario and tool-cli: where the live session is described
// and where the scenario waits for a "go on" signal while paused.
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRATCH =
  process.env.DS_REAL_SCRATCH ??
  process.env.CLAUDE_SCRATCHPAD_DIR ??
  join(tmpdir(), 'design-breads-do-breno')

export const SESSION_FILE = join(SCRATCH, 'ds-real-session.json')
export const CONTINUE_FILE = join(SCRATCH, 'ds-real-continue')

export interface SessionInfo {
  userDataCopy: string
  mcpUrl: string
  docId: string
  artboards: Record<ArtboardKey, string>
}

export type ArtboardKey = 'home' | 'mobile' | 'menu' | 'contact'
