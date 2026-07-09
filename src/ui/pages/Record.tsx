import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getSpeechRecognitionCtor } from '../../core/stt/webSpeech'
import { formatTimestamp } from '../../core/format'
import {
  subscribeRecording, getRecordingState, startRecording, stopRecording,
} from '../../core/recorder/session'
import { loadSettings } from '../../core/settings'
import { runAutoPipeline } from '../../core/pipeline'

export default function Record() {
  const { phase, error, elapsedSec, interim, finals } =
    useSyncExternalStore(subscribeRecording, getRecordingState)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const autoStartedRef = useRef(false)

  // 미지원 안내는 세션이 아니라 UI에서 판단 (세션은 ctor 없으면 엔진 없이 진행)
  const sttCtor = getSpeechRecognitionCtor()

  useEffect(() => {
    // autostart=1로 진입하면 마운트 시 한 번 자동으로 녹음을 시작한다.
    // ref 가드로 StrictMode dev 이중 마운트를 막고, 이미 녹음 중이면 시작하지 않는다.
    if (
      searchParams.get('autostart') === '1' &&
      !autoStartedRef.current &&
      getRecordingState().phase === 'idle'
    ) {
      autoStartedRef.current = true
      void startRecording()
    }
    // deps []: 마운트 1회 (ref 가드가 StrictMode 이중 실행 방지)
  }, [])

  async function onStop() {
    const id = await stopRecording()
    if (!id) return
    navigate(`/meeting/${id}`)
    // 설정이 켜져 있으면 회의록 화면으로 이동한 직후 자동 처리를 fire-and-forget으로 시작한다.
    // 진행 상황은 Meeting 화면의 잡 스토어 구독으로 자동 표시된다.
    if (loadSettings().autoPipeline) void runAutoPipeline(id)
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 22 }}>
        <div>
          <h1>녹음</h1>
          <p className="sub">
            {phase === 'recording'
              ? `⏺ 녹음 중 · ${formatTimestamp(elapsedSec)}`
              : phase === 'stopping'
                ? '저장 중…'
                : '실시간 자막과 함께 회의를 녹음합니다'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {phase === 'idle' && (
            <button className="btn btn-primary" onClick={() => void startRecording()}>🎙️ 녹음 시작</button>
          )}
          {phase === 'recording' && (
            <button className="btn btn-primary" onClick={() => void onStop()}>종료</button>
          )}
        </div>
      </div>
      {error && <div className="alert alert-err" role="alert">{error}</div>}
      {!sttCtor && (
        <p className="hint">이 브라우저는 실시간 자막을 지원하지 않습니다(Chrome 권장). 녹음은 정상 저장됩니다.</p>
      )}
      {sttCtor && <p className="hint">실시간 자막 사용 시 음성이 Google 서버로 전송됩니다.</p>}
      {phase === 'recording' && (
        <>
          <section className="card" aria-label="실시간 자막" style={{ marginTop: 16 }}>
            {finals.map((t, i) => <p key={i} style={{ color: 'var(--text-body)' }}>{t}</p>)}
            {interim && <p style={{ color: 'var(--text-muted)' }}>{interim}</p>}
          </section>
          <p className="hint" style={{ marginTop: 12 }}>모바일에서는 화면을 켠 채 이 탭을 유지해주세요.</p>
        </>
      )}
    </div>
  )
}
