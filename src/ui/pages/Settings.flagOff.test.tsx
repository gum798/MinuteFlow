import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'

// 실제 플래그(GROQ_ENABLED=false) 상태를 검증 — features는 mock하지 않는다.
beforeEach(() => localStorage.clear())

function renderPage() {
  return render(<MemoryRouter><Settings /></MemoryRouter>)
}

test('플래그 꺼짐 시 Groq API 키 입력이 보이지 않는다', () => {
  renderPage()
  expect(screen.queryByLabelText(/Groq API 키/)).toBeNull()
})

test('플래그 꺼짐 시에도 저장 버튼은 있다', () => {
  renderPage()
  expect(screen.getByRole('button', { name: /저장/ })).toBeInTheDocument()
})
