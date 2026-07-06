import { render, screen, waitFor } from '@testing-library/react'
import { HashRouter } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting } from '../../core/store/meetings'
import Home from './Home'

beforeEach(async () => {
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear()])
})

function renderHome() {
  return render(
    <HashRouter>
      <Home />
    </HashRouter>,
  )
}

test('완료된 회의가 목록에 보인다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => expect(screen.getByText(m.title)).toBeInTheDocument())
  expect(screen.getByText(/01:00/)).toBeInTheDocument()
})

test('회의가 없으면 안내 문구', async () => {
  renderHome()
  await waitFor(() => expect(screen.getByText(/아직 회의록이 없습니다/)).toBeInTheDocument())
})

test('중단된 회의가 있으면 복구 배너가 보인다', async () => {
  await createMeeting() // status: recording
  renderHome()
  await waitFor(() => expect(screen.getByText(/복구할 녹음/)).toBeInTheDocument())
})

test('녹음 시작/업로드 링크가 있다', async () => {
  renderHome()
  await waitFor(() => expect(screen.getByRole('link', { name: /녹음 시작/ })).toHaveAttribute('href', '#/record'))
})
