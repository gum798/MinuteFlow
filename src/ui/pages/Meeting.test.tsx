import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting, appendSegment, appendAudioChunk } from '../../core/store/meetings'
import MeetingPage from './Meeting'

vi.mock('../../core/audio/decode', () => ({
  decodeTo16kMono: vi.fn(async () => new Float32Array(16000)),
}))
const transcribeMock = vi.fn(async () => [{ startSec: 0, endSec: 1, text: '재전사됨' }])
vi.mock('../../core/stt/whisperLocal', () => ({
  detectWebGPU: vi.fn(async () => false),
  WhisperLocalEngine: class {
    transcribe() { return transcribeMock() }
    dispose() {}
  },
}))
const diarizeMock = vi.fn(async () => [{ start: 0, end: 5, speaker: 'SPK1' }])
vi.mock('../../core/diarize/diarizeLocal', () => ({
  DiarizeEngine: class {
    diarize() { return diarizeMock() }
    dispose() {}
  },
}))

beforeEach(async () => {
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear()])
})

async function seed() {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 5, text: '첫 발언', source: 'webspeech', isFinal: true })
  await finishMeeting(m.id, 60)
  return m
}

function renderPage(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/meeting/${id}`]}>
      <Routes>
        <Route path="/meeting/:id" element={<MeetingPage />} />
        <Route path="/" element={<div>홈화면</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

test('세그먼트가 타임스탬프와 함께 보인다', async () => {
  const m = await seed()
  renderPage(m.id)
  await waitFor(() => expect(screen.getByText('첫 발언')).toBeInTheDocument())
  expect(screen.getByText(/00:00/)).toBeInTheDocument()
})

test('제목을 편집하면 저장된다', async () => {
  const m = await seed()
  renderPage(m.id)
  await waitFor(() => screen.getByDisplayValue(m.title))
  const input = screen.getByDisplayValue(m.title)
  await userEvent.clear(input)
  await userEvent.type(input, '새 제목')
  await userEvent.tab() // blur → 저장
  await waitFor(async () => {
    expect((await db.meetings.get(m.id))?.title).toBe('새 제목')
  })
})

test('없는 회의는 안내 문구', async () => {
  renderPage('no-such-id')
  await waitFor(() => expect(screen.getByText(/회의록을 찾을 수 없습니다/)).toBeInTheDocument())
})

test('세그먼트가 없으면 빈 상태 안내', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 0)
  renderPage(m.id)
  await waitFor(() => expect(screen.getByText(/전사된 내용이 없습니다/)).toBeInTheDocument())
})

test('오디오가 있으면 재전사 버튼이 보이고, 확인 후 세그먼트가 교체된다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /재전사/ }))
  await userEvent.click(screen.getByRole('button', { name: /재전사/ }))
  await waitFor(() => expect(screen.getByText('재전사됨')).toBeInTheDocument())
  expect(screen.queryByText('첫 발언')).not.toBeInTheDocument()
  vi.restoreAllMocks()
})

test('재전사 결과가 비어 있으면 기존 세그먼트를 보존하고 안내한다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
  transcribeMock.mockResolvedValueOnce([])
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /재전사/ }))
  await userEvent.click(screen.getByRole('button', { name: /재전사/ }))
  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('전사 결과가 비어 있어 기존 내용을 유지합니다.'))
  expect(screen.getByText('첫 발언')).toBeInTheDocument()
  vi.restoreAllMocks()
})

test('오디오가 없으면 재전사 버튼이 없다', async () => {
  const m = await seed() // seed는 세그먼트만 추가, 오디오 없음
  renderPage(m.id)
  await waitFor(() => screen.getByText('첫 발언'))
  expect(screen.queryByRole('button', { name: /재전사/ })).not.toBeInTheDocument()
})

test('화자 구분을 실행하면 배지가 보이고 세그먼트에 speaker가 저장된다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /화자 구분/ }))
  await userEvent.click(screen.getByRole('button', { name: /화자 구분/ }))
  await waitFor(() => expect(screen.getByText('SPK1')).toBeInTheDocument())
  const segs = await db.transcriptSegments.where('meetingId').equals(m.id).toArray()
  expect(segs.some(s => s.speaker === 'SPK1')).toBe(true)
})

test('배지를 클릭하고 이름을 입력하면 표시 이름이 바뀐다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  vi.spyOn(window, 'prompt').mockReturnValue('김팀장')
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /화자 구분/ }))
  await userEvent.click(screen.getByRole('button', { name: /화자 구분/ }))
  await waitFor(() => screen.getByText('SPK1'))
  await userEvent.click(screen.getByText('SPK1'))
  await waitFor(() => expect(screen.getByText('김팀장')).toBeInTheDocument())
  vi.restoreAllMocks()
})

test('오디오가 없으면 화자 구분 버튼이 없다', async () => {
  const m = await seed() // 오디오 없음
  renderPage(m.id)
  await waitFor(() => screen.getByText('첫 발언'))
  expect(screen.queryByRole('button', { name: /화자 구분/ })).not.toBeInTheDocument()
})

test('삭제를 확인하면 회의록이 지워지고 홈으로 이동한다', async () => {
  const m = await seed()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: '삭제' }))
  await userEvent.click(screen.getByRole('button', { name: '삭제' }))
  await waitFor(() => expect(screen.getByText('홈화면')).toBeInTheDocument())
  expect(await db.meetings.get(m.id)).toBeUndefined()
  vi.restoreAllMocks()
})

test('삭제를 취소하면 회의록이 남는다', async () => {
  const m = await seed()
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: '삭제' }))
  await userEvent.click(screen.getByRole('button', { name: '삭제' }))
  expect(await db.meetings.get(m.id)).toBeDefined()
  vi.restoreAllMocks()
})
