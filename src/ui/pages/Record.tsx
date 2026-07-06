import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createMeeting, appendAudioChunk, appendSegment, finishMeeting } from '../../core/store/meetings'
import { pickMimeType } from '../../core/recorder/mime'
import { ChunkedRecorder } from '../../core/recorder/chunkedRecorder'
import { createWakeLockManager } from '../../core/recorder/wakeLock'
import { getSpeechRecognitionCtor, WebSpeechEngine } from '../../core/stt/webSpeech'
import { formatTimestamp } from '../../core/format'

type Phase = 'idle' | 'recording' | 'stopping'

export default function Record() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [interim, setInterim] = useState('')
  const [finals, setFinals] = useState<string[]>([])
  const navigate = useNavigate()

  const sttCtor = getSpeechRecognitionCtor()

  const session = useRef<{
    meetingId: string
    recorder: ChunkedRecorder
    engine: WebSpeechEngine | null
    wakeLock: ReturnType<typeof createWakeLockManager>
    stream: MediaStream
    startedAt: number
    lastFinalEnd: number
    timer: ReturnType<typeof setInterval>
    pendingWrites: Promise<void>[]
  } | null>(null)

  useEffect(() => () => { void cleanup() }, [])

  async function cleanup() {
    const s = session.current
    if (!s) return
    session.current = null
    clearInterval(s.timer)
    // 스펙 §6 종료 순서: recorder.stop() → engine.stop() → wakeLock.disable()
    await s.recorder.stop().catch(() => {})
    s.engine?.stop()
    await s.wakeLock.disable().catch(() => {})
    s.stream.getTracks().forEach(t => t.stop())
  }

  async function start() {
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('마이크를 사용할 수 없습니다. 브라우저 권한을 확인해주세요.')
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
        onStallRestart: () => setError('녹음이 잠시 끊겨 자동으로 재시작했습니다.'),
        onError: () => setError('녹음 장치 오류가 발생했습니다. 지금까지의 녹음은 저장되어 있습니다.'),
      }, { mimeType })

      const startedAt = Date.now()
      const elapsedSec = () => (Date.now() - startedAt) / 1000

      let engine: WebSpeechEngine | null = null
      if (sttCtor) {
        engine = new WebSpeechEngine(sttCtor, meeting.language, {
          onInterim: setInterim,
          onFinal: text => {
            const s = session.current
            if (!s) return
            const end = elapsedSec()
            s.pendingWrites.push(appendSegment({
              meetingId: s.meetingId, startSec: s.lastFinalEnd, endSec: end,
              text, source: 'webspeech', isFinal: true,
            }).catch(() => {}))
            s.lastFinalEnd = end
            setFinals(prev => [...prev, text])
          },
          onStatus: () => {},
        })
      }

      wakeLock = createWakeLockManager()
      timer = setInterval(() => setElapsed(elapsedSec()), 1000)
      session.current = {
        meetingId: meeting.id, recorder, engine, wakeLock, stream,
        startedAt, lastFinalEnd: 0, timer, pendingWrites,
      }
      recorder.start()
      engine?.start()
      await wakeLock.enable()
      setPhase('recording')
    } catch {
      if (session.current) {
        // 세션이 이미 구성된 뒤 실패 → 레코더/엔진/워크락/스트림 전부 정리
        await cleanup()
      } else {
        // 세션 구성 이전 실패 → 부분 생성된 리소스 수동 정리
        if (timer) clearInterval(timer)
        if (wakeLock) await wakeLock.disable().catch(() => {})
        stream.getTracks().forEach(t => t.stop())
      }
      setError('녹음을 시작하지 못했습니다. 다시 시도해주세요.')
    }
  }

  async function stop() {
    const s = session.current
    if (!s) return
    setPhase('stopping')
    const durationSec = Math.round((Date.now() - s.startedAt) / 1000)
    await cleanup()
    // flush 청크/세그먼트 DB 쓰기가 끝난 뒤 회의를 마감한다.
    await Promise.allSettled(s.pendingWrites)
    try {
      await finishMeeting(s.meetingId, durationSec)
      navigate(`/meeting/${s.meetingId}`)
    } catch {
      setError('회의를 마치지 못했습니다. 홈의 복구 배너에서 이어서 저장할 수 있습니다.')
      setPhase('idle')
    }
  }

  return (
    <main>
      <h1>녹음</h1>
      {error && <div role="alert">{error}</div>}
      {!sttCtor && (
        <p>이 브라우저는 실시간 자막을 지원하지 않습니다(Chrome 권장). 녹음은 정상 저장됩니다.</p>
      )}
      {sttCtor && <p><small>실시간 자막 사용 시 음성이 Google 서버로 전송됩니다.</small></p>}
      {phase === 'idle' && <button onClick={() => void start()}>녹음 시작</button>}
      {phase === 'recording' && (
        <>
          <p>⏺ {formatTimestamp(elapsed)}</p>
          <button onClick={() => void stop()}>종료</button>
          <section aria-label="실시간 자막">
            {finals.map((t, i) => <p key={i}>{t}</p>)}
            {interim && <p style={{ color: 'gray' }}>{interim}</p>}
          </section>
        </>
      )}
      {phase === 'stopping' && <p>저장 중…</p>}
    </main>
  )
}
