import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import AppShell from './AppShell'

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
