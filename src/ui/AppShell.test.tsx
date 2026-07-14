import type { Mock } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter, HashRouter, Routes, Route } from 'react-router-dom'
import AppShell from './AppShell'
import { getRecordingState } from '../core/recorder/session'

vi.mock('../core/recorder/session', () => ({
  subscribeRecording: () => () => {},
  getRecordingState: vi.fn(),
}))
const { mockJobsRef } = vi.hoisted(() => ({ mockJobsRef: { current: [] as Array<{ meetingId: string; kind: string; status: string }> } }))
vi.mock('../core/jobs', () => ({ subscribeJobs: () => () => {}, getJobs: () => mockJobsRef.current }))
vi.mock('../core/reload', () => ({ reloadPage: vi.fn() }))
import { reloadPage } from '../core/reload'

const IDLE = { phase: 'idle', meetingId: null, elapsedSec: 0, interim: '', finals: [], error: null }
beforeEach(() => { (getRecordingState as Mock).mockReturnValue(IDLE); (reloadPage as Mock).mockClear(); mockJobsRef.current = [] })
afterEach(() => { Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true }) })

// navigator.serviceWorker를 목으로 두고, controllerchange를 수동으로 발화할 수 있게 한다(hadController=제어 SW 존재).
function mockServiceWorker(hasController: boolean) {
  const listeners: Record<string, Array<() => void>> = {}
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      controller: hasController ? {} : null,
      addEventListener: (t: string, cb: () => void) => { (listeners[t] ??= []).push(cb) },
      removeEventListener: (t: string, cb: () => void) => { listeners[t] = (listeners[t] ?? []).filter(x => x !== cb) },
    },
    configurable: true,
  })
  return { fire: (t: string) => (listeners[t] ?? []).forEach(cb => cb()) }
}

function renderShell(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>홈콘텐츠</div>} />
          <Route path="/record" element={<div>녹음콘텐츠</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

test('사이드바 nav 4개와 로고가 보인다', () => {
  renderShell()
  expect(screen.getByText('MinuteFlow')).toBeInTheDocument()
  for (const name of ['홈', '녹음', '업로드', '설정']) {
    expect(screen.getByRole('link', { name })).toBeInTheDocument()
  }
})

test('Outlet에 자식 라우트가 렌더된다', () => {
  renderShell('/record')
  expect(screen.getByText('녹음콘텐츠')).toBeInTheDocument()
})

test('현재 경로의 nav에 active 클래스', () => {
  renderShell('/record')
  expect(screen.getByRole('link', { name: '녹음' })).toHaveClass('active')
  expect(screen.getByRole('link', { name: '홈' })).not.toHaveClass('active')
})

test('idle이면 녹음 중 칩이 없다', () => {
  renderShell()
  expect(screen.queryByText(/녹음 중/)).not.toBeInTheDocument()
})

test('녹음 중이면 상단에 "녹음 중 · MM:SS" 아일랜드가 뜨고 /record로 링크된다', () => {
  ;(getRecordingState as Mock).mockReturnValue({ ...IDLE, phase: 'recording', meetingId: 'm', elapsedSec: 65 })
  render(
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>홈콘텐츠</div>} />
        </Route>
      </Routes>
    </HashRouter>,
  )
  const island = screen.getByRole('link', { name: /녹음 중/ })
  expect(island).toHaveClass('island')
  expect(island).toHaveTextContent('녹음 중 · 01:05')
  expect(island).toHaveAttribute('href', '#/record')
})

test('idle에서 새 버전이 준비되면(controllerchange) 자동으로 새로고침한다', () => {
  const sw = mockServiceWorker(true) // 이미 제어 SW 있음 → 이후 교체는 새 버전
  renderShell()
  act(() => sw.fire('controllerchange'))
  expect(reloadPage).toHaveBeenCalled()
})

test('녹음 중에는 새 버전이 준비돼도 새로고침하지 않고 칩만 띄운다', () => {
  ;(getRecordingState as Mock).mockReturnValue({ ...IDLE, phase: 'recording', meetingId: 'm', elapsedSec: 5 })
  const sw = mockServiceWorker(true)
  renderShell()
  act(() => sw.fire('controllerchange'))
  expect(reloadPage).not.toHaveBeenCalled() // 녹음 유실 방지 — 자동 새로고침 금지
  expect(screen.getByText(/끝나면 자동 적용/)).toBeInTheDocument()
})

test('처리 작업이 도는 중이면 "정리 중" 표시가 뜨고, 새 버전이 준비돼도 새로고침하지 않는다', () => {
  mockJobsRef.current = [{ meetingId: 'm', kind: 'retranscribe', status: '재전사 중… (1/2)' }]
  const sw = mockServiceWorker(true)
  renderShell()
  expect(screen.getByText(/정리 중 · 재전사 중/)).toBeInTheDocument() // 어느 화면에서든 진행 표시
  act(() => sw.fire('controllerchange'))
  expect(reloadPage).not.toHaveBeenCalled() // 처리 중 작업이 죽지 않게 자동 새로고침 보류
  expect(screen.getByText(/끝나면 자동 적용/)).toBeInTheDocument()
})

test('하단 탭바에 이모지 글리프 4개가 렌더된다', () => {
  renderShell()
  for (const glyph of ['🏠', '🎙️', '📁', '⚙️']) {
    expect(screen.getByText(glyph)).toBeInTheDocument()
  }
})
