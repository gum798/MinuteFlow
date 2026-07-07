import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { db } from '../../core/store/db'
import { saveSettings } from '../../core/settings'
import Upload from './Upload'

// 숨겨진 Groq 경로의 회귀 방지를 위해 플래그를 켠 상태로 계속 검증한다.
vi.mock('../../core/features', () => ({ GROQ_ENABLED: true }))
vi.mock('../../core/audio/decode', () => ({
  decodeTo16kMono: vi.fn(async () => new Float32Array(16000 * 2)), // 2초
}))
vi.mock('../../core/stt/groq', async importOriginal => ({
  ...(await importOriginal<typeof import('../../core/stt/groq')>()),
  transcribeBlobWithGroq: vi.fn(async () => [{ startSec: 0, endSec: 2, text: 'Groq 전사' }]),
}))
vi.mock('../../core/stt/whisperLocal', () => ({
  detectWebGPU: vi.fn(async () => false),
  WhisperLocalEngine: class {
    async transcribe() { return [{ startSec: 0, endSec: 2, text: '로컬 전사' }] }
    dispose() {}
  },
}))

beforeEach(async () => {
  localStorage.clear()
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear()])
})

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/upload']}>
      <Routes>
        <Route path="/upload" element={<Upload />} />
        <Route path="/meeting/:id" element={<div>회의록 도착</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function pickFile() {
  const file = new File(['x'], '주간회의.m4a', { type: 'audio/mp4' })
  const input = screen.getByTestId('file-input')
  await userEvent.upload(input, file)
}

test('Groq 키가 없으면 Groq 라디오가 비활성화된다', () => {
  renderPage()
  expect(screen.getByLabelText(/Groq/)).toBeDisabled()
})

test('로컬 엔진으로 전사하면 회의록으로 이동하고 세그먼트가 저장된다', async () => {
  renderPage()
  await pickFile()
  await userEvent.click(screen.getByRole('button', { name: /전사 시작/ }))
  await waitFor(() => expect(screen.getByText('회의록 도착')).toBeInTheDocument())
  const segs = await db.transcriptSegments.toArray()
  expect(segs).toHaveLength(1)
  expect(segs[0]).toMatchObject({ text: '로컬 전사', source: 'whisper', isFinal: true })
  const meetings = await db.meetings.toArray()
  expect(meetings[0]).toMatchObject({ title: '주간회의', status: 'done', durationSec: 2 })
})

test('Groq 소파일 경로는 원본 그대로 전송한다', async () => {
  saveSettings({ groqApiKey: 'gsk_1' })
  const { transcribeBlobWithGroq } = await import('../../core/stt/groq')
  renderPage()
  await pickFile()
  await userEvent.click(screen.getByLabelText(/Groq/))
  await userEvent.click(screen.getByRole('button', { name: /전사 시작/ }))
  await waitFor(() => expect(screen.getByText('회의록 도착')).toBeInTheDocument())
  expect(vi.mocked(transcribeBlobWithGroq)).toHaveBeenCalled()
  const segs = await db.transcriptSegments.toArray()
  expect(segs[0]).toMatchObject({ text: 'Groq 전사', source: 'groq' })
})

test('파일 선택 전에는 전사 시작이 비활성', () => {
  renderPage()
  expect(screen.getByRole('button', { name: /전사 시작/ })).toBeDisabled()
})

test('Groq 키가 저장돼 있으면 마운트 시 Groq가 이미 선택돼 있다', () => {
  saveSettings({ groqApiKey: 'gsk_1' })
  renderPage()
  expect(screen.getByLabelText(/Groq/)).toBeChecked()
})
