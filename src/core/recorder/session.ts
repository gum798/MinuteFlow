import {
  createMeeting, appendAudioChunk, appendSegment, finishMeeting, markGroupFirstPart, deleteMeeting,
} from '../store/meetings'
import type { Meeting } from '../types'
import { loadSettings } from '../settings'
import { pickMimeType } from './mime'
import { ChunkedRecorder } from './chunkedRecorder'
import { createWakeLockManager } from './wakeLock'
import { getSpeechRecognitionCtor, WebSpeechEngine } from '../stt/webSpeech'

export interface RecordingState {
  phase: 'idle' | 'recording' | 'stopping'
  meetingId: string | null
  /** 세션 전체(모든 부 합산) 경과 초 — 아일랜드/헤더 표시용. */
  elapsedSec: number
  /** 현재 부 번호(1부터). */
  partIndex: number
  interim: string
  finals: string[]
  error: string | null
}

/** 마이크 오디오 레벨(RMS)을 읽는 계량기 — Web Audio 구현은 테스트에서 주입/모킹된다. */
export interface LevelMeter {
  /** 0(무음)~1(최대) 정규화된 순간 RMS. */
  read(): number
  close(): void
}

interface Session {
  /** 현재 부의 회의 id — 로테이션마다 갱신된다. */
  meetingId: string
  /** 첫 부의 회의 id(= 분할 그룹 id). 불변. */
  firstMeetingId: string
  /** 첫 부의 기본 제목 스냅샷 — 분할 시 ' (1부)' 부착 여부 판단용. */
  firstPartBaseTitle: string
  /** 실제 분할이 한 번이라도 일어났으면 그룹 id, 아니면 null. */
  groupId: string | null
  /** 현재 부 번호(1부터). */
  partIndex: number
  recorder: ChunkedRecorder
  engine: WebSpeechEngine | null
  wakeLock: ReturnType<typeof createWakeLockManager>
  stream: MediaStream
  mimeType: string | undefined
  language: string
  levelMeter: LevelMeter
  /** 설정에서 캡처한 분할 간격(분). 0이면 분할 끄기. */
  splitMinutes: number
  /** 세션 시작 시각(총 경과 계산용). */
  startedAt: number
  /** 현재 부 시작 시각(부별 길이·자막 시각 계산용). */
  partStartedAt: number
  /** 현재 부에서 마지막 final 세그먼트가 끝난 초(부 시작 기준). */
  lastFinalEnd: number
  /** 연속 무음 틱 수. */
  silentTicks: number
  /** 로테이션 진행 중이면 그 완료 promise, 아니면 null (stopRecording이 이걸 await해 경합을 해소). */
  rotating: Promise<void> | null
  /** 생성된 모든 부의 회의 id(생성 순서, parts[0]=첫 부). */
  parts: string[]
  timer: ReturnType<typeof setInterval>
  /** 현재 부의 DB 쓰기 promise들 — 로테이션마다 새 배열로 교체된다. */
  pendingWrites: Promise<void>[]
}

const IDLE: RecordingState = {
  phase: 'idle', meetingId: null, elapsedSec: 0, partIndex: 1, interim: '', finals: [], error: null,
}

// 무음 판정: 정규화 RMS가 SILENCE_RMS 미만인 상태가 SILENCE_HOLD 틱(=초) 연속되면 '무음 중'.
const SILENCE_RMS = 0.015
const SILENCE_HOLD = 2
// 무음이 오지 않아도 목표 시각 + HARD_CAP_EXTRA_SEC이면 강제 분할한다.
const HARD_CAP_EXTRA_SEC = 300

/** 기본 레벨미터 구현(Web Audio). 테스트에서 __setLevelMeterForTests로 교체 가능. */
export function createLevelMeter(stream: MediaStream): LevelMeter {
  const AudioCtor: typeof AudioContext =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!
  const ctx = new AudioCtor()
  // suspended 상태면 RMS가 0으로 읽혀 가짜 무음 판정을 부른다 — 재개한다.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  return {
    read() {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128 // 0..255 → -1..1
        sum += v * v
      }
      return Math.sqrt(sum / buf.length)
    },
    close() {
      try { source.disconnect() } catch { /* 이미 정리됨 */ }
      void ctx.close().catch(() => {})
    },
  }
}

let levelMeterFactory: (stream: MediaStream) => LevelMeter = createLevelMeter

// 전역 세션 — 라우트 이동(컴포넌트 unmount)에도 살아남는다.
let snapshot: RecordingState = IDLE
let session: Session | null = null
// 마지막 세션이 남긴 모든 부의 id(순서대로). 다음 startRecording까지 유지된다.
let lastSessionParts: string[] = []
const listeners = new Set<() => void>()

// 녹음 중 탭 닫기/새로고침 이탈을 브라우저 기본 확인창으로 경고한다.
// (returnValue 지정이 최신 브라우저에서 확인창을 띄우는 규약.)
function beforeUnloadHandler(e: BeforeUnloadEvent): void {
  e.preventDefault()
  e.returnValue = ''
}

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

/** 마지막으로 종료된 세션의 모든 부 id(순서대로). 분할이 없었으면 [회의 id] 1개. */
export function getLastSessionParts(): string[] {
  return [...lastSessionParts]
}

/** 레벨미터를 안전하게 읽는다 — 읽기 실패는 '무음 아님'(1)으로 간주해 오탐 분할을 막는다. */
function readLevel(s: Session): number {
  try { return s.levelMeter.read() } catch { return 1 }
}

/** 1초 ticker: 총 경과 갱신 + 무음 추적 + 분할 조건 판정. */
function onTick(): void {
  const s = session
  if (!s) return
  set({ elapsedSec: (Date.now() - s.startedAt) / 1000 })

  if (s.rotating || s.splitMinutes <= 0) return

  const rms = readLevel(s)
  if (rms < SILENCE_RMS) s.silentTicks++
  else s.silentTicks = 0
  const isSilent = s.silentTicks >= SILENCE_HOLD

  const partElapsedSec = (Date.now() - s.partStartedAt) / 1000
  const target = s.splitMinutes * 60
  const shouldRotate =
    (partElapsedSec >= target && isSilent) || partElapsedSec >= target + HARD_CAP_EXTRA_SEC
  if (shouldRotate) rotatePart()
}

/**
 * 로테이션을 시작한다(재진입/동시 실행 방지). onTick에서 호출.
 * 진행 중인 로테이션 promise를 세션에 걸어두어 stopRecording이 이를 await로 조율한다.
 */
function rotatePart(): void {
  const s = session
  if (!s || s.rotating) return
  const p = performRotation(s)
  s.rotating = p
  void p.finally(() => { if (s.rotating === p) s.rotating = null })
}

/** 새 레코더를 만들어 start한다. 시작 실패 시 1회 재시도, 최종 실패면 null. */
function startNewRecorder(s: Session, meetingId: string, writes: Promise<void>[]): ChunkedRecorder | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rec = new ChunkedRecorder(s.stream, {
      onChunk: (blob, seq) => {
        writes.push(appendAudioChunk(meetingId, seq, blob, s.mimeType ?? blob.type).catch(() => {}))
      },
      onStallRestart: () => set({ error: '녹음이 잠시 끊겨 자동으로 재시작했습니다.' }),
      onError: () => set({ error: '녹음 장치 오류가 발생했습니다. 지금까지의 녹음은 저장되어 있습니다.' }),
    }, { mimeType: s.mimeType })
    try {
      rec.start()
      return rec
    } catch { /* 다음 시도로 */ }
  }
  return null
}

/**
 * 현재 부를 마감하고 새 부로 이어 녹음한다. 마이크/자막 무중단이 목표.
 * 데이터 최우선: 각 실패 지점에서 현재 부 녹음을 지키도록 설계.
 */
async function performRotation(s: Session): Promise<void> {
  const completedId = s.meetingId
  const oldRecorder = s.recorder
  const oldWrites = s.pendingWrites
  const oldPartStartedAt = s.partStartedAt
  const nextIndex = s.partIndex + 1
  const groupId = s.groupId ?? s.firstMeetingId

  // (a) 새 부 회의를 먼저 만든다 — 실패해도 현재 부는 계속 녹음(현재 레코더 유지).
  let next: Meeting
  try {
    next = await createMeeting(s.language, {
      groupId, partIndex: nextIndex, titleSuffix: ` (${nextIndex}부)`,
    })
  } catch {
    s.silentTicks = 0 // 매 틱 재시도 폭주 방지 — 다음 무음 홀드까지 미룬다.
    return
  }

  // 로테이션 중 세션이 해제/교체됐다면(이탈·종료) 방금 만든 빈 부를 정리하고 중단한다.
  if (session !== s) {
    await deleteMeeting(next.id).catch(() => {})
    return
  }

  // (b) 첫 분할이면 첫 부에 그룹 메타 부여(+ 기본 제목이면 ' (1부)').
  if (s.groupId === null) {
    s.groupId = groupId
    await markGroupFirstPart(s.firstMeetingId, groupId, s.firstPartBaseTitle, ' (1부)').catch(() => {})
  }

  // (c) 새 레코더를 이전 레코더보다 먼저 start — 경계 ~1초 중복 녹음(> 발화 유실).
  //     각 레코더는 per-closure로 자기 부에만 쓰므로 중복은 안전하다.
  const newWrites: Promise<void>[] = []
  const newRecorder = startNewRecorder(s, next.id, newWrites)
  if (!newRecorder) {
    // 새 레코더를 못 띄웠다. 이전 레코더는 계속 돌고 있어 현재 부 데이터 유실은 없다.
    // 이 세션의 자동 분할을 끄고(스핀 방지) 사용자에게 종료를 권한다.
    s.splitMinutes = 0
    s.silentTicks = 0
    set({ error: '녹음 장치 오류 — 녹음을 종료해주세요.' })
    await deleteMeeting(next.id).catch(() => {})
    return
  }

  // 세션을 새 부로 전환(자막·타이머 기준 갱신). WebSpeech 엔진은 그대로 두고 onFinal이 참조한다.
  s.meetingId = next.id
  s.recorder = newRecorder
  s.pendingWrites = newWrites
  s.lastFinalEnd = 0
  s.partStartedAt = Date.now()
  s.partIndex = nextIndex
  s.silentTicks = 0
  s.parts.push(next.id)
  set({ meetingId: next.id, partIndex: nextIndex, interim: '', finals: [] })

  // (e) 이전 레코더 정지·flush → 쓰기 완료 → 이전 부 마감 → 완료 이벤트(후처리 큐 트리거).
  await oldRecorder.stop().catch(() => {})
  await Promise.allSettled(oldWrites)
  const partDuration = Math.max(0, Math.round((Date.now() - oldPartStartedAt) / 1000))
  await finishMeeting(completedId, partDuration).catch(() => {})
  window.dispatchEvent(new CustomEvent('minuteflow:part-complete', { detail: { meetingId: completedId } }))
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
  s.levelMeter.close()
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
    // 각 레코더는 정확히 한 부(part)에만 쓴다 — meeting.id·pendingWrites를 클로저에 고정한다.
    // (cleanup이 session=null로 만든 뒤에도 stop() flush 청크가 반드시 기록되도록 — 데이터 최우선.)
    const recorder = new ChunkedRecorder(stream, {
      onChunk: (blob, seq) => {
        pendingWrites.push(appendAudioChunk(meeting.id, seq, blob, mimeType ?? blob.type).catch(() => {}))
      },
      onStallRestart: () => set({ error: '녹음이 잠시 끊겨 자동으로 재시작했습니다.' }),
      onError: () => set({ error: '녹음 장치 오류가 발생했습니다. 지금까지의 녹음은 저장되어 있습니다.' }),
    }, { mimeType })

    let engine: WebSpeechEngine | null = null
    const sttCtor = getSpeechRecognitionCtor()
    if (sttCtor) {
      engine = new WebSpeechEngine(sttCtor, meeting.language, {
        onInterim: text => set({ interim: text }),
        onFinal: text => {
          const s = session
          if (!s) return
          const end = (Date.now() - s.partStartedAt) / 1000 // 부 시작 기준 시각
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

    // 레벨미터 구성 실패는 치명적이지 않다 — 무음 감지만 비활성(하드캡으로만 분할).
    let levelMeter: LevelMeter
    try {
      levelMeter = levelMeterFactory(stream)
    } catch {
      levelMeter = { read: () => 1, close: () => {} }
    }

    wakeLock = createWakeLockManager()
    const startedAt = Date.now()
    timer = setInterval(onTick, 1000)
    session = {
      meetingId: meeting.id, firstMeetingId: meeting.id, firstPartBaseTitle: meeting.title,
      groupId: null, partIndex: 1, recorder, engine, wakeLock, stream, mimeType,
      language: meeting.language, levelMeter, splitMinutes: loadSettings().splitMinutes,
      startedAt, partStartedAt: startedAt, lastFinalEnd: 0, silentTicks: 0, rotating: null,
      parts: [meeting.id], timer, pendingWrites,
    }
    lastSessionParts = []
    recorder.start()
    engine?.start()
    window.addEventListener('beforeunload', beforeUnloadHandler)
    await wakeLock.enable()
    set({ phase: 'recording', meetingId: meeting.id, elapsedSec: 0, partIndex: 1, interim: '', finals: [] })
  } catch {
    if (session) {
      // 세션이 이미 구성된 뒤 실패 → 레코더/엔진/워크락/스트림/레벨미터 전부 정리
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
  // 진행 중인 로테이션이 있으면 안전하게 끝나길 먼저 기다린다
  // (유령 빈 부·이중 finishMeeting 방지). 로테이션이 부를 바꿨을 수 있어 이후 최신 상태를 읽는다.
  if (s.rotating) await s.rotating
  // 마지막 부의 길이는 부 시작 기준으로 계산한다(부별 duration = 부 길이).
  const durationSec = Math.round((Date.now() - s.partStartedAt) / 1000)
  const lastMeetingId = s.meetingId
  const pendingWrites = s.pendingWrites
  lastSessionParts = [...s.parts]
  await cleanup()
  // flush 청크/세그먼트 DB 쓰기가 끝난 뒤 회의를 마감한다.
  await Promise.allSettled(pendingWrites)
  try {
    await finishMeeting(lastMeetingId, durationSec)
    resetToIdle()
    return lastMeetingId
  } catch {
    // 미완료 회의는 홈 복구 배너가 안전망 — 기존과 동일
    resetToIdle('회의를 마치지 못했습니다. 홈의 복구 배너에서 이어서 저장할 수 있습니다.')
    return null
  }
}

/** 테스트에서 레벨미터 구현을 주입한다. */
export function __setLevelMeterForTests(factory: (stream: MediaStream) => LevelMeter): void {
  levelMeterFactory = factory
}

/** 테스트 간 전역 세션 상태 누수를 막는다. */
export function __resetRecordingForTests(): void {
  if (session) {
    clearInterval(session.timer)
    session = null
  }
  window.removeEventListener('beforeunload', beforeUnloadHandler)
  levelMeterFactory = createLevelMeter
  lastSessionParts = []
  snapshot = IDLE
  listeners.clear()
}
