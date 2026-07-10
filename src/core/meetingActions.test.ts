import { db } from './store/db'
import { createMeeting, appendSegment, appendAudioChunk, finishMeeting, getSegments, getSummaries, getMeeting } from './store/meetings'
import { saveSettings } from './settings'
import { __resetJobsForTests } from './jobs'
import { isMeaningfulText, hasMeaningfulTranscript, retranscribeMeeting, summarizeMeeting, summarizeGroup , dropHallucinatedRepeats} from './meetingActions'

// 재전사 경로가 실제 Whisper/오디오 디코딩을 돌리지 않도록 목으로 대체한다.
vi.mock('./audio/decode', () => ({
  decodeTo16kMono: vi.fn(async () => new Float32Array(16000)),
}))
const transcribeMock = vi.fn(async () => [{ startSec: 0, endSec: 1, text: '-' }])
vi.mock('./stt/whisperLocal', () => ({
  detectWebGPU: vi.fn(async () => false),
  WhisperLocalEngine: class {
    transcribe() { return transcribeMock() }
    dispose() {}
  },
}))
vi.mock('./diarize/diarizeLocal', () => ({
  DiarizeEngine: class {
    diarize() { return [] }
    dispose() {}
  },
}))
const geminiMock = vi.fn(async (_prompt: string, _apiKey: string) => '## 요약 결과')
vi.mock('./summarize/gemini', () => ({
  summarizeWithGemini: (prompt: string, apiKey: string) => geminiMock(prompt, apiKey),
}))

beforeEach(async () => {
  localStorage.clear()
  transcribeMock.mockReset().mockResolvedValue([{ startSec: 0, endSec: 1, text: '-' }])
  geminiMock.mockClear()
  __resetJobsForTests()
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear(), db.summaries.clear()])
})

describe('isMeaningfulText', () => {
  test('공백·대시·구두점만 있으면 false', () => {
    expect(isMeaningfulText('-')).toBe(false)
    expect(isMeaningfulText('   ')).toBe(false)
    expect(isMeaningfulText('...')).toBe(false)
    expect(isMeaningfulText('— … !?')).toBe(false)
  })
  test('실제 글자가 하나라도 있으면 true', () => {
    expect(isMeaningfulText('안녕하세요')).toBe(true)
    expect(isMeaningfulText('- 네')).toBe(true)
  })
})

describe('hasMeaningfulTranscript', () => {
  test("무의미('-'·공백) 세그먼트만 있으면 false", () => {
    expect(hasMeaningfulTranscript([{ text: '-' }, { text: '  ' }, { text: '...' }])).toBe(false)
  })
  test('충분한 실문장이면 true', () => {
    expect(hasMeaningfulTranscript([{ text: '오늘 회의를 시작하겠습니다' }])).toBe(true)
  })
  test('minChars 경계 — 의미 문자 합이 minChars 이상이어야 true', () => {
    expect(hasMeaningfulTranscript([{ text: '가나다' }, { text: '라마' }], 5)).toBe(true)   // 합 5
    expect(hasMeaningfulTranscript([{ text: '가나다' }, { text: '라마' }], 6)).toBe(false)  // 합 5 < 6
    expect(hasMeaningfulTranscript([{ text: '가나' }], 3)).toBe(false)                      // 합 2 < 3
  })
})

test("재전사가 무의미 조각('-')만 내면 'empty'로 기존 세그먼트를 보존한다", async () => {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 5, text: '기존 발언 내용', source: 'webspeech', isFinal: true })
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  await finishMeeting(m.id, 30)
  transcribeMock.mockResolvedValue([{ startSec: 0, endSec: 1, text: '-' }])

  const result = await retranscribeMeeting(m.id)

  expect(result).toBe('empty')
  const segs = await getSegments(m.id)
  expect(segs.map(s => s.text)).toEqual(['기존 발언 내용'])
})

test("요약: 무의미 세그먼트만 있으면 'no-content'로 Gemini를 호출하지 않는다", async () => {
  saveSettings({ geminiApiKey: 'k' })
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 34, text: '-', source: 'whisper', isFinal: true })
  await finishMeeting(m.id, 34)

  const result = await summarizeMeeting(m.id, 'minutes')

  expect(result).toBe('no-content')
  expect(geminiMock).not.toHaveBeenCalled()
})

test('요약: 의미 있는 전사면 요약을 실행한다', async () => {
  saveSettings({ geminiApiKey: 'k' })
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 5, text: '오늘 회의를 시작하겠습니다', source: 'whisper', isFinal: true })
  await finishMeeting(m.id, 60)

  const result = await summarizeMeeting(m.id, 'minutes')

  expect(result).toBe('done')
  expect(geminiMock).toHaveBeenCalled()
})

describe('summarizeGroup', () => {
  test('여러 부를 통합해 마지막 부에 요약을 저장하고, 마지막 부 제목만 갱신한다', async () => {
    saveSettings({ geminiApiKey: 'k' })
    const m1 = await createMeeting()
    const m2 = await createMeeting()
    await appendSegment({ meetingId: m1.id, startSec: 0, endSec: 5, text: '첫 부에서 논의한 안건입니다', source: 'whisper', isFinal: true })
    await appendSegment({ meetingId: m2.id, startSec: 0, endSec: 5, text: '둘째 부에서 내린 결론입니다', source: 'whisper', isFinal: true })
    await finishMeeting(m1.id, 60)
    await finishMeeting(m2.id, 30)
    geminiMock.mockResolvedValueOnce('제목: 통합 회의록\n\n## 결정사항\n합의')

    const result = await summarizeGroup([m1.id, m2.id], 'minutes')

    expect(result).toBe('done')
    // 요약은 마지막 부(m2)에만 저장된다.
    expect((await getSummaries(m2.id))[0].markdown).toContain('결정사항')
    expect(await getSummaries(m1.id)).toHaveLength(0)
    // 제목은 마지막 부만 AI 제목으로 갱신, 첫 부는 그대로.
    expect((await getMeeting(m2.id))!.title).toContain('통합 회의록')
    expect((await getMeeting(m1.id))!.title).not.toContain('통합 회의록')
    // 통합 프롬프트가 두 부의 전사문을 모두 담았다.
    const prompt = geminiMock.mock.calls[0][0]
    expect(prompt).toContain('첫 부에서 논의한 안건입니다')
    expect(prompt).toContain('둘째 부에서 내린 결론입니다')
  })

  test('Gemini 키가 없으면 no-key로 호출하지 않는다', async () => {
    const m1 = await createMeeting()
    const result = await summarizeGroup([m1.id], 'minutes')
    expect(result).toBe('no-key')
    expect(geminiMock).not.toHaveBeenCalled()
  })

  test('전 부를 합쳐도 의미 있는 대화가 없으면 no-content', async () => {
    saveSettings({ geminiApiKey: 'k' })
    const m1 = await createMeeting()
    const m2 = await createMeeting()
    await appendSegment({ meetingId: m1.id, startSec: 0, endSec: 1, text: '-', source: 'whisper', isFinal: true })
    const result = await summarizeGroup([m1.id, m2.id], 'minutes')
    expect(result).toBe('no-content')
    expect(geminiMock).not.toHaveBeenCalled()
  })
})

test('dropHallucinatedRepeats: 짧은 문구 4회+ 반복은 환각으로 제거', () => {
  const segs = [
    { text: '안녕하세요 회의를 시작합니다' },
    { text: '지금' }, { text: '지금' }, { text: '지금' }, { text: '지금' }, { text: '지금' },
    { text: '다음 안건으로 넘어가죠' },
  ]
  const out = dropHallucinatedRepeats(segs)
  expect(out.map(s => s.text)).toEqual(['안녕하세요 회의를 시작합니다', '다음 안건으로 넘어가죠'])
})

test('dropHallucinatedRepeats: 3회 이하 반복이나 긴 문구는 보존', () => {
  const segs = [
    { text: '네' }, { text: '네' }, { text: '네' }, // 3회 — 보존
    { text: '정말 감사합니다' }, { text: '정말 감사합니다' }, { text: '정말 감사합니다' }, { text: '정말 감사합니다' }, // 긴 문구(>6자) — 보존
  ]
  expect(dropHallucinatedRepeats(segs)).toHaveLength(7)
})

test('dropHallucinatedRepeats: 공백/구두점 차이는 같은 조각으로 본다', () => {
  const segs = [{ text: '지금.' }, { text: ' 지금 ' }, { text: '지금' }, { text: '지금!' }]
  expect(dropHallucinatedRepeats(segs)).toHaveLength(0)
})
