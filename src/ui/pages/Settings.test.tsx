import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { loadSettings } from '../../core/settings'
import Settings from './Settings'

// 숨겨진 Groq 키 UI의 회귀 방지를 위해 플래그를 켠 상태로 계속 검증한다.
vi.mock('../../core/features', () => ({ GROQ_ENABLED: true }))

vi.mock('../../core/store/storage', () => ({
  getStorageBreakdown: vi.fn(async () => ({
    totalUsage: 1_400_000_000, quota: 5_000_000_000, meetingBytes: 30_000_000, cacheBytes: 1_370_000_000,
  })),
  clearModelCaches: vi.fn(async () => 3),
}))
import { getStorageBreakdown, clearModelCaches } from '../../core/store/storage'

beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })

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

test('저장 공간 카드가 항목별 사용량을 보여준다', async () => {
  renderPage()
  await waitFor(() => expect(getStorageBreakdown).toHaveBeenCalled())
  expect(screen.getByText(/저장 공간/)).toBeInTheDocument()
  // 회의 데이터 30MB · AI 모델 캐시 1.4GB (1GB 이상은 GB 1자리)
  expect(screen.getByText(/회의 데이터 30MB · AI 모델 캐시 1\.4GB/)).toBeInTheDocument()
})

test('자동 처리 기본값은 체크됨이고, 해제 후 저장하면 autoPipeline이 false로 저장된다', async () => {
  renderPage()
  const checkbox = screen.getByLabelText(/자동으로 재전사·화자 구분·AI 요약/)
  expect(checkbox).toBeChecked() // 기본값 true
  await userEvent.click(checkbox)
  await userEvent.click(screen.getByRole('button', { name: /저장/ }))
  await waitFor(() => expect(loadSettings().autoPipeline).toBe(false))
})

test('AI 모델 캐시 비우기를 누르면 캐시를 지우고 다시 로드한다', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderPage()
  await waitFor(() => expect(getStorageBreakdown).toHaveBeenCalledTimes(1))
  await userEvent.click(screen.getByRole('button', { name: /AI 모델 캐시 비우기/ }))
  await waitFor(() => expect(clearModelCaches).toHaveBeenCalled())
  expect(getStorageBreakdown).toHaveBeenCalledTimes(2)
  expect(await screen.findByText(/캐시를 비웠어요/)).toBeInTheDocument()
})
