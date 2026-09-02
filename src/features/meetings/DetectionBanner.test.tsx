import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingLiveState } from '../../../shared/types/ipc'
import { DetectionBanner, pendingDetection } from './DetectionBanner'

const meeting: Meeting = {
  id: 'm1',
  title: 'Reunião',
  status: 'recording',
  startedAt: Date.now(),
  endedAt: null,
  rawNotes: '',
  summaryMd: null,
  themLabel: 'Participante',
  error: null,
  sttModel: null,
  summaryModel: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  segmentCount: 0,
  durationMs: 0,
  speakers: [],
  lastError: null,
  respawns: 0,
  micLevelDbfs: null,
  diarization: null,
}

const detected: MeetingLiveState = {
  active: null,
  elapsedMs: 0,
  levels: { me: 0, them: 0 },
  sttOk: true,
  lastError: null,
  captureMode: 'pipewire',
  detection: { app: 'Google Meet', binary: 'chrome', pid: 42, streamId: 7, since: Date.now(), ignored: false },
  linkedStreamId: null,
  micWarning: null,
  diarization: 'off',
}

describe('DetectionBanner', () => {
  it('mostra o app detectado com Gravar e Ignorar', () => {
    render(<DetectionBanner live={detected} onDecide={vi.fn()} />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Google Meet está usando o microfone — parece uma reunião.')
    expect(screen.getByRole('button', { name: 'Gravar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ignorar' })).toBeInTheDocument()
  })

  it('botões decidem record/ignore', () => {
    const onDecide = vi.fn()
    render(<DetectionBanner live={detected} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Gravar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ignorar' }))
    expect(onDecide.mock.calls).toEqual([['record'], ['ignore']])
  })

  it('some quando a detecção foi ignorada', () => {
    const live = { ...detected, detection: { ...detected.detection!, ignored: true } }
    const { container } = render(<DetectionBanner live={live} onDecide={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('some quando já há gravação ativa', () => {
    const { container } = render(<DetectionBanner live={{ ...detected, active: meeting }} onDecide={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('some sem detecção ou sem estado', () => {
    expect(pendingDetection(null)).toBeNull()
    expect(pendingDetection({ ...detected, detection: null })).toBeNull()
    expect(pendingDetection(detected)).toBe(detected.detection)
  })

  it('modo compacto mantém os dois botões', () => {
    render(<DetectionBanner live={detected} onDecide={vi.fn()} compact />)
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})
