import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Meeting, TranscriptSegment, Summary } from '../../core/types'
import { getMeeting, getSegments, getMeetingAudio, updateMeetingTitle, replaceSegments, applySpeakers, updateSpeakerNames, softDeleteMeeting, restoreMeeting, purgeMeeting, saveSummary, getSummaries } from '../../core/store/meetings'
import { useUndoToast } from '../UndoToast'
import { toMarkdown, toPlainText, exportFilename, downloadBlob } from '../../core/export/exporters'
import { formatTimestamp } from '../../core/format'
import { loadSettings } from '../../core/settings'
import { buildSummaryPrompt, TEMPLATE_LABELS, type SummaryTemplate } from '../../core/summarize/prompts'
import { summarizeWithGemini } from '../../core/summarize/gemini'
import { decodeTo16kMono } from '../../core/audio/decode'
import { getRecordingState } from '../../core/recorder/session'
import { detectWebGPU, WhisperLocalEngine } from '../../core/stt/whisperLocal'
import { DiarizeEngine } from '../../core/diarize/diarizeLocal'
import { speakerColor } from '../../core/diarize/speakerColors'
import { transcribeSamplesWithGroq } from '../../core/stt/groq'
import { GROQ_ENABLED } from '../../core/features'

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const showUndoToast = useUndoToast()
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [title, setTitle] = useState('')
  const [audioAvailable, setAudioAvailable] = useState(false)
  const [retranscribing, setRetranscribing] = useState<string | null>(null)
  const [diarizing, setDiarizing] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Summary[]>([])
  const [template, setTemplate] = useState<SummaryTemplate>('minutes')
  const [summarizing, setSummarizing] = useState(false)
  const [copyToast, setCopyToast] = useState(false)

  useEffect(() => {
    if (!id) return
    void (async () => {
      const m = await getMeeting(id)
      setMeeting(m ?? null)
      if (m) {
        setTitle(m.title)
        setSegments((await getSegments(id)).filter(s => s.isFinal))
        setAudioAvailable((await getMeetingAudio(id)) !== null)
        setSummaries(await getSummaries(id))
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
    const content = format === 'md' ? toMarkdown(meeting, segments, summaries) : toPlainText(meeting, segments)
    const type = format === 'md' ? 'text/markdown' : 'text/plain'
    downloadBlob(exportFilename(meeting, format), new Blob([content], { type }))
  }

  async function exportDocx() {
    if (!meeting) return
    try {
      const { toDocxBlob } = await import('../../core/export/docx')
      downloadBlob(exportFilename(meeting, 'docx'), await toDocxBlob(meeting, segments, summaries))
    } catch {
      window.alert('DOCX 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.')
    }
  }

  async function runSummarize() {
    if (!meeting) return
    setSummarizing(true)
    try {
      const prompt = buildSummaryPrompt(template, meeting, segments)
      const markdown = await summarizeWithGemini(prompt, loadSettings().geminiApiKey)
      await saveSummary(meeting.id, template, markdown, 'gemini-3.5-flash')
      setSummaries(await getSummaries(meeting.id))
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setSummarizing(false)
    }
  }

  async function copyPrompt() {
    if (!meeting) return
    try {
      await navigator.clipboard.writeText(buildSummaryPrompt(template, meeting, segments))
      setCopyToast(true)
      setTimeout(() => setCopyToast(false), 2000)
    } catch {
      window.alert('클립보드 복사에 실패했어요. 다시 시도해주세요.')
    }
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
      if (GROQ_ENABLED && settings.groqApiKey) {
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
      // 재전사로 기존 speaker가 사라지므로 화자 이름 맵도 초기화 — 재-화자구분 시 옛 이름이 다른 화자에 잘못 붙는 것 방지.
      await updateSpeakerNames(meeting.id, {})
      setMeeting({ ...meeting, speakerNames: {} })
      setSegments((await getSegments(meeting.id)).filter(s => s.isFinal))
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setRetranscribing(null)
    }
  }

  async function diarize() {
    if (!meeting) return
    setDiarizing('오디오 준비 중…')
    const engine = new DiarizeEngine()
    try {
      const blob = await getMeetingAudio(meeting.id)
      if (!blob) return
      const samples = await decodeTo16kMono(await blob.arrayBuffer())
      setDiarizing('화자 구분 중…')
      const regions = await engine.diarize(samples, p => { if (p.kind === 'status') setDiarizing(p.message) })
      if (regions.length === 0) {
        window.alert('화자를 구분할 수 없었습니다.')
        return
      }
      await applySpeakers(meeting.id, regions)
      setSegments((await getSegments(meeting.id)).filter(s => s.isFinal))
      const m = await getMeeting(meeting.id)
      if (m) setMeeting(m)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      engine.dispose()
      setDiarizing(null)
    }
  }

  async function renameSpeaker(speaker: string) {
    if (!meeting) return
    const current = meeting.speakerNames?.[speaker] ?? speaker
    const input = window.prompt('이 화자의 이름을 입력하세요', current)
    if (!input || !input.trim()) return
    const names = { ...meeting.speakerNames, [speaker]: input.trim() }
    setMeeting({ ...meeting, speakerNames: names })
    await updateSpeakerNames(meeting.id, names)
  }

  async function removeMeeting() {
    if (!meeting) return
    if (getRecordingState().meetingId === meeting.id) {
      window.alert('녹음 중인 회의는 삭제할 수 없어요. 먼저 녹음을 종료해주세요.')
      return
    }
    const id = meeting.id
    await softDeleteMeeting(id)
    navigate('/')
    showUndoToast({
      message: '회의록을 삭제했어요.',
      // 홈으로 이동한 뒤이므로 여기서 refresh 불가 → 복구 후 이벤트로 홈 목록을 다시 로드시킨다
      onUndo: () => { void (async () => { await restoreMeeting(id); window.dispatchEvent(new Event('minuteflow:refresh')) })() },
      onExpire: () => { void purgeMeeting(id) },
    })
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
        <button className="btn btn-outline btn-sm" onClick={() => void exportDocx()}>DOCX 내보내기</button>
        <button className="btn btn-outline btn-sm" onClick={() => void downloadAudio()}>오디오 다운로드</button>
        {audioAvailable && (
          <>
            <button className="btn btn-outline btn-sm" disabled={retranscribing !== null || diarizing !== null} onClick={() => void retranscribe()}>
              {retranscribing ?? '고품질 재전사'}
            </button>
            {segments.length > 0 && (
              <button className="btn btn-outline btn-sm" disabled={retranscribing !== null || diarizing !== null} onClick={() => void diarize()}>
                {diarizing ?? '화자 구분'}
              </button>
            )}
            <span className="hint">{GROQ_ENABLED && loadSettings().groqApiKey ? 'Groq 사용' : '브라우저 Whisper 사용'}</span>
          </>
        )}
        {segments.length > 0 && (
          <>
            <select
              className="input"
              style={{ width: 'auto' }}
              aria-label="요약 템플릿"
              value={template}
              onChange={e => setTemplate(e.target.value as SummaryTemplate)}
            >
              {(Object.keys(TEMPLATE_LABELS) as SummaryTemplate[]).map(t => (
                <option key={t} value={t}>{TEMPLATE_LABELS[t]}</option>
              ))}
            </select>
            {loadSettings().geminiApiKey.trim()
              ? (
                <button className="btn btn-primary btn-sm" disabled={summarizing} onClick={() => void runSummarize()}>
                  {summarizing ? '요약 중…' : 'AI 요약'}
                </button>
              )
              : (
                <button className="btn btn-outline btn-sm" onClick={() => void copyPrompt()}>AI 프롬프트 복사</button>
              )}
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--warn-fg)' }} disabled={retranscribing !== null || diarizing !== null} onClick={() => void removeMeeting()}>삭제</button>
      </div>
      {summaries.map(s => (
        <section key={s.id} className="card" style={{ marginBottom: 12 }}>
          <span className="badge badge-accent">{TEMPLATE_LABELS[s.template]}</span>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{s.markdown}</div>
        </section>
      ))}
      {segments.length === 0 ? (
        <p className="sub">
          {audioAvailable
            ? '전사된 내용이 없습니다. [고품질 재전사] 버튼으로 지금 전사할 수 있어요.'
            : '전사된 내용이 없습니다.'}
        </p>
      ) : (
        <section className="card">
          {segments.map(s => {
            const color = s.speaker ? speakerColor(s.speaker) : null
            return (
              <p key={s.id} className="row" style={{ justifyContent: 'flex-start', gap: 10, alignItems: 'baseline' }}>
                {s.speaker && color && (
                  <button
                    type="button"
                    className="badge"
                    style={{ background: color.bg, color: color.fg }}
                    onClick={() => void renameSpeaker(s.speaker!)}
                  >
                    {meeting.speakerNames?.[s.speaker] ?? s.speaker}
                  </button>
                )}
                <span className="seg-time">[{formatTimestamp(s.startSec)}]</span> {s.text}
              </p>
            )
          })}
        </section>
      )}
      {copyToast && <div className="toast">복사했어요! AI 채팅에 붙여넣어 주세요.</div>}
    </div>
  )
}
