import { render, screen, waitFor } from '@testing-library/react'
import { HashRouter } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting } from '../../core/store/meetings'
import { UndoToastProvider } from '../UndoToast'
import Home from './Home'

// 저장 공간 실측(getStorageBreakdown)은 모든 오디오 청크를 읽어 GB급 회의에선 수십 초 걸릴 수 있다.
// 홈 목록이 이 작업에 인질 잡히지 않는지 검증하기 위해, 테스트에서 완료 시점을 직접 제어한다.
let breakdownImpl: () => Promise<null> = () => Promise.resolve(null)
vi.mock('../../core/store/storage', () => ({
  ensurePersistentStorage: vi.fn(async () => false),
  getStorageBreakdown: () => breakdownImpl(),
}))

beforeEach(async () => {
  breakdownImpl = () => Promise.resolve(null)
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

test('목록 로드가 끝나기 전엔 "아직 회의록이 없습니다"를 보여주지 않는다', async () => {
  renderHome()
  // 로드 완료 전 — 빈 상태 문구가 아니라 로딩 표시여야 한다(데이터가 사라진 것처럼 보이면 안 됨).
  expect(screen.queryByText(/아직 회의록이 없습니다/)).not.toBeInTheDocument()
  expect(screen.getByText(/불러오는 중/)).toBeInTheDocument()
  // 로드가 끝나고 정말 비어 있을 때에만 빈 상태 문구가 나온다.
  await waitFor(() => expect(screen.getByText(/아직 회의록이 없습니다/)).toBeInTheDocument())
  expect(screen.queryByText(/불러오는 중/)).not.toBeInTheDocument()
})

test('저장 공간 계산이 아무리 오래 걸려도 목록은 먼저 보인다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  breakdownImpl = () => new Promise<never>(() => {}) // 영원히 안 끝나는 실측
  renderHome()
  // 실측이 끝나지 않아도 목록은 렌더된다.
  await waitFor(() => expect(screen.getByText(m.title)).toBeInTheDocument())
  // 실측 결과가 없으니 저장 공간 바는 아직 없다 — 목록과 독립적으로 나중에 채워진다.
  expect(screen.queryByText(/저장 공간/)).not.toBeInTheDocument()
})
