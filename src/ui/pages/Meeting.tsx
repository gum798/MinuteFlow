import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Meeting, TranscriptSegment } from '../../core/types'
import { getMeeting, getSegments, getMeetingAudio, updateMeetingTitle, replaceSegments } from '../../core/store/meetings'
import { toMarkdown, toPlainText, exportFilename, downloadBlob } from '../../core/export/exporters'
import { formatTimestamp } from '../../core/format'
import { loadSettings } from '../../core/settings'
import { decodeTo16kMono } from '../../core/audio/decode'
import { detectWebGPU, WhisperLocalEngine } from '../../core/stt/whisperLocal'
import { transcribeSamplesWithGroq } from '../../core/stt/groq'

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>()
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [title, setTitle] = useState('')
  const [audioAvailable, setAudioAvailable] = useState(false)
  const [retranscribing, setRetranscribing] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    void (async () => {
      const m = await getMeeting(id)
      setMeeting(m ?? null)
      if (m) {
        setTitle(m.title)
        setSegments((await getSegments(id)).filter(s => s.isFinal))
        setAudioAvailable((await getMeetingAudio(id)) !== null)
      }
    })()
  }, [id])

  if (meeting === undefined) return <div><p className="sub">불러오는 중…</p></div>
  if (meeting === null) return <div><p className="sub">회의록을 찾을 수 없습니다.</p><Link to="/">홈으로</Link></div>

  async function saveTitle() {
    if (!meeting || !title.trim() || title === meeting.title) return
    await updateMeetingTitle(meeting.id, title.trim())
    setMeeting({ ...meeting, title: title.trim() })
  }

  function exportAs(format: 'md' | 'txt') {
    if (!meeting) return
    const content = format === 'md' ? toMarkdown(meeting, segments) : toPlainText(meeting, segments)
    const type = format === 'md' ? 'text/markdown' : 'text/plain'
    downloadBlob(exportFilename(meeting, format), new Blob([content], { type }))
  }

  async function downloadAudio() {
    if (!meeting) return
    const blob = await getMeetingAudio(meeting.id)
    if (!blob) return
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
    downloadBlob(exportFilename(meeting, ext), blob)
  }

  async function retranscribe() {
    if (!meeting || !window.confirm('기존 전사를 새 결과로 교체할까요?')) return
    const settings = loadSettings()
    setRetranscribing('오디오 준비 중…')
    try {
      const blob = await getMeetingAudio(meeting.id)
      if (!blob) return
      const samples = await decodeTo16kMono(await blob.arrayBuffer())
      let segs
      let source: 'whisper' | 'groq'
      if (settings.groqApiKey) {
        source = 'groq'
        setRetranscribing('Groq로 전사 중…')
        segs = await transcribeSamplesWithGroq(samples, {
          apiKey: settings.groqApiKey, language: settings.language,
          onPart: (d, t) => setRetranscribing(`Groq 분할 전사 중 (${d}/${t})`),
        })
      } else {
        source = 'whisper'
        const webgpu = await detectWebGPU()
        const eng = new WhisperLocalEngine()
        try {
          setRetranscribing('브라우저 Whisper로 전사 중… (모델 다운로드가 필요할 수 있어요)')
          segs = await eng.transcribe(samples, {
            model: webgpu ? settings.whisperModel : 'onnx-community/whisper-base',
            device: webgpu ? 'webgpu' : 'wasm',
            language: settings.language,
          }, p => { if (p.kind === 'status') setRetranscribing(p.message) })
        } finally { eng.dispose() }
      }
      if (segs.length === 0) {
        window.alert('전사 결과가 비어 있어 기존 내용을 유지합니다.')
        return
      }
      await replaceSegments(meeting.id, segs.map(s => ({ ...s, source, isFinal: true })))
      setSegments((await getSegments(meeting.id)).filter(s => s.isFinal))
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setRetranscribing(null)
    }
  }

  return (
    <div>
      <p><Link to="/">← 홈</Link></p>
      <input
        className="input"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={() => void saveTitle()}
        aria-label="회의 제목"
        style={{ fontSize: 20, fontWeight: 800, border: 'none', background: 'transparent', padding: 0 }}
      />
      <div className="row" style={{ justifyContent: 'flex-start', gap: 10, margin: '6px 0 18px' }}>
        <span className="muted">길이: {formatTimestamp(meeting.durationSec)}</span>
        {segments.length > 0 && (
          <span className={`badge ${segments[0].source === 'webspeech' ? 'badge-gray' : 'badge-accent'}`}>
            {segments[0].source === 'webspeech' ? '실시간 자막' : segments[0].source === 'whisper' ? 'Whisper 전사' : 'Groq 전사'}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 18 }}>
        <button className="btn btn-outline btn-sm" onClick={() => exportAs('md')}>Markdown 내보내기</button>
        <button className="btn btn-outline btn-sm" onClick={() => exportAs('txt')}>TXT 내보내기</button>
        <button className="btn btn-outline btn-sm" onClick={() => void downloadAudio()}>오디오 다운로드</button>
        {audioAvailable && (
          <>
            <button className="btn btn-outline btn-sm" disabled={retranscribing !== null} onClick={() => void retranscribe()}>
              {retranscribing ?? '고품질 재전사'}
            </button>
            <span className="hint">{loadSettings().groqApiKey ? 'Groq 사용' : '브라우저 Whisper 사용'}</span>
          </>
        )}
      </div>
      {segments.length === 0 ? (
        <p className="sub">전사된 내용이 없습니다. (실시간 자막 미지원 환경에서 녹음된 회의는 Plan 2의 파일 전사로 처리할 수 있습니다)</p>
      ) : (
        <section className="card">
          {segments.map(s => (
            <p key={s.id} className="row" style={{ justifyContent: 'flex-start', gap: 10, alignItems: 'baseline' }}>
              <span className="seg-time">[{formatTimestamp(s.startSec)}]</span> {s.text}
            </p>
          ))}
        </section>
      )}
    </div>
  )
}
