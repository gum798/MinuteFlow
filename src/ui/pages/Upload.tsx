import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { loadSettings } from '../../core/settings'
import { GROQ_ENABLED } from '../../core/features'
import { decodeTo16kMono } from '../../core/audio/decode'
import { detectWebGPU, WhisperLocalEngine, type WhisperProgress } from '../../core/stt/whisperLocal'
import { transcribeBlobWithGroq, transcribeSamplesWithGroq, GROQ_FILE_LIMIT } from '../../core/stt/groq'
import { createUploadMeeting, replaceSegments, finishMeeting } from '../../core/store/meetings'
import { isMeaningfulText, dropHallucinatedRepeats } from '../../core/meetingActions'
import type { DraftSegment } from '../../core/stt/types'

type Engine = 'whisper' | 'groq'

export default function Upload() {
  const settings = loadSettings()
  const [file, setFile] = useState<File | null>(null)
  const [engine, setEngine] = useState<Engine>(() => GROQ_ENABLED && settings.groqApiKey ? 'groq' : 'whisper')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const hasGroqKey = settings.groqApiKey.length > 0

  function onWhisperProgress(p: WhisperProgress) {
    if (p.kind === 'download') { setStage(`모델 다운로드 중 — ${p.file}`); setProgress(p.progress) }
    else { setStage(p.message); setProgress(null) }
  }

  async function start() {
    if (!file || busy) return
    setBusy(true); setError(null)
    const title = file.name.replace(/\.[^.]+$/, '') || file.name
    let meetingId: string | null = null
    try {
      setStage('회의 생성 중…')
      const meeting = await createUploadMeeting(title, 0, file, file.type || 'audio/mpeg', settings.language)
      meetingId = meeting.id
      let segs: DraftSegment[]
      let durationSec = 0

      if (engine === 'groq' && file.size <= GROQ_FILE_LIMIT) {
        setStage('Groq로 전사 중…')
        segs = await transcribeBlobWithGroq(file, file.name, {
          apiKey: settings.groqApiKey, language: settings.language,
        })
        durationSec = Math.round(segs.at(-1)?.endSec ?? 0)
      } else {
        setStage('오디오 디코딩 중… (긴 파일은 수십 초 걸릴 수 있어요)')
        const samples = await decodeTo16kMono(await file.arrayBuffer())
        durationSec = Math.round(samples.length / 16000)
        if (engine === 'groq') {
          segs = await transcribeSamplesWithGroq(samples, {
            apiKey: settings.groqApiKey, language: settings.language,
            onPart: (d, t) => { setStage(`Groq 분할 전사 중 (${d}/${t})`); setProgress((d / t) * 100) },
          })
        } else {
          const webgpu = await detectWebGPU()
          const model = webgpu ? settings.whisperModel : 'onnx-community/whisper-base'
          const eng = new WhisperLocalEngine()
          try {
            segs = await eng.transcribe(samples, {
              model, device: webgpu ? 'webgpu' : 'wasm', language: settings.language,
            }, onWhisperProgress)
          } finally {
            eng.dispose()
          }
        }
      }

      setStage('저장 중…')
      // 무의미한 조각('-', 공백 등)은 걸러 저장한다 — 전부 걸러지면 0개로 저장되어 빈 상태 UI가 안내한다.
      await replaceSegments(meetingId, dropHallucinatedRepeats(segs.filter(s => isMeaningfulText(s.text))).map(s => ({
        ...s, source: engine, isFinal: true,
      })))
      await finishMeeting(meetingId, durationSec)
      navigate(`/meeting/${meetingId}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(GROQ_ENABLED && msg.includes('디코딩')
        ? `${msg} — Groq 경로는 원본을 그대로 전송하므로 성공할 수 있습니다.`
        : msg)
      setBusy(false); setStage(''); setProgress(null)
    }
  }

  return (
    <div>
      <h1>파일 업로드</h1>
      <p className="sub">녹음 파일을 올리면 자동으로 회의록을 만들어드려요.</p>
      {error && <div className="alert alert-err" role="alert" style={{ marginTop: 14 }}>{error}</div>}

      <div
        className={`dropzone${dragOver ? ' drag-over' : ''}`}
        style={{ marginTop: 18 }}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault(); setDragOver(false)
          const f = e.dataTransfer.files[0]
          if (f) setFile(f)
        }}
      >
        <div className="icon">↑</div>
        <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>
          {file ? file.name : '클릭하거나 파일을 끌어다 놓으세요'}
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          m4a · mp3 · wav · webm · ogg {file && `(${(file.size / 1e6).toFixed(1)}MB)`}
        </div>
        <input ref={inputRef} data-testid="file-input" type="file" hidden
          accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg"
          onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </div>

      {GROQ_ENABLED && (
        <details className="card advanced" style={{ marginTop: 16 }}>
          <summary>고급 설정</summary>
          <h2>전사 엔진</h2>
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input type="radio" id="eng-whisper" name="engine"
              checked={engine === 'whisper'} onChange={() => setEngine('whisper')} />
            <label htmlFor="eng-whisper">브라우저 Whisper <span className="hint">— 음성이 기기 밖으로 나가지 않음 · 최초 1회 모델 다운로드</span></label>
          </div>
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="radio" id="eng-groq" name="engine" disabled={!hasGroqKey}
              checked={engine === 'groq'} onChange={() => setEngine('groq')} />
            <label htmlFor="eng-groq">Groq (내 키) <span className="hint">
              — 빠름 · 오디오가 Groq로 전송됨</span>{!hasGroqKey && <> · <Link to="/settings">설정에서 키를 등록하세요</Link></>}</label>
          </div>
          <p className="hint">1시간 이상 긴 파일이나 모바일에서는 Groq 키 사용(설정)이 훨씬 빠르고 안정적입니다.</p>
        </details>
      )}

      <p style={{ marginTop: 18 }}>
        <button className="btn btn-primary" disabled={!file || busy} onClick={() => void start()}>
          {busy ? '처리 중…' : '전사 시작'}
        </button>
      </p>
      {!busy && (
        <p className="hint">{engine === 'groq'
          ? '내 Groq 키로 빠르게 전사해요 (오디오가 Groq 서버로 전송됩니다)'
          : '이 기기 안에서 처리돼요 (음성이 밖으로 나가지 않습니다)'}</p>
      )}

      {busy && (
        <section className="card" style={{ marginTop: 8 }}>
          <div className="sub">{stage}</div>
          {progress !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <div className="progress" style={{ flex: 1 }}><i style={{ width: `${progress}%` }} /></div>
              <span className="progress-label">{Math.round(progress)}%</span>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
