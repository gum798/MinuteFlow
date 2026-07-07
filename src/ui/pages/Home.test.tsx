import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HashRouter } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting } from '../../core/store/meetings'
import { UndoToastProvider } from '../UndoToast'
import Home from './Home'

beforeEach(async () => {
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear()])
})

function renderHome() {
  return render(
    <HashRouter>
      <UndoToastProvider>
        <Home />
      </UndoToastProvider>
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
  await waitFor(() => expect(screen.getByRole('link', { name: /녹음 시작/ })).toHaveAttribute('href', '#/record?autostart=1'))
})

test('헤더에서 파일 업로드 링크가 녹음 시작 링크보다 먼저 나온다', async () => {
  renderHome()
  const upload = await screen.findByRole('link', { name: /파일 업로드/ })
  const record = screen.getByRole('link', { name: /녹음 시작/ })
  // upload가 문서상 record보다 앞서면 compareDocumentPosition에 FOLLOWING 비트가 선다.
  expect(upload.compareDocumentPosition(record) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('회의 카드에 테마 클래스가 적용된다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => screen.getByText(m.title))
  expect(screen.getByText(m.title).closest('.card')).not.toBeNull()
})

test('삭제하면 confirm 없이 목록에서 사라지고 실행취소 토스트가 뜬다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => screen.getByText(m.title))
  await userEvent.click(screen.getByRole('button', { name: '삭제' }))
  await waitFor(() => expect(screen.queryByText(m.title)).not.toBeInTheDocument())
  expect(screen.getByRole('status')).toHaveTextContent('삭제')
  expect(screen.getByRole('button', { name: '실행취소' })).toBeInTheDocument()
})

test('삭제 후 실행취소를 누르면 목록에 다시 나타난다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => screen.getByText(m.title))
  await userEvent.click(screen.getByRole('button', { name: '삭제' }))
  await waitFor(() => expect(screen.queryByText(m.title)).not.toBeInTheDocument())
  await userEvent.click(screen.getByRole('button', { name: '실행취소' }))
  await waitFor(() => expect(screen.getByText(m.title)).toBeInTheDocument())
})
