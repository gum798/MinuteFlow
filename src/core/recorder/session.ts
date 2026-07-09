import { createMeeting, appendAudioChunk, appendSegment, finishMeeting } from '../store/meetings'
import { pickMimeType } from './mime'
import { ChunkedRecorder } from './chunkedRecorder'
import { createWakeLockManager } from './wakeLock'
import { getSpeechRecognitionCtor, WebSpeechEngine } from '../stt/webSpeech'

export interface RecordingState {
  phase: 'idle' | 'recording' | 'stopping'
  meetingId: string | null
  elapsedSec: number
  interim: string
  finals: string[]
  error: string | null
}

interface Session {
  meetingId: string
  recorder: ChunkedRecorder
  engine: WebSpeechEngine | null
  wakeLock: ReturnType<typeof createWakeLockManager>
  stream: MediaStream
  startedAt: number
  lastFinalEnd: number
  timer: ReturnType<typeof setInterval>
  pendingWrites: Promise<void>[]
}

const IDLE: RecordingState = {
  phase: 'idle', meetingId: null, elapsedSec: 0, interim: '', finals: [], error: null,
}

// 녹음 중 탭 닫기/새로고침 이탈을 브라우저 기본 확인창으로 경고한다.
// (returnValue 지정이 최신 브라우저에서 확인창을 띄우는 규약.)
function beforeUnloadHandler(e: BeforeUnloadEvent): void {
  e.preventDefault()
  e.returnValue = ''
}

// 전역 세션 — 라우트 이동(컴포넌트 unmount)에도 살아남는다.
let snapshot: RecordingState = IDLE
let session: Session | null = null
const listeners = new Set<() => void>()

/** 스냅샷을 새 객체로 교체하고 구독자에게 알린다 (getRecordingState는 항상 최신 캐시 반환). */
function set(patch: Partial<RecordingState>): void {
  snapshot = { ...snapshot, ...patch }
  for (const l of [...listeners]) l()
}

/** idle로 리셋 (finals/interim/elapsed 초기화). error를 주면 그 문구를 남긴다. */
function resetToIdle(error: string | null = null): void {
  snapshot = { ...IDLE, error }
  for (const l of [...listeners]) l()
}

export function subscribeRecording(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getRecordingState(): RecordingState {
  return snapshot
}

async function cleanup(): Promise<void> {
  const s = session
  if (!s) return
  session = null
  window.removeEventListener('beforeunload', beforeUnloadHandler)
  clearInterval(s.timer)
  // 스펙 §6 종료 순서: recorder.stop() → engine.stop() → wakeLock.disable()
  await s.recorder.stop().catch(() => {})
  s.engine?.stop()
  await s.wakeLock.disable().catch(() => {})
  s.stream.getTracks().forEach(t => t.stop())
}

export async function startRecording(): Promise<void> {
  if (snapshot.phase !== 'idle') return // 이미 recording/stopping → no-op

  set({ error: null })
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    set({ error: '마이크를 사용할 수 없습니다. 브라우저 권한을 확인해주세요.' })
    return
  }

  // getUserMedia 성공 이후 어디서 실패하든 스트림/부분 리소스를 반드시 정리한다.
  let timer: ReturnType<typeof setInterval> | undefined
  let wakeLock: ReturnType<typeof createWakeLockManager> | undefined
  try {
    const meeting = await createMeeting()
    const mimeType = pickMimeType()
    const pendingWrites: Promise<void>[] = []
    const recorder = new ChunkedRecorder(stream, {
      onChunk: (blob, seq) => {
        pendingWrites.push(appendAudioChunk(meeting.id, seq, blob, mimeType ?? blob.type).catch(() => {}))
      },
      onStallRestart: () => set({ error: '녹음이 잠시 끊겨 자동으로 재시작했습니다.' }),
      onError: () => set({ error: '녹음 장치 오류가 발생했습니다. 지금까지의 녹음은 저장되어 있습니다.' }),
    }, { mimeType })

    const startedAt = Date.now()
    const elapsedSecOf = () => (Date.now() - startedAt) / 1000

    let engine: WebSpeechEngine | null = null
    const sttCtor = getSpeechRecognitionCtor()
    if (sttCtor) {
      engine = new WebSpeechEngine(sttCtor, meeting.language, {
        onInterim: text => set({ interim: text }),
        onFinal: text => {
          const s = session
          if (!s) return
          const end = elapsedSecOf()
          s.pendingWrites.push(appendSegment({
            meetingId: s.meetingId, startSec: s.lastFinalEnd, endSec: end,
            text, source: 'webspeech', isFinal: true,
          }).catch(() => {}))
          s.lastFinalEnd = end
          set({ finals: [...snapshot.finals, text] })
        },
        onStatus: () => {},
      })
    }

    wakeLock = createWakeLockManager()
    timer = setInterval(() => set({ elapsedSec: elapsedSecOf() }), 1000)
    session = {
      meetingId: meeting.id, recorder, engine, wakeLock, stream,
      startedAt, lastFinalEnd: 0, timer, pendingWrites,
    }
    recorder.start()
    engine?.start()
    window.addEventListener('beforeunload', beforeUnloadHandler)
    await wakeLock.enable()
    set({ phase: 'recording', meetingId: meeting.id, elapsedSec: 0, interim: '', finals: [] })
  } catch {
    if (session) {
      // 세션이 이미 구성된 뒤 실패 → 레코더/엔진/워크락/스트림 전부 정리
      await cleanup()
    } else {
      // 세션 구성 이전 실패 → 부분 생성된 리소스 수동 정리
      if (timer) clearInterval(timer)
      if (wakeLock) await wakeLock.disable().catch(() => {})
      stream.getTracks().forEach(t => t.stop())
    }
    set({ error: '녹음을 시작하지 못했습니다. 다시 시도해주세요.' })
  }
}

export async function stopRecording(): Promise<string | null> {
  const s = session
  if (!s) return null
  set({ phase: 'stopping' })
  const durationSec = Math.round((Date.now() - s.startedAt) / 1000)
  await cleanup()
  // flush 청크/세그먼트 DB 쓰기가 끝난 뒤 회의를 마감한다.
  await Promise.allSettled(s.pendingWrites)
  try {
    await finishMeeting(s.meetingId, durationSec)
    resetToIdle()
    return s.meetingId
  } catch {
    // 미완료 회의는 홈 복구 배너가 안전망 — 기존과 동일
    resetToIdle('회의를 마치지 못했습니다. 홈의 복구 배너에서 이어서 저장할 수 있습니다.')
    return null
  }
}

/** 테스트 간 전역 세션 상태 누수를 막는다. */
export function __resetRecordingForTests(): void {
  if (session) {
    clearInterval(session.timer)
    session = null
  }
  window.removeEventListener('beforeunload', beforeUnloadHandler)
  snapshot = IDLE
  listeners.clear()
}
