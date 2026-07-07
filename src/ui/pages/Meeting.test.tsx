import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting, appendSegment, appendAudioChunk } from '../../core/store/meetings'
import MeetingPage from './Meeting'

vi.mock('../../core/audio/decode', () => ({
  decodeTo16kMono: vi.fn(async () => new Float32Array(16000)),
}))
vi.mock('../../core/stt/whisperLocal', () => ({
  detectWebGPU: vi.fn(async () => false),
  WhisperLocalEngine: class {
    async transcribe() { return [{ startSec: 0, endSec: 1, text: '재전사됨' }] }
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

test('오디오가 없으면 재전사 버튼이 없다', async () => {
  const m = await seed() // seed는 세그먼트만 추가, 오디오 없음
  renderPage(m.id)
  await waitFor(() => screen.getByText('첫 발언'))
  expect(screen.queryByRole('button', { name: /재전사/ })).not.toBeInTheDocument()
})
