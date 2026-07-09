import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting, appendSegment, appendAudioChunk, listMeetings, saveSummary } from '../../core/store/meetings'
import { saveSettings } from '../../core/settings'
import AppShell from '../AppShell'
import Home from './Home'
import MeetingPage from './Meeting'
import { __resetJobsForTests } from '../../core/jobs'

vi.mock('../../core/audio/decode', () => ({
  decodeTo16kMono: vi.fn(async () => new Float32Array(16000)),
}))
const transcribeMock = vi.fn(async () => [{ startSec: 0, endSec: 1, text: '재전사됨' }])
vi.mock('../../core/stt/whisperLocal', () => ({
  detectWebGPU: vi.fn(async () => false),
  WhisperLocalEngine: class {
    transcribe() { return transcribeMock() }
    dispose() {}
  },
}))
const diarizeMock = vi.fn(async () => [{ start: 0, end: 5, speaker: 'SPK1' }])
vi.mock('../../core/diarize/diarizeLocal', () => ({
  DiarizeEngine: class {
    diarize() { return diarizeMock() }
    dispose() {}
  },
}))
const summarizeMock = vi.fn(async (_prompt: string, _apiKey: string) => '## 요약 결과')
vi.mock('../../core/summarize/gemini', () => ({
  summarizeWithGemini: (prompt: string, apiKey: string) => summarizeMock(prompt, apiKey),
}))

beforeEach(async () => {
  localStorage.clear()
  summarizeMock.mockClear()
  __resetJobsForTests() // 전역 작업 스토어를 테스트 간 초기화
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear(), db.summaries.clear()])
})

async function seed() {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 5, text: '오늘 회의를 시작하겠습니다', source: 'webspeech', isFinal: true })
  await finishMeeting(m.id, 60)
  return m
}

function renderPage(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/meeting/${id}`]}>
      <Routes>
        <Route path="/meeting/:id" element={<MeetingPage />} />
        <Route path="/" element={<div>홈화면</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// 삭제/실행취소는 라우트 전환에도 살아남는 토스트가 필요하므로 AppShell(Provider) 레이아웃 + 실제 Home으로 렌더한다.
function renderApp(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/meeting/${id}`]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/meeting/:id" element={<MeetingPage />} />
          <Route path="/" element={<Home />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

test('세그먼트가 타임스탬프와 함께 보인다', async () => {
  const m = await seed()
  renderPage(m.id)
  await waitFor(() => expect(screen.getByText('오늘 회의를 시작하겠습니다')).toBeInTheDocument())
  expect(screen.getByText(/00:00/)).toBeInTheDocument()
})

test('제목을 편집하면 저장된다', async () => {
  const m = await seed()
  renderPage(m.id)
  await waitFor(() => screen.getByDisplayValue(m.title))
  const input = screen.getByDisplayValue(m.title)
  await userEvent.clear(input)
  await userEvent.type(input, '새 제목')
  await userEvent.tab() // blur → 저장
  await waitFor(async () => {
    expect((await db.meetings.get(m.id))?.title).toBe('새 제목')
  })
})

test('없는 회의는 안내 문구', async () => {
  renderPage('no-such-id')
  await waitFor(() => expect(screen.getByText(/회의록을 찾을 수 없습니다/)).toBeInTheDocument())
})

test('세그먼트가 없으면 빈 상태 안내', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 0)
  renderPage(m.id)
  await waitFor(() => expect(screen.getByText(/전사된 내용이 없습니다/)).toBeInTheDocument())
})

test('오디오가 있으면 재전사 버튼이 보이고, 확인 후 세그먼트가 교체된다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /재전사/ }))
  await userEvent.click(screen.getByRole('button', { name: /재전사/ }))
  await waitFor(() => expect(screen.getByText('재전사됨')).toBeInTheDocument())
  expect(screen.queryByText('오늘 회의를 시작하겠습니다')).not.toBeInTheDocument()
  vi.restoreAllMocks()
})

test('재전사 결과가 비어 있으면 기존 세그먼트를 보존하고 안내한다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
  transcribeMock.mockResolvedValueOnce([])
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /재전사/ }))
  await userEvent.click(screen.getByRole('button', { name: /재전사/ }))
  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('전사 결과가 비어 있어 기존 내용을 유지합니다.'))
  expect(screen.getByText('오늘 회의를 시작하겠습니다')).toBeInTheDocument()
  vi.restoreAllMocks()
})

test('오디오가 없으면 재전사 버튼이 없다', async () => {
  const m = await seed() // seed는 세그먼트만 추가, 오디오 없음
  renderPage(m.id)
  await waitFor(() => screen.getByText('오늘 회의를 시작하겠습니다'))
  expect(screen.queryByRole('button', { name: /재전사/ })).not.toBeInTheDocument()
})

test('화자 구분을 실행하면 배지가 보이고 세그먼트에 speaker가 저장된다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /화자 구분/ }))
  await userEvent.click(screen.getByRole('button', { name: /화자 구분/ }))
  await waitFor(() => expect(screen.getByText('SPK1')).toBeInTheDocument())
  const segs = await db.transcriptSegments.where('meetingId').equals(m.id).toArray()
  expect(segs.some(s => s.speaker === 'SPK1')).toBe(true)
})

test('배지를 클릭하고 이름을 입력하면 표시 이름이 바뀐다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  vi.spyOn(window, 'prompt').mockReturnValue('김팀장')
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /화자 구분/ }))
  await userEvent.click(screen.getByRole('button', { name: /화자 구분/ }))
  await waitFor(() => screen.getByText('SPK1'))
  await userEvent.click(screen.getByText('SPK1'))
  await waitFor(() => expect(screen.getByText('김팀장')).toBeInTheDocument())
  vi.restoreAllMocks()
})

test('오디오가 없으면 화자 구분 버튼이 없다', async () => {
  const m = await seed() // 오디오 없음
  renderPage(m.id)
  await waitFor(() => screen.getByText('오늘 회의를 시작하겠습니다'))
  expect(screen.queryByRole('button', { name: /화자 구분/ })).not.toBeInTheDocument()
})

test('삭제하면 confirm 없이 홈으로 이동하고 실행취소 토스트가 뜨며 목록에서 제외된다', async () => {
  const m = await seed()
  renderApp(m.id)
  await waitFor(() => screen.getByRole('button', { name: '삭제' }))
  await userEvent.click(screen.getByRole('button', { name: '삭제' }))
  // 홈 이동 + 실행취소 토스트 노출
  await waitFor(() => expect(screen.getByRole('button', { name: '실행취소' })).toBeInTheDocument())
  // soft-delete: listMeetings에서 제외되지만 DB에는 남아있다
  expect((await listMeetings()).map(x => x.id)).not.toContain(m.id)
  expect(await db.meetings.get(m.id)).toBeDefined()
})

test('삭제 후 실행취소를 누르면 홈 목록에 복귀한다', async () => {
  const m = await seed()
  renderApp(m.id)
  await waitFor(() => screen.getByRole('button', { name: '삭제' }))
  await userEvent.click(screen.getByRole('button', { name: '삭제' }))
  await waitFor(() => screen.getByRole('button', { name: '실행취소' }))
  await userEvent.click(screen.getByRole('button', { name: '실행취소' }))
  await waitFor(() => expect(screen.getByText(m.title)).toBeInTheDocument())
  expect((await listMeetings()).map(x => x.id)).toContain(m.id)
})

test('키가 없으면 [AI 프롬프트 복사]가 보이고, 클릭 시 프롬프트를 복사하고 토스트를 띄운다', async () => {
  const m = await seed()
  const writeText = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: 'AI 프롬프트 복사' }))
  expect(screen.queryByRole('button', { name: 'AI 요약' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'AI 프롬프트 복사' }))
  await waitFor(() => expect(writeText).toHaveBeenCalled())
  expect(writeText.mock.calls[0][0]).toContain('오늘 회의를 시작하겠습니다')
  expect(screen.getByText(/복사했어요! AI 채팅에 붙여넣어 주세요\./)).toBeInTheDocument()
})

test('키가 있으면 [AI 요약] 클릭 시 요약 카드가 뜨고 DB에 저장된다', async () => {
  const m = await seed()
  saveSettings({ geminiApiKey: 'k' })
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: 'AI 요약' }))
  await userEvent.click(screen.getByRole('button', { name: 'AI 요약' }))
  await waitFor(() => expect(screen.getByText(/요약 결과/)).toBeInTheDocument())
  expect(summarizeMock).toHaveBeenCalled()
  expect(await db.summaries.where('meetingId').equals(m.id).count()).toBe(1)
})

test('기본 제목이면 AI 제안 제목으로 갱신되고 저장 요약엔 제목 줄이 없다', async () => {
  const m = await seed() // createMeeting → 기본 제목 '회의 …'
  saveSettings({ geminiApiKey: 'k' })
  summarizeMock.mockResolvedValueOnce('제목: 주간 제품 회의\n\n## 요약\n내용')
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: 'AI 요약' }))
  await userEvent.click(screen.getByRole('button', { name: 'AI 요약' }))
  // 제목 input 값이 AI 제안으로 바뀐다
  // 제목 뒤에 회의 시각이 자동으로 붙는다: '주간 제품 회의 (YYYY-MM-DD HH:mm)'
  await waitFor(() => expect(screen.getByDisplayValue(/^주간 제품 회의 \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/)).toBeInTheDocument())
  expect((await db.meetings.get(m.id))?.title).toMatch(/^주간 제품 회의 \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/)
  // 저장된 요약 본문엔 '제목:' 줄이 없다
  const sums = await db.summaries.where('meetingId').equals(m.id).toArray()
  expect(sums[0].markdown).not.toContain('제목:')
  expect(sums[0].markdown).toContain('## 요약')
})

test('저장된 요약이 마운트 시 로드되어 보인다', async () => {
  const m = await seed()
  await saveSummary(m.id, 'minutes', '## 저장된 요약\n- 항목', 'gemini-3.5-flash')
  renderPage(m.id)
  await waitFor(() => expect(screen.getByText(/저장된 요약/)).toBeInTheDocument())
  expect(screen.getByText('회의록', { selector: '.badge' })).toBeInTheDocument() // 템플릿 라벨 배지
})

test('화자 구분 진행 중 페이지를 떠났다 돌아와도 진행 문구가 유지되고 완료 후 배지가 갱신된다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  // 화자 구분을 지연 promise로 붙잡아 진행 중 상태를 유지시킨다.
  let release!: (regions: { start: number; end: number; speaker: string }[]) => void
  diarizeMock.mockImplementationOnce(() => new Promise(r => { release = r }))

  const first = renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /화자 구분/ }))
  await userEvent.click(screen.getByRole('button', { name: /화자 구분/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: /화자 구분 중/ })).toBeInTheDocument())

  // 다른 메뉴로 이동(언마운트) 후 회의로 복귀(재마운트)
  first.unmount()
  renderPage(m.id)
  // 전역 작업 스토어 덕분에 진행 문구가 여전히 보인다
  await waitFor(() => expect(screen.getByRole('button', { name: /화자 구분 중/ })).toBeInTheDocument())

  // 작업 완료 → job-done 리스너가 세그먼트를 재로드해 화자 배지가 뜬다
  release([{ start: 0, end: 5, speaker: 'SPK1' }])
  await waitFor(() => expect(screen.getByText('SPK1')).toBeInTheDocument())
})
