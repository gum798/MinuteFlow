import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HashRouter } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting, updateMeetingTitle, listMeetings, markGroupFirstPart } from '../../core/store/meetings'
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

test('복구 배너에서 삭제하면 배너가 사라지고 실행취소 토스트가 뜬다', async () => {
  await createMeeting() // status: recording → 중단된 회의 배너
  renderHome()
  await waitFor(() => screen.getByText(/복구할 녹음/))
  const banner = screen.getByRole('alert')
  await userEvent.click(within(banner).getByRole('button', { name: '삭제' }))
  // 실행취소 토스트는 5초 후 자동 만료되므로, 만료 전에 먼저 확인한다(느린 병렬 실행에서의 레이스 방지).
  await waitFor(() => expect(screen.getByRole('button', { name: '실행취소' })).toBeInTheDocument())
  expect(screen.getByRole('status')).toHaveTextContent('삭제')
  expect(screen.queryByText(/복구할 녹음/)).not.toBeInTheDocument()
})

test('복구 배너에서 삭제 후 실행취소를 누르면 배너가 복귀한다', async () => {
  await createMeeting()
  renderHome()
  await waitFor(() => screen.getByText(/복구할 녹음/))
  const banner = screen.getByRole('alert')
  await userEvent.click(within(banner).getByRole('button', { name: '삭제' }))
  // 실행취소는 5초 자동 만료 전에 눌러야 하므로 배너 사라짐을 기다리지 않고 바로 누른다.
  await userEvent.click(await screen.findByRole('button', { name: '실행취소' }))
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

test('분할 그룹은 카드 1개로 합쳐 보이고 부 개수를 표시하며 클릭 시 마지막 부로 이동한다', async () => {
  window.location.hash = ''
  const p1 = await createMeeting()
  await markGroupFirstPart(p1.id, p1.id, p1.title, ' (1부)')
  await finishMeeting(p1.id, 30)
  const p2 = await createMeeting('ko-KR', { groupId: p1.id, partIndex: 2, titleSuffix: ' (2부)' })
  await finishMeeting(p2.id, 30)
  const p3 = await createMeeting('ko-KR', { groupId: p1.id, partIndex: 3, titleSuffix: ' (3부)' })
  await updateMeetingTitle(p3.id, '통합 회의 제목') // 마지막 부에 통합 AI 제목
  await finishMeeting(p3.id, 30)

  const { container } = renderHome()
  await waitFor(() => expect(screen.getByText('통합 회의 제목')).toBeInTheDocument())
  // 그룹은 대표(마지막 부) 카드 1개만 — 개별 부 제목은 노출되지 않는다
  expect(container.querySelectorAll('.card.hoverable')).toHaveLength(1)
  expect(screen.queryByText(/\(1부\)/)).not.toBeInTheDocument()
  expect(screen.getByText('3개 부')).toBeInTheDocument()

  // 클릭 시 마지막 부(p3) 회의록으로 이동한다
  const card = screen.getByText('통합 회의 제목').closest('.card')!
  await userEvent.click(card.querySelector('.muted')!)
  await waitFor(() => expect(window.location.hash).toContain(`/meeting/${p3.id}`))
  window.location.hash = ''
})

test('분할 그룹 카드 삭제는 모든 부를 목록에서 없애고, 실행취소로 그룹 전체가 복귀한다', async () => {
  const p1 = await createMeeting()
  await markGroupFirstPart(p1.id, p1.id, p1.title, ' (1부)')
  await finishMeeting(p1.id, 30)
  const p2 = await createMeeting('ko-KR', { groupId: p1.id, partIndex: 2, titleSuffix: ' (2부)' })
  await finishMeeting(p2.id, 30)
  const p3 = await createMeeting('ko-KR', { groupId: p1.id, partIndex: 3, titleSuffix: ' (3부)' })
  await updateMeetingTitle(p3.id, '통합 회의')
  await finishMeeting(p3.id, 30)

  renderHome()
  await waitFor(() => screen.getByText('통합 회의'))
  await userEvent.click(screen.getByRole('button', { name: '삭제' }))
  // 그룹 전체(3부)가 목록에서 사라진다
  await waitFor(() => expect(screen.queryByText('통합 회의')).not.toBeInTheDocument())
  expect(await listMeetings()).toEqual([])
  // 실행취소 → 그룹 전체가 다시 나타난다
  await userEvent.click(screen.getByRole('button', { name: '실행취소' }))
  await waitFor(() => expect(screen.getByText('통합 회의')).toBeInTheDocument())
  expect((await listMeetings()).map(m => m.id).sort()).toEqual([p1.id, p2.id, p3.id].sort())
})

test('마지막 부가 아직 녹음 중이면 완료된 마지막 부를 대표로 카드에 노출한다', async () => {
  window.location.hash = ''
  const p1 = await createMeeting()
  await markGroupFirstPart(p1.id, p1.id, p1.title, ' (1부)')
  await finishMeeting(p1.id, 30)
  const p2 = await createMeeting('ko-KR', { groupId: p1.id, partIndex: 2 })
  await updateMeetingTitle(p2.id, '완료된 2부')
  await finishMeeting(p2.id, 30)
  await createMeeting('ko-KR', { groupId: p1.id, partIndex: 3 }) // 3부: 아직 녹음 중(status: recording)

  renderHome()
  // 녹음 중인 3부가 아니라 완료된 마지막 부(2부)가 대표로 보인다
  await waitFor(() => expect(screen.getByText('완료된 2부')).toBeInTheDocument())
  const card = screen.getByText('완료된 2부').closest('.card')!
  await userEvent.click(card.querySelector('.muted')!)
  await waitFor(() => expect(window.location.hash).toContain(`/meeting/${p2.id}`))
  window.location.hash = ''
})

test('카드 아무 곳이나 클릭하면 회의록으로 이동한다', async () => {
  window.location.hash = ''
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => screen.getByText(m.title))
  const card = screen.getByText(m.title).closest('.card')!
  await userEvent.click(card.querySelector('.muted')!) // 날짜 영역 클릭
  await waitFor(() => expect(window.location.hash).toContain(`/meeting/${m.id}`))
  window.location.hash = ''
})

test('카드의 삭제 버튼 클릭은 이동하지 않는다', async () => {
  window.location.hash = ''
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => screen.getByText(m.title))
  await userEvent.click(screen.getByRole('button', { name: '삭제' }))
  await waitFor(() => screen.getByRole('button', { name: '실행취소' }))
  expect(window.location.hash).not.toContain('/meeting/')
  window.location.hash = ''
})
