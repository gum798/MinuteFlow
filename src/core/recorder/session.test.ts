import type { Mock } from 'vitest'
import {
  subscribeRecording, getRecordingState, startRecording, stopRecording,
  getLastSessionParts, __setLevelMeterForTests, __resetRecordingForTests,
} from './session'
import { createMeeting, appendAudioChunk, finishMeeting } from '../store/meetings'
import { loadSettings } from '../settings'
import { ChunkedRecorder } from './chunkedRecorder'

vi.mock('../store/meetings', () => ({
  createMeeting: vi.fn(),
  appendAudioChunk: vi.fn().mockResolvedValue(undefined),
  appendSegment: vi.fn().mockResolvedValue(undefined),
  finishMeeting: vi.fn().mockResolvedValue(undefined),
  markGroupFirstPart: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../settings', () => ({ loadSettings: vi.fn(() => ({ splitMinutes: 60 })) }))
vi.mock('./mime', () => ({ pickMimeType: () => 'audio/webm' }))
vi.mock('./chunkedRecorder', () => ({
  ChunkedRecorder: vi.fn(function (this: Record<string, unknown>) {
    this.start = vi.fn()
    this.stop = vi.fn().mockResolvedValue(undefined)
  }),
}))
vi.mock('./wakeLock', () => ({
  createWakeLockManager: () => ({
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
  }),
}))
// ctor null → 엔진 없이 진행 (jsdom 미지원과 동일 경로)
vi.mock('../stt/webSpeech', () => ({
  getSpeechRecognitionCtor: () => null,
  WebSpeechEngine: vi.fn(),
}))

const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  __resetRecordingForTests()
  vi.clearAllMocks()
  ;(createMeeting as Mock).mockResolvedValue({ id: 'm1', language: 'ko-KR' })
  ;(appendAudioChunk as Mock).mockResolvedValue(undefined)
  ;(loadSettings as Mock).mockReturnValue({ splitMinutes: 60 })
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  })
})
afterEach(() => {
  __resetRecordingForTests()
  vi.unstubAllGlobals()
})

test('startRecording 후 phase가 recording이고 구독자에게 알린다', async () => {
  const cb = vi.fn()
  subscribeRecording(cb)
  await startRecording()
  expect(getRecordingState().phase).toBe('recording')
  expect(getRecordingState().meetingId).toBe('m1')
  expect(cb).toHaveBeenCalled()
})

test('startRecording은 beforeunload 리스너를 등록하고 stop 시 제거한다', async () => {
  const addSpy = vi.spyOn(window, 'addEventListener')
  const removeSpy = vi.spyOn(window, 'removeEventListener')
  await startRecording()
  expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))
  const handler = addSpy.mock.calls.find(c => c[0] === 'beforeunload')?.[1]
  expect(handler).toBeDefined()

  await stopRecording()
  expect(removeSpy).toHaveBeenCalledWith('beforeunload', handler)
})

test('이미 recording이면 재호출은 no-op (createMeeting 1회)', async () => {
  await startRecording()
  await startRecording()
  expect(createMeeting).toHaveBeenCalledTimes(1)
})

test('stopRecording은 pendingWrites를 기다린 뒤 finishMeeting하고 meetingId 반환 + idle 복귀', async () => {
  let resolveWrite!: () => void
  ;(appendAudioChunk as Mock).mockReturnValue(new Promise<void>(r => { resolveWrite = r }))
  await startRecording()
  // 레코더에 넘어간 이벤트 콜백으로 청크 1개 유입 → pendingWrites 적재
  const events = (ChunkedRecorder as unknown as Mock).mock.calls[0][1]
  events.onChunk(new Blob(['x']), 0)

  const stopP = stopRecording()
  await flush()
  expect(finishMeeting).not.toHaveBeenCalled() // write 미완료 → 아직 마감 안 함

  resolveWrite()
  const id = await stopP
  expect(id).toBe('m1')
  expect(finishMeeting).toHaveBeenCalledWith('m1', expect.any(Number))
  expect(getRecordingState().phase).toBe('idle')
  expect(getRecordingState().meetingId).toBeNull()
})

test('idle 상태에서 stopRecording은 null 반환', async () => {
  expect(await stopRecording()).toBeNull()
})

test('getUserMedia 거부 시 error 상태 + idle 유지', async () => {
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
  })
  await startRecording()
  expect(getRecordingState().phase).toBe('idle')
  expect(getRecordingState().error).toMatch(/마이크/)
})

test('getRecordingState는 변경 전까지 같은 참조를 돌려준다 (useSyncExternalStore 안전)', () => {
  expect(getRecordingState()).toBe(getRecordingState())
})

test('분할이 없으면 getLastSessionParts는 마지막 회의 id 하나만 담는다', async () => {
  await startRecording()
  await stopRecording()
  expect(getLastSessionParts()).toEqual(['m1'])
})

// --- 분할 로테이션 (무음 감지 세션 로테이션) ---

/** 항상 같은 정규화 RMS를 돌려주는 레벨미터 mock. */
function constMeter(rms: number): { read: Mock; close: Mock } {
  return { read: vi.fn(() => rms), close: vi.fn() }
}

/** createMeeting을 부 순서대로 다른 id로 응답하도록 설정. */
function seedTwoParts(): void {
  ;(createMeeting as Mock).mockReset()
  ;(createMeeting as Mock)
    .mockResolvedValueOnce({ id: 'm1', language: 'ko-KR', title: 't1' })
    .mockResolvedValueOnce({ id: 'm2', language: 'ko-KR', title: 't2' })
}

test('splitMinutes 경과 + 무음 2틱이면 무음 시점에 새 부로 로테이션한다', async () => {
  ;(loadSettings as Mock).mockReturnValue({ splitMinutes: 1 }) // 60초 목표
  seedTwoParts()
  __setLevelMeterForTests(() => constMeter(0)) // 계속 무음
  const partComplete = vi.fn()
  window.addEventListener('minuteflow:part-complete', partComplete)

  vi.useFakeTimers()
  try {
    await startRecording()
    expect(getRecordingState().partIndex).toBe(1)
    await vi.advanceTimersByTimeAsync(62_000) // 60초 목표 + 여유

    expect(createMeeting).toHaveBeenCalledTimes(2) // 부1(시작) + 부2(로테이션)
    expect(finishMeeting).toHaveBeenCalledWith('m1', expect.any(Number))
    expect(partComplete).toHaveBeenCalledTimes(1)
    expect((partComplete.mock.calls[0][0] as CustomEvent).detail).toEqual({ meetingId: 'm1' })
    // 레코더 2개 생성 + 같은 스트림 재사용
    const calls = (ChunkedRecorder as unknown as Mock).mock.calls
    expect(calls.length).toBe(2)
    expect(calls[1][0]).toBe(calls[0][0])
    expect(getRecordingState().partIndex).toBe(2)
    expect(getRecordingState().meetingId).toBe('m2')
  } finally {
    vi.useRealTimers()
    window.removeEventListener('minuteflow:part-complete', partComplete)
  }
})

test('무음이 없으면 하드캡 전까지 로테이션하지 않고 하드캡에서 강제 분할한다', async () => {
  ;(loadSettings as Mock).mockReturnValue({ splitMinutes: 1 }) // 목표 60초, 하드캡 360초
  seedTwoParts()
  __setLevelMeterForTests(() => constMeter(0.5)) // 계속 큰 소리 → 무음 아님

  vi.useFakeTimers()
  try {
    await startRecording()
    await vi.advanceTimersByTimeAsync(359_000)
    expect(createMeeting).toHaveBeenCalledTimes(1) // 하드캡 전 → 분할 없음
    await vi.advanceTimersByTimeAsync(2_000) // 총 361초 → 하드캡 초과
    expect(createMeeting).toHaveBeenCalledTimes(2)
    expect(getRecordingState().partIndex).toBe(2)
  } finally {
    vi.useRealTimers()
  }
})

test('splitMinutes=0이면 무음이 계속돼도 로테이션하지 않는다', async () => {
  ;(loadSettings as Mock).mockReturnValue({ splitMinutes: 0 })
  __setLevelMeterForTests(() => constMeter(0))
  vi.useFakeTimers()
  try {
    await startRecording()
    await vi.advanceTimersByTimeAsync(600_000) // 10분
    expect(createMeeting).toHaveBeenCalledTimes(1)
    expect(getRecordingState().partIndex).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})

test('로테이션 후 stopRecording하면 getLastSessionParts가 [1부, 2부]를 순서대로 돌려준다', async () => {
  ;(loadSettings as Mock).mockReturnValue({ splitMinutes: 1 })
  seedTwoParts()
  __setLevelMeterForTests(() => constMeter(0))
  vi.useFakeTimers()
  try {
    await startRecording()
    await vi.advanceTimersByTimeAsync(62_000)
    expect(getLastSessionParts()).toEqual([]) // 아직 녹음 중
    const id = await stopRecording()
    expect(id).toBe('m2') // 반환은 마지막 부
    expect(getLastSessionParts()).toEqual(['m1', 'm2'])
  } finally {
    vi.useRealTimers()
  }
})
