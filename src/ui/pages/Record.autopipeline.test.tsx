import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Record from './Record'
import { saveSettings } from '../../core/settings'

// 세션을 목으로 대체해 stopRecording이 결정적인 id를 반환하고, 녹음 중(phase) 상태를 유지시킨다.
const stopRecordingMock = vi.fn(async () => 'meeting-1')
const getLastSessionPartsMock = vi.fn(() => ['meeting-1'])
const recordingState = { phase: 'recording', error: null, elapsedSec: 0, interim: '', finals: [] as string[] }
vi.mock('../../core/recorder/session', () => ({
  subscribeRecording: () => () => {},
  getRecordingState: () => recordingState,
  startRecording: vi.fn(),
  stopRecording: () => stopRecordingMock(),
  getLastSessionParts: () => getLastSessionPartsMock(),
}))

// 파이프라인은 enqueue를 거쳐 runFinalPipeline이 큐에 들어가는지만 검증한다(enqueue는 즉시 fn 실행).
const enqueueMock = vi.fn((fn: () => Promise<void>) => { void fn(); return Promise.resolve() })
const runFinalPipelineMock = vi.fn()
vi.mock('../../core/pipeline', () => ({
  enqueue: (fn: () => Promise<void>) => enqueueMock(fn),
  runFinalPipeline: (ids: string[]) => runFinalPipelineMock(ids),
}))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  getLastSessionPartsMock.mockReturnValue(['meeting-1'])
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

test('종료 후 autoPipeline 기본값(켜짐)이면 마지막 세션 부들로 runFinalPipeline을 큐에 넣는다', async () => {
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /종료/ }))
  await waitFor(() => expect(runFinalPipelineMock).toHaveBeenCalledWith(['meeting-1']))
  expect(enqueueMock).toHaveBeenCalled()
})

test('여러 부로 분할됐으면 전체 부 id로 runFinalPipeline을 호출한다', async () => {
  getLastSessionPartsMock.mockReturnValue(['m1', 'm2', 'm3'])
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /종료/ }))
  await waitFor(() => expect(runFinalPipelineMock).toHaveBeenCalledWith(['m1', 'm2', 'm3']))
})

test('autoPipeline이 꺼져 있으면 enqueue를 호출하지 않는다', async () => {
  saveSettings({ autoPipeline: false })
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /종료/ }))
  await waitFor(() => expect(stopRecordingMock).toHaveBeenCalled())
  expect(enqueueMock).not.toHaveBeenCalled()
})
