import { db } from './store/db'
import { createMeeting, appendSegment, appendAudioChunk, finishMeeting, getSegments, getSummaries, getMeeting, saveSummary } from './store/meetings'
import { saveSettings } from './settings'
import { __resetJobsForTests } from './jobs'
import { isMeaningfulText, hasMeaningfulTranscript, retranscribeMeeting, retranscribeGroup, diarizeMeeting, diarizeGroup, summarizeMeeting, summarizeGroup , dropHallucinatedRepeats, collapseRepeatedPhrases, collapseRepeatedTokenRuns, cleanTranscriptSegments, stripHallucinationPhrases, isTooLongToProcess, MAX_PROCESS_SEC } from './meetingActions'

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
let extractCalls = 0
vi.mock('./diarize/diarizeLocal', () => ({
  DiarizeEngine: class {
    diarize() { return [] }
    extract() {
      // 부0: 2발화(서로 다른 화자), 부1: 1발화(부0 첫 화자와 동일 임베딩)
      extractCalls++
      if (extractCalls === 1) return Promise.resolve({
        targets: [{ start: 0, end: 4 }, { start: 5, end: 9 }],
        embeddings: [new Float32Array([1, 0]), new Float32Array([0, 1])],
      })
      return Promise.resolve({
        targets: [{ start: 0, end: 4 }],
        embeddings: [new Float32Array([1, 0])],
      })
    }
    dispose() {}
  },
}))
const geminiMock = vi.fn(async (_prompt: string, _apiKey: string) => '## 요약 결과')
vi.mock('./summarize/gemini', () => ({
  summarizeWithGemini: (prompt: string, apiKey: string) => geminiMock(prompt, apiKey),
}))

beforeEach(async () => {
  localStorage.clear()
  extractCalls = 0
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

describe('isTooLongToProcess — 디코딩 상한(재전사·화자 구분 건너뛰기 경계)', () => {
  test('상한 이하면 처리 가능(false)', () => {
    expect(isTooLongToProcess(0)).toBe(false)
    expect(isTooLongToProcess(60 * 60)).toBe(false) // 1시간
    expect(isTooLongToProcess(MAX_PROCESS_SEC)).toBe(false) // 경계값(포함)
  })
  test('상한 초과면 너무 김(true)', () => {
    expect(isTooLongToProcess(MAX_PROCESS_SEC + 1)).toBe(true)
    expect(isTooLongToProcess(16 * 60 * 60)).toBe(true) // 16시간(스크린샷 사례)
  })
})

test("너무 긴 녹음은 재전사가 'too-long'을 반환하고 디코딩·Whisper를 아예 시도하지 않는다", async () => {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 5, text: '실시간 자막 내용입니다', source: 'webspeech', isFinal: true })
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  await finishMeeting(m.id, MAX_PROCESS_SEC + 1) // 상한 초과

  const result = await retranscribeMeeting(m.id)

  expect(result).toBe('too-long')
  expect(transcribeMock).not.toHaveBeenCalled() // 디코딩·전사 시도조차 없음(메모리 폭발 방지)
  // 기존 자막은 그대로 보존된다.
  expect((await getSegments(m.id)).map(s => s.text)).toEqual(['실시간 자막 내용입니다'])
})

test("너무 긴 녹음은 화자 구분도 'too-long'을 반환한다", async () => {
  const m = await createMeeting()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  await finishMeeting(m.id, MAX_PROCESS_SEC + 1)
  expect(await diarizeMeeting(m.id)).toBe('too-long')
})

test('diarizeGroup: 부 경계를 넘어 같은 화자에 같은 라벨을 부여한다', async () => {
  const m1 = await createMeeting()
  const m2 = await createMeeting()
  // 각 부에 발화 세그먼트 심기(부-상대 시각) + 오디오
  await appendSegment({ meetingId: m1.id, startSec: 0, endSec: 4, text: '첫 부 발언 A', source: 'whisper', isFinal: true })
  await appendSegment({ meetingId: m1.id, startSec: 5, endSec: 9, text: '첫 부 발언 B', source: 'whisper', isFinal: true })
  await appendSegment({ meetingId: m2.id, startSec: 0, endSec: 4, text: '둘째 부 발언 A', source: 'whisper', isFinal: true })
  await appendAudioChunk(m1.id, 0, new Blob(['a']), 'audio/webm')
  await appendAudioChunk(m2.id, 0, new Blob(['a']), 'audio/webm')
  await finishMeeting(m1.id, 60)
  await finishMeeting(m2.id, 60)

  const result = await diarizeGroup([m1.id, m2.id])
  expect(result).toBe('done')

  const s1 = await getSegments(m1.id)
  const s2 = await getSegments(m2.id)
  // 부0 첫 발화 = SPK1, 부0 둘째 = SPK2, 부1 발화(= 부0 첫 화자) = SPK1
  expect(s1.find(s => s.startSec === 0)?.speaker).toBe('SPK1')
  expect(s1.find(s => s.startSec === 5)?.speaker).toBe('SPK2')
  expect(s2.find(s => s.startSec === 0)?.speaker).toBe('SPK1')
})

test('retranscribeGroup: 모든 부를 재전사하고 각 부 세그먼트를 교체한다', async () => {
  const m1 = await createMeeting(); const m2 = await createMeeting()
  await appendAudioChunk(m1.id, 0, new Blob(['a']), 'audio/webm')
  await appendAudioChunk(m2.id, 0, new Blob(['a']), 'audio/webm')
  await finishMeeting(m1.id, 60); await finishMeeting(m2.id, 60)
  transcribeMock.mockResolvedValue([{ startSec: 0, endSec: 1, text: '재전사된 발언입니다' }])

  const result = await retranscribeGroup([m1.id, m2.id])
  expect(result).toBe('done')
  expect((await getSegments(m1.id)).map(s => s.text)).toEqual(['재전사된 발언입니다'])
  expect((await getSegments(m2.id)).map(s => s.text)).toEqual(['재전사된 발언입니다'])
})

test('retranscribeGroup: 오디오 없는 부는 건너뛰고 나머지는 재전사한다', async () => {
  const m1 = await createMeeting(); const m2 = await createMeeting()
  await appendAudioChunk(m2.id, 0, new Blob(['a']), 'audio/webm') // m1엔 오디오 없음
  await finishMeeting(m1.id, 60); await finishMeeting(m2.id, 60)
  transcribeMock.mockResolvedValue([{ startSec: 0, endSec: 1, text: '둘째 부 재전사' }])
  const result = await retranscribeGroup([m1.id, m2.id])
  expect(result).toBe('done')
  expect((await getSegments(m2.id)).map(s => s.text)).toEqual(['둘째 부 재전사'])
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

test('재전사 시 등록된 보정 사전이 세그먼트 텍스트에 적용된다', async () => {
  saveSettings({ corrections: [{ from: '머신런닝', to: '머신러닝' }] })
  const m = await createMeeting()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  await finishMeeting(m.id, 30)
  transcribeMock.mockResolvedValueOnce([{ startSec: 0, endSec: 1, text: '오늘은 머신런닝 얘기' }])

  const result = await retranscribeMeeting(m.id)

  expect(result).toBe('done')
  const segs = await getSegments(m.id)
  expect(segs.map(s => s.text)).toEqual(['오늘은 머신러닝 얘기'])
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

test('dropHallucinatedRepeats: 3회 이하 반복은 보존', () => {
  const segs = [
    { text: '네' }, { text: '네' }, { text: '네' }, // 짧은 조각 3회 — 보존
    { text: '3을 호출하면 이것만 줘요' }, { text: '3을 호출하면 이것만 줘요' }, { text: '3을 호출하면 이것만 줘요' }, // 긴 문장 3회 — 보존
  ]
  expect(dropHallucinatedRepeats(segs)).toHaveLength(6)
})

test('dropHallucinatedRepeats: 긴 문장 4회+ 반복은 첫 1개만 남긴다', () => {
  const segs = [
    { text: '2를 호출하면 이것만 줘요.' },
    { text: '3을 호출하면 이것만 줘요.' }, { text: '3을 호출하면 이것만 줘요.' },
    { text: '3을 호출하면 이것만 줘요.' }, { text: '3을 호출하면 이것만 줘요.' },
    { text: '2를 호출하면 이게 나와야 합니다.' },
  ]
  expect(dropHallucinatedRepeats(segs).map(s => s.text)).toEqual([
    '2를 호출하면 이것만 줘요.',
    '3을 호출하면 이것만 줘요.',
    '2를 호출하면 이게 나와야 합니다.',
  ])
})

test('dropHallucinatedRepeats: 공백/구두점 차이는 같은 조각으로 본다', () => {
  const segs = [{ text: '지금.' }, { text: ' 지금 ' }, { text: '지금' }, { text: '지금!' }]
  expect(dropHallucinatedRepeats(segs)).toHaveLength(0)
})

describe('collapseRepeatedPhrases', () => {
  test('같은 문장이 3회 이상 연속되면 1회로 축약한다', () => {
    expect(collapseRepeatedPhrases('다음 영상에서 만나요. 다음 영상에서 만나요. 다음 영상에서 만나요. 감사합니다.'))
      .toBe('다음 영상에서 만나요. 감사합니다.')
  })

  test('2회 반복은 자연스러운 발화로 보고 보존한다', () => {
    expect(collapseRepeatedPhrases('네. 네.')).toBe('네. 네.')
    expect(collapseRepeatedPhrases('정말 감사합니다. 정말 감사합니다.')).toBe('정말 감사합니다. 정말 감사합니다.')
  })

  test('다른 문장이 섞이면 각 문장을 독립적으로 카운트한다', () => {
    // 첫 문장은 3회 → 1회로 축약, 뒤의 2회 반복은 보존
    expect(collapseRepeatedPhrases('안녕하세요. 안녕하세요. 안녕하세요. 반갑습니다. 반갑습니다.'))
      .toBe('안녕하세요. 반갑습니다. 반갑습니다.')
  })

  test('빈 텍스트·단문은 그대로 둔다', () => {
    expect(collapseRepeatedPhrases('')).toBe('')
    expect(collapseRepeatedPhrases('안녕하세요')).toBe('안녕하세요')
    expect(collapseRepeatedPhrases('오늘 회의를 시작하겠습니다.')).toBe('오늘 회의를 시작하겠습니다.')
  })
})

describe('collapseRepeatedTokenRuns', () => {
  test('같은 토큰이 6회 이상 연속되면 앞 2개+마지막 1개만 남긴다', () => {
    expect(collapseRepeatedTokenRuns('그리고 ' + '15, '.repeat(60) + '네.'))
      .toBe('그리고 15, 15, 15, 네.')
  })

  test('마지막 토큰을 남겨 반복 끝의 구두점을 보존한다', () => {
    expect(collapseRepeatedTokenRuns('점수는 ' + '삼, '.repeat(99) + '삼.'))
      .toBe('점수는 삼, 삼, 삼.')
  })

  test('5회 이하 반복은 실제 발화로 보고 보존한다', () => {
    expect(collapseRepeatedTokenRuns('10, 10, 10, 10, 10 나왔어요')).toBe('10, 10, 10, 10, 10 나왔어요')
    expect(collapseRepeatedTokenRuns('네 네 네 알겠습니다')).toBe('네 네 네 알겠습니다')
  })

  test('서로 다른 토큰의 나열(증가하는 숫자 등)은 건드리지 않는다', () => {
    expect(collapseRepeatedTokenRuns('1, 2, 3, 4, 5, 6, 7, 8')).toBe('1, 2, 3, 4, 5, 6, 7, 8')
  })

  test('긴 텍스트 속 여러 반복 구간을 각각 축약한다', () => {
    expect(collapseRepeatedTokenRuns('그리고 3, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 7'))
      .toBe('그리고 3, 4, 4, 4, 4, 5, 5, 5, 6, 7')
  })

  test('빈 텍스트·단문은 그대로 둔다', () => {
    expect(collapseRepeatedTokenRuns('')).toBe('')
    expect(collapseRepeatedTokenRuns('안녕하세요')).toBe('안녕하세요')
  })

  test('구두점 없는 여러 토큰 주기 반복(예: "이것만 줘요"×30)은 3주기만 남긴다', () => {
    expect(collapseRepeatedTokenRuns('이것만 줘요 '.repeat(30).trim()))
      .toBe('이것만 줘요 이것만 줘요 이것만 줘요')
  })

  test('여러 토큰 주기의 앞뒤 문맥은 보존한다', () => {
    expect(collapseRepeatedTokenRuns('그러니까 ' + '3을 호출하면 이것만 줘요 '.repeat(10) + '알겠죠'))
      .toBe('그러니까 3을 호출하면 이것만 줘요 3을 호출하면 이것만 줘요 3을 호출하면 이것만 줘요 알겠죠')
  })

  test('여러 토큰 주기 3회 이하 반복은 실제 발화로 보고 보존한다', () => {
    expect(collapseRepeatedTokenRuns('네 알겠습니다 네 알겠습니다 네 알겠습니다'))
      .toBe('네 알겠습니다 네 알겠습니다 네 알겠습니다')
  })
})

describe('cleanTranscriptSegments', () => {
  test('환각 문구 제거·토큰/문장 반복 축약·무의미 필터·세그먼트 반복 제거를 한 번에 적용한다', () => {
    const segs = [
      { startSec: 0, endSec: 2, text: '시청해주셔서 감사합니다.' }, // 알려진 환각 → 제거 후 빈 문자열 → 필터
      { startSec: 2, endSec: 4, text: '회의를 시작하겠습니다.' },
      { startSec: 4, endSec: 6, text: '점수는 ' + '15, '.repeat(60) + '이렇게 나왔어요.' }, // 토큰 반복 → 축약
      { startSec: 6, endSec: 8, text: '3을 호출하면 이것만 줘요.' }, { startSec: 8, endSec: 10, text: '3을 호출하면 이것만 줘요.' },
      { startSec: 10, endSec: 12, text: '3을 호출하면 이것만 줘요.' }, { startSec: 12, endSec: 14, text: '3을 호출하면 이것만 줘요.' }, // 긴 문장 4회 → 첫 1개
      { startSec: 14, endSec: 16, text: '-' }, // 무의미 → 필터
    ]
    expect(cleanTranscriptSegments(segs).map(s => s.text)).toEqual([
      '회의를 시작하겠습니다.',
      '점수는 15, 15, 15, 이렇게 나왔어요.',
      '3을 호출하면 이것만 줘요.',
    ])
  })
})

describe('stripHallucinationPhrases', () => {
  test('알려진 환각 문구가 든 문장은 제거하고 실제 발화는 남긴다', () => {
    expect(stripHallucinationPhrases('다음 영상에서 만나요. 프론트 개선하신 거 받아보실 수 있을까요?'))
      .toBe('프론트 개선하신 거 받아보실 수 있을까요?')
    expect(stripHallucinationPhrases('구독과 좋아요 부탁드립니다. 자료 보내주세요.'))
      .toBe('자료 보내주세요.')
    // 공백·구두점 변형에도 매칭
    expect(stripHallucinationPhrases('시청해 주셔서 감사합니다.')).toBe('')
  })
  test('환각 아닌 문장은 그대로 둔다("감사합니다" 같은 실제 발화는 남긴다)', () => {
    expect(stripHallucinationPhrases('감사합니다.')).toBe('감사합니다.')
    expect(stripHallucinationPhrases('메일로 보내야 되는데요.')).toBe('메일로 보내야 되는데요.')
  })
  test('여러 문장 중 환각만 골라 제거한다', () => {
    expect(stripHallucinationPhrases('다음 영상에서 만나요. 감사합니다. 다음 영상에서 만나요. 감사합니다.'))
      .toBe('감사합니다. 감사합니다.')
  })
})

test('재전사하면 옛 요약을 삭제한다(전사 내용이 바뀌어 요약이 무효가 되므로)', async () => {
  const m = await createMeeting()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  await finishMeeting(m.id, 30)
  await saveSummary(m.id, 'minutes', '옛 전사로 만든 요약', 'gemini-3.5-flash')
  expect(await getSummaries(m.id)).toHaveLength(1)
  transcribeMock.mockResolvedValueOnce([{ startSec: 0, endSec: 1, text: '새로 전사된 발언입니다' }])

  const result = await retranscribeMeeting(m.id)

  expect(result).toBe('done')
  expect(await getSummaries(m.id)).toHaveLength(0) // 옛 요약 무효화
})
