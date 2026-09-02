// Tools MCP das Reuniões v2. Handler fino: zod → recorder/store → retorno. As
// mutações (start/stop/nota) passam pelo recorder, que já emite os eventos
// 'meetings:event' pelos mesmos canais do IPC — nada a re-broadcastar aqui.
// Sem tool de delete: agente não recebe diálogo de confirmação.
import * as z from 'zod/v4'
import * as meetingStore from '../meetings/meeting-store'
import { getRecorder } from '../meetings/recorder-contract'
import { ok, type McpNotify, type ToolDef } from './tools'

const idSchema = z.object({ id: z.string().min(1) })
const startSchema = z.object({
  title: z.string().min(1).optional().describe('Meeting title. Defaults to "Reunião <date>".'),
})
const noteSchema = z.object({
  meetingId: z.string().min(1),
  text: z.string().min(1).describe('Quick note appended with an [mm:ss] timestamp to the meeting notes.'),
})
const searchSchema = z.object({
  q: z.string().min(1).describe('Free text, matched case-insensitively (LIKE) against title, notes, summary and transcript.'),
  limit: z.number().int().min(1).max(100).default(20),
})

export function meetingTools(_notify: McpNotify): ToolDef[] {
  return [
    {
      name: 'meeting_list',
      title: 'List meetings',
      description: 'List recorded meetings (newest first) with status, duration and segment count.',
      inputSchema: z.object({}),
      handler: () => ok({ items: meetingStore.list() }),
    },
    {
      name: 'meeting_get',
      title: 'Get meeting',
      description: 'Get one meeting with its full transcript (segments), user notes, summary and action items.',
      inputSchema: idSchema,
      handler: (args) => {
        const { id } = idSchema.parse(args)
        const detail = meetingStore.get(id)
        if (!detail) throw new Error(`Meeting not found: ${id}`)
        return ok({ ...detail, rawNotes: detail.meeting.rawNotes })
      },
    },
    {
      name: 'meeting_start',
      title: 'Start meeting recording',
      description:
        'Start recording a meeting (system audio + microphone, live transcription). Fails if one is already recording.',
      inputSchema: startSchema,
      handler: async (args) => {
        const { title } = startSchema.parse(args)
        const meeting = await getRecorder().start({ title })
        return ok({ meeting })
      },
    },
    {
      name: 'meeting_stop',
      title: 'Stop meeting recording',
      description:
        'Stop the current recording. Summary and action items are produced in the background; poll meeting_get until status is "done".',
      inputSchema: z.object({}),
      handler: async () => {
        const meeting = await getRecorder().stop()
        return ok({ meeting })
      },
    },
    {
      name: 'meeting_note_append',
      title: 'Append meeting note',
      description: 'Append a timestamped quick note to a meeting. Notes are folded into the summary.',
      inputSchema: noteSchema,
      handler: (args) => {
        const { meetingId, text } = noteSchema.parse(args)
        const meeting = getRecorder().appendQuickNote(meetingId, text)
        return ok({ meeting })
      },
    },
    {
      name: 'meeting_search',
      title: 'Search meetings',
      description:
        'Search meetings by text in title, notes, summary or transcript. Returns each match with the field it matched in and a snippet.',
      inputSchema: searchSchema,
      handler: (args) => {
        const { q, limit } = searchSchema.parse(args)
        return ok({ items: meetingStore.search(q, limit) })
      },
    },
  ]
}
