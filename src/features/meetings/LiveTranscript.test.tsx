import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MeetingSegment } from '../../../shared/types/ipc'
import { LiveTranscript } from './LiveTranscript'
import { SPEAKER_COLORS } from './SpeakerName'

function seg(partial: Partial<MeetingSegment> & Pick<MeetingSegment, 'id' | 'text'>): MeetingSegment {
  return {
    meetingId: 'm',
    speaker: 'them',
    startMs: 0,
    endMs: 1000,
    chunkIndex: 0,
    createdAt: 0,
    speakerId: null,
    speakerLabel: null,
    ...partial,
  }
}

const segments = [
  seg({
    id: 'a',
    text: 'oi',
    speakerId: 's1',
    speakerLabel: 'Bianca',
    startMs: 0,
  }),
  seg({ id: 'b', text: 'tudo bem', speaker: 'me', startMs: 5_000 }),
  seg({
    id: 'c',
    text: 'sim',
    speakerId: 's2',
    speakerLabel: 'Participante 2',
    startMs: 10_000,
  }),
  seg({ id: 'd', text: 'sem diarização', startMs: 15_000 }),
]

describe('LiveTranscript', () => {
  it('mostra o label do speaker, Eu para o mic e themLabel sem diarização', () => {
    render(<LiveTranscript segments={segments} themLabel="Cliente" recording={false} />)
    expect(screen.getByText('Bianca')).toBeInTheDocument()
    expect(screen.getByText('Eu')).toBeInTheDocument()
    expect(screen.getByText('Participante 2')).toBeInTheDocument()
    expect(screen.getByText('Cliente')).toBeInTheDocument()
  })

  it('cor por speakerId (ordem de aparição) e accent para Eu', () => {
    render(<LiveTranscript segments={segments} themLabel="Cliente" recording={false} onRenameSpeaker={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Bianca' })).toHaveStyle({
      color: SPEAKER_COLORS[0],
    })
    expect(screen.getByRole('button', { name: 'Participante 2' })).toHaveStyle({
      color: SPEAKER_COLORS[1],
    })
    expect(screen.getByText('Eu')).toHaveStyle({
      color: 'var(--color-accent)',
    })
  })

  it('só labels com speakerId são clicáveis; Enter renomeia, Escape cancela', () => {
    const onRename = vi.fn()
    render(<LiveTranscript segments={segments} themLabel="Cliente" recording={false} onRenameSpeaker={onRename} />)
    expect(screen.queryByRole('button', { name: 'Eu' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cliente' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Bianca' }))
    const input = screen.getByRole('textbox', { name: 'Renomear Bianca' })
    fireEvent.change(input, { target: { value: 'Bianca Sathler' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('s1', 'Bianca Sathler')

    fireEvent.click(screen.getByRole('button', { name: 'Participante 2' }))
    const input2 = screen.getByRole('textbox', {
      name: 'Renomear Participante 2',
    })
    fireEvent.change(input2, { target: { value: 'Pedro' } })
    fireEvent.keyDown(input2, { key: 'Escape' })
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Participante 2' })).toBeInTheDocument()
  })

  it('sem onRenameSpeaker nada é clicável', () => {
    render(<LiveTranscript segments={segments} themLabel="Cliente" recording={false} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('placeholder sem segmentos', () => {
    render(<LiveTranscript segments={[]} themLabel="Cliente" recording />)
    expect(screen.getByText('Aguardando áudio…')).toBeInTheDocument()
  })
})
