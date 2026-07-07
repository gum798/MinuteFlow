import type { Mock } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom'
import Record from './Record'
import { getRecordingState, __resetRecordingForTests } from '../../core/recorder/session'
import { ChunkedRecorder } from '../../core/recorder/chunkedRecorder'

// 세션이 실제 녹음까지 진입하도록 store/recorder/wakeLock을 모킹한다.
vi.mock('../../core/store/meetings', () => ({
  createMeeting: vi.fn().mockResolvedValue({ id: 'persist-1', language: 'ko-KR' }),
  appendAudioChunk: vi.fn().mockResolvedValue(undefined),
  appendSegment: vi.fn().mockResolvedValue(undefined),
  finishMeeting: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../core/recorder/mime', () => ({ pickMimeType: () => 'audio/webm' }))
vi.mock('../../core/recorder/chunkedRecorder', () => ({
  ChunkedRecorder: vi.fn(function (this: Record<string, unknown>) {
    this.start = vi.fn()
    this.stop = vi.fn().mockResolvedValue(undefined)
  }),
}))
vi.mock('../../core/recorder/wakeLock', () => ({
  createWakeLockManager: () => ({
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
  }),
}))
// getSpeechRecognitionCtor는 jsdom에서 자연히 null → 엔진 없이 진행 (실제 모듈 사용)

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/record']}>
      <nav><Link to="/upload">업로드로 이동</Link></nav>
      <Routes>
        <Route path="/record" element={<Record />} />
        <Route path="/upload" element={<div>업로드 페이지</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  __resetRecordingForTests()
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  })
})
afterEach(() => {
  __resetRecordingForTests()
  vi.unstubAllGlobals()
})

test('녹음 중 다른 페이지로 이동해도(Record unmount) 세션이 유지되고 stop이 호출되지 않는다', async () => {
  renderApp()
  await userEvent.click(screen.getByRole('button', { name: /녹음 시작/ }))
  await waitFor(() => expect(getRecordingState().phase).toBe('recording'))

  const recorder = (ChunkedRecorder as unknown as Mock).mock.instances[0] as { stop: Mock }

  // 다른 라우트로 이동 → Record 언마운트
  await userEvent.click(screen.getByRole('link', { name: '업로드로 이동' }))
  await screen.findByText('업로드 페이지')
  expect(screen.queryByRole('button', { name: /종료/ })).not.toBeInTheDocument()

  // 세션은 전역 생존 — 녹음은 계속되고 정리(stop)는 일어나지 않았다.
  expect(getRecordingState().phase).toBe('recording')
  expect(recorder.stop).not.toHaveBeenCalled()
})
