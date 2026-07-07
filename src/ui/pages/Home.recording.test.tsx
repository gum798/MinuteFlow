import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Mock } from 'vitest'
import { getRecordingState } from '../../core/recorder/session'
import { UndoToastProvider } from '../UndoToast'
import Home from './Home'

vi.mock('../../core/recorder/session', () => ({
  subscribeRecording: vi.fn(() => () => {}),
  getRecordingState: vi.fn(),
}))

const IDLE = { phase: 'idle', meetingId: null, elapsedSec: 0, interim: '', finals: [], error: null }

function renderHome() {
  return render(
    <MemoryRouter>
      <UndoToastProvider>
        <Home />
      </UndoToastProvider>
    </MemoryRouter>,
  )
}

test('녹음 중이면 홈 헤더 버튼이 녹음 중 상태로 바뀐다', async () => {
  ;(getRecordingState as Mock).mockReturnValue({ ...IDLE, phase: 'recording', meetingId: 'm', elapsedSec: 57 })
  renderHome()
  await waitFor(() => expect(screen.getByRole('link', { name: /녹음 중 · 00:57/ })).toBeInTheDocument())
  expect(screen.getByRole('link', { name: /녹음 중/ })).toHaveAttribute('href', '/record')
  expect(screen.queryByRole('link', { name: /녹음 시작/ })).toBeNull()
})

test('idle이면 기존 녹음 시작 버튼', async () => {
  ;(getRecordingState as Mock).mockReturnValue(IDLE)
  renderHome()
  await waitFor(() => expect(screen.getByRole('link', { name: /녹음 시작/ })).toBeInTheDocument())
})
