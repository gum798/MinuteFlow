import type { Mock } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, HashRouter, Routes, Route } from 'react-router-dom'
import AppShell from './AppShell'
import { getRecordingState } from '../core/recorder/session'

vi.mock('../core/recorder/session', () => ({
  subscribeRecording: () => () => {},
  getRecordingState: vi.fn(),
}))

const IDLE = { phase: 'idle', meetingId: null, elapsedSec: 0, interim: '', finals: [], error: null }
beforeEach(() => (getRecordingState as Mock).mockReturnValue(IDLE))

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

test('하단 탭바에 이모지 글리프 4개가 렌더된다', () => {
  renderShell()
  for (const glyph of ['🏠', '🎙️', '📁', '⚙️']) {
    expect(screen.getByText(glyph)).toBeInTheDocument()
  }
})
