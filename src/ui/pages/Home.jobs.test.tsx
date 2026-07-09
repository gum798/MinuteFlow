import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting } from '../../core/store/meetings'
import { UndoToastProvider } from '../UndoToast'
import Home from './Home'
import type { MeetingJob } from '../../core/jobs'

const jobsState: { list: MeetingJob[] } = { list: [] }
vi.mock('../../core/jobs', async importOriginal => ({
  ...(await importOriginal<typeof import('../../core/jobs')>()),
  subscribeJobs: vi.fn(() => () => {}),
  getJobs: vi.fn(() => jobsState.list),
}))

beforeEach(async () => {
  jobsState.list = []
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear()])
})

function renderHome() {
  return render(
    <MemoryRouter>
      <UndoToastProvider>
        <Home />
      </UndoToastProvider>
    </MemoryRouter>,
  )
}

test('작업 진행 중인 회의 카드는 확정 대신 진행 배지를 보여준다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  jobsState.list = [{ meetingId: m.id, kind: 'diarize', status: '화자 특징 추출 중…' }]
  renderHome()
  await waitFor(() => expect(screen.getByText('화자 구분 중')).toBeInTheDocument())
  expect(screen.queryByText('확정')).toBeNull()
})

test('작업이 없으면 확정 배지', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => expect(screen.getByText('확정')).toBeInTheDocument())
})
