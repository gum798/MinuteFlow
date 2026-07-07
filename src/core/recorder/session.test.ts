import type { Mock } from 'vitest'
import {
  subscribeRecording, getRecordingState, startRecording, stopRecording, __resetRecordingForTests,
} from './session'
import { createMeeting, appendAudioChunk, finishMeeting } from '../store/meetings'
import { ChunkedRecorder } from './chunkedRecorder'

vi.mock('../store/meetings', () => ({
  createMeeting: vi.fn(),
  appendAudioChunk: vi.fn().mockResolvedValue(undefined),
  appendSegment: vi.fn().mockResolvedValue(undefined),
  finishMeeting: vi.fn().mockResolvedValue(undefined),
}))
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
