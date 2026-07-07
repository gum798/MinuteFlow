import { render, screen, waitFor } from '@testing-library/react'
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

test('플래그 꺼짐 시 WebGPU 미지원 배지에 Groq 언급이 없다', async () => {
  renderPage() // jsdom에는 navigator.gpu 없음 → 미지원 배지
  await waitFor(() => expect(screen.getByText('WebGPU 미지원 — 경량 모델을 사용합니다')).toBeInTheDocument())
  expect(screen.queryByText(/Groq/)).toBeNull()
})
