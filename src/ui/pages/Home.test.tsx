import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HashRouter } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting, updateMeetingTitle, listMeetings } from '../../core/store/meetings'
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

test('연속 삭제: A 삭제 직후 B 삭제해도 B의 실행취소는 유효하다 (A만 확정 삭제)', async () => {
  const a = await createMeeting(); await finishMeeting(a.id, 60); await updateMeetingTitle(a.id, '회의 A')
  const b = await createMeeting(); await finishMeeting(b.id, 60); await updateMeetingTitle(b.id, '회의 B')
  renderHome()
  await waitFor(() => screen.getByText('회의 A'))

  // A 삭제
  const cardA = screen.getByText('회의 A').closest('.card') as HTMLElement
  await userEvent.click(within(cardA).getByRole('button', { name: '삭제' }))
  await waitFor(() => expect(screen.queryByText('회의 A')).not.toBeInTheDocument())

  // 5초 내 B 삭제 → B 토스트로 교체되며 A의 onExpire(purgeMeeting(A))가 확정된다
  const cardB = screen.getByText('회의 B').closest('.card') as HTMLElement
  await userEvent.click(within(cardB).getByRole('button', { name: '삭제' }))
  await waitFor(() => expect(screen.queryByText('회의 B')).not.toBeInTheDocument())

  // B의 실행취소 — 버그가 있었다면 B도 함께 하드 삭제되어 no-op이 됐을 것
  await userEvent.click(screen.getByRole('button', { name: '실행취소' }))
  await waitFor(() => expect(screen.getByText('회의 B')).toBeInTheDocument())
  expect((await listMeetings()).map(x => x.id)).toEqual([b.id])

  // A는 확정 하드 삭제되어 DB에서도 사라진다
  await waitFor(async () => expect(await db.meetings.get(a.id)).toBeUndefined())
})
