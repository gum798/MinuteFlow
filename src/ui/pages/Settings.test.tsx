import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { loadSettings } from '../../core/settings'
import Settings from './Settings'

// 숨겨진 Groq 키 UI의 회귀 방지를 위해 플래그를 켠 상태로 계속 검증한다.
vi.mock('../../core/features', () => ({ GROQ_ENABLED: true }))

beforeEach(() => localStorage.clear())

function renderPage() {
  return render(<MemoryRouter><Settings /></MemoryRouter>)
}

test('Groq 키를 저장하면 설정에 반영되고 토스트가 뜬다', async () => {
  renderPage()
  await userEvent.type(screen.getByLabelText(/Groq API 키/), 'gsk_abc')
  await userEvent.click(screen.getByRole('button', { name: /저장/ }))
  await waitFor(() => expect(loadSettings().groqApiKey).toBe('gsk_abc'))
  expect(screen.getByText(/저장되었습니다/)).toBeInTheDocument()
})

test('Gemini 키를 저장하면 설정에 반영된다', async () => {
  renderPage()
  await userEvent.type(screen.getByLabelText(/Gemini API 키/), 'AIza_x')
  await userEvent.click(screen.getByRole('button', { name: /저장/ }))
  await waitFor(() => expect(loadSettings().geminiApiKey).toBe('AIza_x'))
})

test('키는 브라우저에만 저장된다는 고지가 있다', () => {
  renderPage()
  expect(screen.getByText(/이 브라우저에만 저장/)).toBeInTheDocument()
})

test('모델 선택이 저장된다', async () => {
  renderPage()
  await userEvent.click(screen.getByLabelText(/whisper-base/))
  await userEvent.click(screen.getByRole('button', { name: /저장/ }))
  await waitFor(() => expect(loadSettings().whisperModel).toBe('onnx-community/whisper-base'))
})

test('WebGPU 미지원이면 안내 배지', async () => {
  renderPage() // jsdom에는 navigator.gpu 없음
  await waitFor(() => expect(screen.getByText(/WebGPU 미지원/)).toBeInTheDocument())
})
