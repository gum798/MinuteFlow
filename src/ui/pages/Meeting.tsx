import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Meeting, TranscriptSegment, Summary } from '../../core/types'
import { getMeeting, getSegments, getMeetingAudio, updateMeetingTitle, updateSpeakerNames, softDeleteMeeting, restoreMeeting, purgeMeeting, getSummaries } from '../../core/store/meetings'
import { subscribeJobs, getJobs, type JobDoneDetail } from '../../core/jobs'
import { useUndoToast } from '../UndoToast'
import { Markdown } from '../Markdown'
import { toMarkdown, toPlainText, exportFilename, downloadBlob } from '../../core/export/exporters'
import { formatTimestamp } from '../../core/format'
import { loadSettings } from '../../core/settings'
import { buildSummaryPrompt, TEMPLATE_LABELS, type SummaryTemplate } from '../../core/summarize/prompts'
import { retranscribeMeeting, diarizeMeeting, summarizeMeeting, hasMeaningfulTranscript } from '../../core/meetingActions'
import { getRecordingState } from '../../core/recorder/session'
import { speakerColor } from '../../core/diarize/speakerColors'
import { GROQ_ENABLED, DOCX_ENABLED } from '../../core/features'

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const showUndoToast = useUndoToast()
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [title, setTitle] = useState('')
  const [audioAvailable, setAudioAvailable] = useState(false)
  const [summaries, setSummaries] = useState<Summary[]>([])
  const [template, setTemplate] = useState<SummaryTemplate>('minutes')
  const [copyToast, setCopyToast] = useState(false)
  // 재전사·화자 구분·요약은 전역 작업 스토어에 산다 → 페이지를 떠났다 와도 진행 상태가 유지된다.
  const jobs = useSyncExternalStore(subscribeJobs, getJobs)

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

  // 작업(재전사·화자 구분·요약)이 끝나면 — 이 회의가 마운트돼 있을 때만 — 결과를 다시 읽어
  // 세그먼트·요약·회의(제목/이름맵)를 갱신한다. 언마운트 중 완료돼도 DB엔 이미 반영돼 있어 안전.
  useEffect(() => {
    if (!id) return
    function onDone(e: Event): void {
      const detail = (e as CustomEvent<JobDoneDetail>).detail
      if (detail.meetingId !== id) return
      if (detail.error) { window.alert(detail.error); return }
      void (async () => {
        setSegments((await getSegments(id)).filter(s => s.isFinal))
        setSummaries(await getSummaries(id))
        const m = await getMeeting(id)
        if (m) { setMeeting(m); setTitle(m.title) }
      })()
    }
    window.addEventListener('minuteflow:job-done', onDone)
    return () => window.removeEventListener('minuteflow:job-done', onDone)
  }, [id])

  if (meeting === undefined) return <div><p className="sub">불러오는 중…</p></div>
  if (meeting === null) return <div><p className="sub">회의록을 찾을 수 없습니다.</p><Link to="/">홈으로</Link></div>

  // 이 회의에 진행 중인 작업(있다면 하나 — 버튼 상호배타). 진행 문구·버튼 비활성에 쓴다.
  const job = jobs.find(j => j.meetingId === meeting.id) ?? null

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
    // 실패 시 던진 예외는 runJob이 job-done(detail.error)로 넘겨 마운트된 화면에서만 알린다.
    // 성공 후 데이터 재로드(setSummaries/setMeeting/setTitle)는 job-done 리스너가 담당.
    // 버튼은 키·의미 있는 전사가 있을 때만 노출되므로 'no-key'/'no-content'는 실질적으로 드물지만,
    // 무의미 전사 상태에서 눌린 경우엔 잡 없이 'no-content'가 돌아오므로 여기서 직접 안내한다.
    const result = await summarizeMeeting(meeting.id, template)
    if (result === 'no-content') window.alert('요약할 대화 내용이 없어요.')
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
    // 성공 시 세그먼트·이름맵 재로드는 job-done 리스너가 담당. 오류는 runJob이 알림으로 넘긴다.
    // 빈 결과 안내는 결과를 바꾸지 않으므로 반환값으로 판단해 여기서 직접 알린다.
    const result = await retranscribeMeeting(meeting.id)
    if (result === 'empty') window.alert('전사 결과가 비어 있어 기존 내용을 유지합니다.')
  }

  async function diarize() {
    if (!meeting) return
    // 성공 시 세그먼트·회의 재로드는 job-done 리스너가 담당. 오류는 runJob이 알림으로 넘긴다.
    const result = await diarizeMeeting(meeting.id)
    if (result === 'empty') window.alert('화자를 구분할 수 없었습니다.')
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
        {DOCX_ENABLED && (
          <button className="btn btn-outline btn-sm" onClick={() => void exportDocx()}>DOCX 내보내기</button>
        )}
        <button className="btn btn-outline btn-sm" onClick={() => void downloadAudio()}>오디오 다운로드</button>
        {audioAvailable && (
          <>
            <button className="btn btn-outline btn-sm" disabled={job !== null} onClick={() => void retranscribe()}>
              {job?.kind === 'retranscribe' ? job.status : '고품질 재전사'}
            </button>
            {segments.length > 0 && (
              <button className="btn btn-outline btn-sm" disabled={job !== null} onClick={() => void diarize()}>
                {job?.kind === 'diarize' ? job.status : '화자 구분'}
              </button>
            )}
            <span className="hint">{GROQ_ENABLED && loadSettings().groqApiKey ? 'Groq 사용' : '브라우저 Whisper 사용'}</span>
          </>
        )}
        {hasMeaningfulTranscript(segments) && (
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
                <button className="btn btn-primary btn-sm" disabled={job !== null} onClick={() => void runSummarize()}>
                  {job?.kind === 'summarize' ? (job.status || '요약 중…') : 'AI 요약'}
                </button>
              )
              : (
                <button className="btn btn-outline btn-sm" onClick={() => void copyPrompt()}>AI 프롬프트 복사</button>
              )}
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--warn-fg)' }} disabled={job !== null} onClick={() => void removeMeeting()}>삭제</button>
      </div>
      {summaries.map(s => (
        <section key={s.id} className="card" style={{ marginBottom: 12 }}>
          <span className="badge badge-accent">{TEMPLATE_LABELS[s.template]}</span>
          <div className="md-body" style={{ marginTop: 8 }}><Markdown text={s.markdown} /></div>
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
