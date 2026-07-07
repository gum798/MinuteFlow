import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Record from './Record'
import { __resetRecordingForTests } from '../../core/recorder/session'

// createMeeting을 실패시켜 getUserMedia 이후 구간의 정리 경로를 검증한다.
// 나머지 테스트는 start()가 여기까지 도달하지 않아 영향받지 않는다.
vi.mock('../../core/store/meetings', () => ({
  createMeeting: vi.fn().mockRejectedValue(new Error('db unavailable')),
  appendAudioChunk: vi.fn().mockResolvedValue(undefined),
  appendSegment: vi.fn().mockResolvedValue(undefined),
  finishMeeting: vi.fn().mockResolvedValue(undefined),
}))

function renderRecord(entry = '/record') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/record" element={<Record />} />
        <Route path="/meeting/:id" element={<div>회의록 페이지</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => __resetRecordingForTests())
afterEach(() => {
  __resetRecordingForTests()
  vi.unstubAllGlobals()
})

test('마이크 권한 거부 시 에러 메시지를 보여준다', async () => {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
  })
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /녹음 시작/ }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/마이크/))
})

test('Web Speech 미지원 브라우저 안내가 보인다', () => {
  // jsdom에는 SpeechRecognition이 없으므로 기본 상태가 미지원
  renderRecord()
  expect(screen.getByText(/실시간 자막을 지원하지 않습니다/)).toBeInTheDocument()
})

test('시작 전에는 종료 버튼이 없다', () => {
  renderRecord()
  expect(screen.queryByRole('button', { name: /종료/ })).not.toBeInTheDocument()
})

test('autostart=1이면 클릭 없이 자동으로 녹음을 시작한다', async () => {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
  })
  renderRecord('/record?autostart=1')
  // 클릭 없이 마운트 시 start() 자동 실행 → getUserMedia reject → 마이크 에러 alert
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/마이크/))
})

test('시작 도중 실패하면 마이크를 해제하고 에러를 보여준다', async () => {
  const stop = vi.fn()
  const track = { stop } as unknown as MediaStreamTrack
  const fakeStream = { getTracks: () => [track] } as unknown as MediaStream
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) },
  })
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /녹음 시작/ }))
  // createMeeting이 reject → 시작 실패 에러 노출 + 마이크 트랙 stop
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/시작하지 못했습니다/))
  expect(stop).toHaveBeenCalled()
})
