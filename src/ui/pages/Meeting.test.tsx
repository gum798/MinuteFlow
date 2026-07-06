import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting, appendSegment } from '../../core/store/meetings'
import MeetingPage from './Meeting'

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
