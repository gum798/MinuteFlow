import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Record from './Record'
import { saveSettings } from '../../core/settings'

// 세션을 목으로 대체해 stopRecording이 결정적인 id를 반환하고, 녹음 중(phase) 상태를 유지시킨다.
const stopRecordingMock = vi.fn(async () => 'meeting-1')
const recordingState = { phase: 'recording', error: null, elapsedSec: 0, interim: '', finals: [] as string[] }
vi.mock('../../core/recorder/session', () => ({
  subscribeRecording: () => () => {},
  getRecordingState: () => recordingState,
  startRecording: vi.fn(),
  stopRecording: () => stopRecordingMock(),
}))

// 파이프라인은 fire-and-forget 호출만 검증한다.
const runAutoPipelineMock = vi.fn()
vi.mock('../../core/pipeline', () => ({
  runAutoPipeline: (id: string) => runAutoPipelineMock(id),
}))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

function renderRecord() {
  return render(
    <MemoryRouter initialEntries={['/record']}>
      <Routes>
        <Route path="/record" element={<Record />} />
        <Route path="/meeting/:id" element={<div>회의록 페이지</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

test('종료 후 autoPipeline 기본값(켜짐)이면 runAutoPipeline을 호출한다', async () => {
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /종료/ }))
  await waitFor(() => expect(runAutoPipelineMock).toHaveBeenCalledWith('meeting-1'))
})

test('autoPipeline이 꺼져 있으면 runAutoPipeline을 호출하지 않는다', async () => {
  saveSettings({ autoPipeline: false })
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /종료/ }))
  await waitFor(() => expect(stopRecordingMock).toHaveBeenCalled())
  expect(runAutoPipelineMock).not.toHaveBeenCalled()
})
