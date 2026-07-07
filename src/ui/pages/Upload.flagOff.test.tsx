import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { db } from '../../core/store/db'
import Upload from './Upload'

// 실제 플래그(GROQ_ENABLED=false) 상태를 검증 — features는 mock하지 않는다.
vi.mock('../../core/audio/decode', () => ({
  decodeTo16kMono: vi.fn(async () => new Float32Array(16000 * 2)),
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

test('플래그 꺼짐 시 고급 설정(엔진 선택)이 보이지 않는다', () => {
  renderPage()
  expect(screen.queryByText('고급 설정')).toBeNull()
})

test('플래그 꺼짐 시 프라이버시 힌트는 로컬 문구만 나온다', () => {
  renderPage()
  expect(screen.getByText(/이 기기 안에서 처리돼요/)).toBeInTheDocument()
})
