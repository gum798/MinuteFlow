import type { Mock } from 'vitest'
import {
  subscribeRecording, getRecordingState, startRecording, stopRecording,
  getLastSessionParts, __setLevelMeterForTests, __resetRecordingForTests,
} from './session'
import { createMeeting, appendAudioChunk, finishMeeting, deleteMeeting } from '../store/meetings'
import { loadSettings } from '../settings'
import { ChunkedRecorder } from './chunkedRecorder'

// 레코더 start()가 던지도록 강제하는 스위치 — (d) 새 레코더 시작 실패 경로 테스트용.
const recorderControl = vi.hoisted(() => ({ failStart: false }))

vi.mock('../store/meetings', () => ({
  createMeeting: vi.fn(),
  appendAudioChunk: vi.fn().mockResolvedValue(undefined),
  appendSegment: vi.fn().mockResolvedValue(undefined),
  finishMeeting: vi.fn().mockResolvedValue(undefined),
  markGroupFirstPart: vi.fn().mockResolvedValue(undefined),
  deleteMeeting: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../settings', () => ({ loadSettings: vi.fn(() => ({ splitMinutes: 60 })) }))
vi.mock('./mime', () => ({ pickMimeType: () => 'audio/webm' }))
vi.mock('./chunkedRecorder', () => ({
  ChunkedRecorder: vi.fn(function (this: Record<string, unknown>) {
    this.start = vi.fn(() => { if (recorderControl.failStart) throw new Error('start fail') })
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
  recorderControl.failStart = false
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

/** 2부 createMeeting을 수동 resolve로 지연시켜 로테이션을 중간에 붙잡는다. */
function seedDeferredSecondPart(): (m: unknown) => void {
  let resolveCreate!: (m: unknown) => void
  ;(createMeeting as Mock).mockReset()
  ;(createMeeting as Mock)
    .mockResolvedValueOnce({ id: 'm1', language: 'ko-KR', title: 't1' })
    .mockImplementationOnce(() => new Promise(r => { resolveCreate = r }))
  return (m: unknown) => resolveCreate(m)
}

test('stopRecording은 진행 중 로테이션을 기다린 뒤 마감한다 (이중 finishMeeting·유령 부 없음)', async () => {
  ;(loadSettings as Mock).mockReturnValue({ splitMinutes: 1 })
  const resolveCreate = seedDeferredSecondPart()
  __setLevelMeterForTests(() => constMeter(0))

  vi.useFakeTimers()
  try {
    await startRecording()
    await vi.advanceTimersByTimeAsync(61_000) // 로테이션 트리거 → 2부 createMeeting에서 대기

    let stopped = false
    const stopP = stopRecording().then(r => { stopped = true; return r })
    await vi.advanceTimersByTimeAsync(0) // 마이크로태스크 flush
    expect(stopped).toBe(false) // 로테이션 미완료 → stop 대기 중
    expect(finishMeeting).not.toHaveBeenCalled()

    resolveCreate({ id: 'm2', language: 'ko-KR', title: 't2' })
    const id = await stopP
    expect(id).toBe('m2')
    // m1(로테이션)·m2(stop) 각 1회씩만 마감 — 이중 finishMeeting 없음
    expect(finishMeeting).toHaveBeenCalledTimes(2)
    expect(finishMeeting).toHaveBeenCalledWith('m1', expect.any(Number))
    expect(finishMeeting).toHaveBeenCalledWith('m2', expect.any(Number))
    expect(deleteMeeting).not.toHaveBeenCalled() // 조율된 경로 — 삭제 불필요
  } finally {
    vi.useRealTimers()
  }
})

test('로테이션 중 세션이 사라지면 방금 만든 next 부를 삭제한다 (유령 부 방지)', async () => {
  ;(loadSettings as Mock).mockReturnValue({ splitMinutes: 1 })
  const resolveCreate = seedDeferredSecondPart()
  __setLevelMeterForTests(() => constMeter(0))

  vi.useFakeTimers()
  try {
    await startRecording()
    await vi.advanceTimersByTimeAsync(61_000) // 로테이션 트리거 → 2부 createMeeting 대기
    __resetRecordingForTests() // 세션 급작 해제(이탈/종료) 시뮬
    resolveCreate({ id: 'm2', language: 'ko-KR', title: 't2' })
    await vi.advanceTimersByTimeAsync(0) // performRotation 재개 → 세션 불일치 감지
    await vi.advanceTimersByTimeAsync(0)
    expect(deleteMeeting).toHaveBeenCalledWith('m2')
  } finally {
    vi.useRealTimers()
  }
})

test('새 레코더 시작이 재시도까지 실패하면 error 상태로 표면화하고 next를 삭제한다', async () => {
  ;(loadSettings as Mock).mockReturnValue({ splitMinutes: 1 })
  seedTwoParts()
  __setLevelMeterForTests(() => constMeter(0))

  vi.useFakeTimers()
  try {
    await startRecording() // 첫 레코더는 정상 start
    recorderControl.failStart = true // 이후 새 레코더 start는 모두 실패
    await vi.advanceTimersByTimeAsync(62_000)

    expect(deleteMeeting).toHaveBeenCalledWith('m2')
    expect(getRecordingState().error).toBe('녹음 장치 오류 — 녹음을 종료해주세요.')
    // 이전 레코더는 계속 녹음 — 현재 부 유지, 마감 안 함
    expect(getRecordingState().partIndex).toBe(1)
    expect(getRecordingState().meetingId).toBe('m1')
    expect(finishMeeting).not.toHaveBeenCalled()
    // 자동 분할 중단(스핀 방지) — 더 진행해도 재시도 없음
    await vi.advanceTimersByTimeAsync(600_000)
    expect(createMeeting).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})
