import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Meeting, TranscriptSegment, Summary } from '../../core/types'
import { getMeeting, getMeetingGroup, getSegments, getMeetingAudio, updateMeetingTitle, updateSpeakerNames, softDeleteMeeting, restoreMeeting, purgeMeeting, deleteMeetingAudio, getSummaries, replaceSegments } from '../../core/store/meetings'
import { subscribeJobs, getJobs, type JobDoneDetail } from '../../core/jobs'
import { useUndoToast } from '../UndoToast'
import { Markdown } from '../Markdown'
import { toMarkdown, toPlainText, exportFilename, downloadBlob } from '../../core/export/exporters'
import { formatTimestamp } from '../../core/format'
import { loadSettings, saveSettings } from '../../core/settings'
import { applyCorrections, upsertCorrection } from '../../core/corrections'
import { buildSummaryPrompt, TEMPLATE_LABELS, type SummaryTemplate } from '../../core/summarize/prompts'
import { retranscribeMeeting, diarizeMeeting, summarizeMeeting, retranscribeGroup, diarizeGroup, summarizeGroup, hasMeaningfulTranscript } from '../../core/meetingActions'
import { enqueue, runFinalPipeline } from '../../core/pipeline'
import { getRecordingState } from '../../core/recorder/session'
import { speakerColor } from '../../core/diarize/speakerColors'
import { groupConsecutiveBySpeaker } from '../../core/diarize/mergeSpeakerRuns'
import { canonicalSpeakerLabel, relabelSpeaker } from '../../core/diarize/mergeSpeaker'
import { GROQ_ENABLED, DOCX_ENABLED } from '../../core/features'

// 부 오름차순으로 각 부의 확정 세그먼트를 로드해 누적 durationSec offset을 startSec/endSec에 더한다.
// 반환 세그먼트는 표시·복사용 — DB 저장은 각 부의 원본(부-상대)로 이뤄진다.
async function loadUnifiedSegments(parts: Meeting[]): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = []
  let offset = 0
  for (const p of parts) {
    const segs = (await getSegments(p.id)).filter(s => s.isFinal)
    for (const s of segs) out.push({ ...s, startSec: s.startSec + offset, endSec: s.endSec + offset })
    offset += p.durationSec
  }
  return out
}

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const showUndoToast = useUndoToast()
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined)
  // 같은 분할 그룹의 모든 부(partIndex 오름차순). 전 부를 누적 offset으로 이어 하나의 연속 전사로 렌더한다.
  const [group, setGroup] = useState<Meeting[]>([])
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [title, setTitle] = useState('')
  const [audioAvailable, setAudioAvailable] = useState(false)
  const [summaries, setSummaries] = useState<Summary[]>([])
  const [template, setTemplate] = useState<SummaryTemplate>('minutes')
  const [copyToast, setCopyToast] = useState(false)
  // 자동 정리 재진입 방지: 클릭하면 잠그고 파이프라인이 끝나면 푼다. 전역 job이 뜨기 전·단계 사이의
  // 빈틈(job이 잠깐 없는 순간)에도 버튼을 잠가, 중복 파이프라인 실행을 막는다.
  const [autoBusy, setAutoBusy] = useState(false)
  // 전사문에서 드래그로 선택한 단어(1~40자). 값이 있으면 하단 보정 바를 띄운다.
  const [selectedWord, setSelectedWord] = useState<string | null>(null)
  const [correctToast, setCorrectToast] = useState(false)
  // 이름 변경 중인 화자 라벨(예: 'SPK1'). 값이 있으면 화자 이름 팝업을 띄운다. renameInput은 그 입력값.
  const [renamingSpeaker, setRenamingSpeaker] = useState<string | null>(null)
  const [renameInput, setRenameInput] = useState('')
  // 사용자가 아는 화자 수(선택). 비우면 자동 판별, 지정하면 그 수까지 강제 병합한다.
  const [numSpeakers, setNumSpeakers] = useState('')
  // 재전사·화자 구분·요약은 전역 작업 스토어에 산다 → 페이지를 떠났다 와도 진행 상태가 유지된다.
  const jobs = useSyncExternalStore(subscribeJobs, getJobs)

  useEffect(() => {
    if (!id) return
    setNumSpeakers('') // 회의가 바뀌면 이전 회의에서 지정한 화자 수가 새 회의로 새지 않게 초기화
    void (async () => {
      const m = await getMeeting(id)
      setMeeting(m ?? null)
      if (m) {
        setTitle(m.title)
        const g = await getMeetingGroup(m)
        setGroup(g)
        setSegments(await loadUnifiedSegments(g))
        setAudioAvailable((await getMeetingAudio(id)) !== null)
        setSummaries(await getSummaries(id))
      } else {
        setGroup([])
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
        const m2 = await getMeeting(id)
        if (m2) {
          const g = await getMeetingGroup(m2)
          setGroup(g)
          setSegments(await loadUnifiedSegments(g))
          setSummaries(await getSummaries(id))
          setMeeting(m2); setTitle(m2.title)
        }
      })()
    }
    window.addEventListener('minuteflow:job-done', onDone)
    return () => window.removeEventListener('minuteflow:job-done', onDone)
  }, [id])

  if (meeting === undefined) return <div><p className="sub">불러오는 중…</p></div>
  if (meeting === null) return <div><p className="sub">회의록을 찾을 수 없습니다.</p><Link to="/">홈으로</Link></div>

  // 이 그룹에 진행 중인 작업(있다면 하나 — 버튼 상호배타). 진행 문구·버튼 비활성에 쓴다.
  const job = jobs.find(j => group.some(p => p.id === j.meetingId)) ?? null

  // 통합 뷰의 길이는 그룹 전 부의 합(단일 회의면 그 회의 길이 그대로).
  const totalDurationSec = (group.length > 0 ? group : [meeting]).reduce((sum, p) => sum + p.durationSec, 0)

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
    // 통합 뷰에선 여러 부가 한 회의이므로, 부가 여럿이면 전체를 통합 요약한다(마지막 부에 저장·표시).
    const result = group.length > 1
      ? await summarizeGroup(group.map(p => p.id), template)
      : await summarizeMeeting(meeting.id, template)
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

  // 재전사 → 화자 구분 → AI 요약(키 있을 때)을 한 번에. 각 단계는 전역 잡으로 진행 표시되고,
  // 결과 재로드는 job-done 리스너가 담당. 전역 큐(enqueue)로 백그라운드 파이프라인과 직렬화된다.
  async function autoProcess() {
    if (!meeting || autoBusy || job) return // 클릭~첫 잡 등록 사이 빈틈에 두 번 눌려 파이프라인이 중복 실행되는 것 방지
    if (segments.length > 0 && !window.confirm('기존 전사를 새 결과로 교체하고 화자 구분·요약까지 진행할까요?')) return
    // 한 단계(재전사·화자 구분)가 실패해도 다음 단계로 넘어가도록 견고한 파이프라인을 재사용한다.
    // (예: 일부 브라우저에서 화자 구분이 실패해도 요약은 진행). 완료/실패는 전역 토스트로 알림.
    // autoBusy는 잡이 뜨기 전 빈틈과 단계 사이 빈틈에도 버튼을 잠가 둔다(파이프라인 종료 시 해제).
    setAutoBusy(true)
    // 통합 뷰에선 그룹 전체를 처리한다(부가 여럿이면 runFinalPipeline이 통합 재전사·화자 구분·통합 요약으로 라우팅).
    const ids = group.length > 0 ? group.map(p => p.id) : [meeting.id]
    void enqueue(() => runFinalPipeline(ids, template)).catch(() => {}).finally(() => setAutoBusy(false))
  }

  async function retranscribe() {
    if (!meeting || !window.confirm('기존 전사를 새 결과로 교체할까요?')) return
    // 성공 시 세그먼트·이름맵 재로드는 job-done 리스너가 담당. 오류는 runJob이 알림으로 넘긴다.
    // 빈 결과 안내는 결과를 바꾸지 않으므로 반환값으로 판단해 여기서 직접 알린다.
    // 통합 뷰에선 부가 여럿이면 전체를 통합 재전사(엔진 1회 로드).
    if (group.length > 1) {
      if (await retranscribeGroup(group.map(p => p.id)) === 'no-audio') window.alert('재전사할 오디오가 없습니다.')
      return
    }
    const result = await retranscribeMeeting(meeting.id)
    if (result === 'empty') window.alert('전사 결과가 비어 있어 기존 내용을 유지합니다.')
    else if (result === 'too-long') window.alert('녹음이 너무 길어(2시간 초과) 브라우저에서 재전사할 수 없어요. 기존 자막을 그대로 쓰거나, 더 짧게 나눠 녹음해주세요.')
  }

  async function diarize() {
    if (!meeting) return
    const n = parseInt(numSpeakers, 10)
    const wanted = Number.isInteger(n) && n >= 1 && n <= 99 ? n : undefined
    // 성공 시 세그먼트·회의 재로드는 job-done 리스너가 담당. 오류는 runJob이 알림으로 넘긴다.
    // 통합 뷰에선 부가 여럿이면 전체를 통합 화자 구분(부 경계 넘어 일관된 화자 라벨).
    if (group.length > 1) {
      if (await diarizeGroup(group.map(p => p.id), wanted) === 'empty') window.alert('화자를 구분할 수 없었습니다.')
      return
    }
    const result = await diarizeMeeting(meeting.id, wanted)
    if (result === 'empty') window.alert('화자를 구분할 수 없었습니다.')
    else if (result === 'too-long') window.alert('녹음이 너무 길어(2시간 초과) 브라우저에서 화자 구분을 할 수 없어요.')
  }

  // 배지 클릭 → 화자 이름 팝업을 연다. 입력창은 현재 지정된 이름으로 시작한다(없으면 빈값).
  function startRename(speaker: string) {
    setRenamingSpeaker(speaker)
    setRenameInput(meeting?.speakerNames?.[speaker] ?? '')
  }

  function closeRename() {
    setRenamingSpeaker(null)
    setRenameInput('')
  }

  // 팝업 입력창에 직접 친 이름을 이 화자에만 지정한다(철자가 같아도 병합하지 않음 — 다른 사람일 수 있으므로).
  async function applyRename(name: string) {
    if (!meeting || !renamingSpeaker) return
    const value = name.trim()
    if (!value) { closeRename(); return }
    const names = { ...meeting.speakerNames, [renamingSpeaker]: value }
    setMeeting({ ...meeting, speakerNames: names })
    // 전역 라벨이므로 그룹 모든 부의 이름맵을 동일하게 갱신
    for (const p of group) await updateSpeakerNames(p.id, { ...p.speakerNames, [renamingSpeaker]: value })
    // 갱신 후 그룹·회의를 DB에서 다시 읽어 group 상태를 최신화한다. 그러지 않으면 다음 이름 변경/병합이
    // 변경 전 group[i].speakerNames를 읽어 방금 지정한 이름을 덮어써 잃어버린다(updateSpeakerNames는 맵 전체 교체).
    const gm = await getMeeting(meeting.id)
    const g = gm ? await getMeetingGroup(gm) : group
    setGroup(g)
    if (gm) setMeeting(gm)
    closeRename()
  }

  // 기존 화자 이름을 "선택"하면 = 같은 사람이라는 뜻 → 내부 라벨까지 그 화자로 병합한다.
  // (지금 화자의 모든 발화를 대상 라벨로 재지정 → 색·연속 발화 묶기·요약이 한 사람으로 취급된다.)
  async function mergeSpeakerInto(name: string) {
    if (!meeting || !renamingSpeaker) return
    const from = renamingSpeaker
    const target = canonicalSpeakerLabel(meeting.speakerNames ?? {}, name, from)
    // 합칠 상대가 없으면(사실상 새 이름) 일반 이름 지정과 동일하게 처리한다.
    if (!target) { await applyRename(name); return }
    // 전역 라벨이므로 그룹 모든 부의 세그먼트를 relabel하고 이름맵을 갱신한다.
    for (const p of group) {
      const cur = await getSegments(p.id)
      await replaceSegments(p.id, relabelSpeaker(cur, from, target))
      const names = { ...(p.speakerNames ?? {}) }
      delete names[from]; names[target] = name.trim()
      await updateSpeakerNames(p.id, names)
    }
    const gm = await getMeeting(meeting.id)
    const g = gm ? await getMeetingGroup(gm) : group
    setGroup(g)
    setSegments(await loadUnifiedSegments(g))
    if (gm) setMeeting(gm)
    closeRename()
  }

  // 전사 카드에서 마우스 선택이 끝나면 선택 단어를 읽어 보정 바를 띄운다(1~40자만).
  function onTranscriptMouseUp() {
    const sel = window.getSelection()?.toString().trim() ?? ''
    if (sel.length >= 1 && sel.length <= 40) setSelectedWord(sel)
  }

  // 선택 단어를 사용자가 입력한 표기로 교정한다.
  // 1) 이 회의 모든 세그먼트에 즉시 적용(speaker 등 보존) 2) 설정 사전에 등록해 이후 전사에도 자동 반영.
  async function correctSelected() {
    if (!meeting || !selectedWord) return
    const from = selectedWord
    const input = window.prompt('올바른 단어로 바꿔주세요', from)
    const to = input?.trim() ?? ''
    if (!to || to === from) { setSelectedWord(null); return }
    // getSegments 결과(id·meetingId·speaker 포함)를 그대로 text만 치환해 다시 저장 → speaker 보존.
    // 통합 뷰이므로 그룹 전 부에 보정을 적용한다.
    for (const p of group) {
      const cur = await getSegments(p.id)
      await replaceSegments(p.id, cur.map(s => ({ ...s, text: applyCorrections(s.text, [{ from, to }]) })))
    }
    setSegments(await loadUnifiedSegments(group))
    saveSettings({ corrections: upsertCorrection(loadSettings().corrections, from, to) })
    setSelectedWord(null)
    setCorrectToast(true)
    setTimeout(() => setCorrectToast(false), 2000)
  }

  // 오디오만 삭제 — 전사·화자·요약은 유지. 화면에선 즉시 숨기고, 실제 삭제는 토스트 만료 시점에
  // 실행해 실행취소를 공짜로 만든다(회의 삭제와 동일 패턴). 그룹이면 전 부의 오디오를 지운다.
  function removeAudioOnly() {
    if (!meeting) return
    const ids = (group.length > 0 ? group : [meeting]).map(p => p.id)
    setAudioAvailable(false)
    showUndoToast({
      message: '오디오를 삭제했어요 — 전사·화자·요약은 유지됩니다.',
      onUndo: () => setAudioAvailable(true),
      onExpire: () => { void deleteMeetingAudio(ids) },
    })
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
        <span className="muted">길이: {formatTimestamp(totalDurationSec)}</span>
        {segments.length > 0 && (
          <span className={`badge ${segments[0].source === 'webspeech' ? 'badge-gray' : 'badge-accent'}`}>
            {segments[0].source === 'webspeech' ? '실시간 자막' : segments[0].source === 'whisper' ? 'Whisper 전사' : 'Groq 전사'}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        {audioAvailable && (
          <button className="btn btn-primary btn-sm" disabled={job !== null || autoBusy} onClick={() => void autoProcess()}>
            {job ? (job.status || '정리 중…') : autoBusy ? '정리 중…' : '✨ 자동 정리'}
          </button>
        )}
        <button className="btn btn-outline btn-sm" onClick={() => exportAs('md')}>Markdown 내보내기</button>
        <button className="btn btn-outline btn-sm" onClick={() => exportAs('txt')}>TXT 내보내기</button>
        {DOCX_ENABLED && (
          <button className="btn btn-outline btn-sm" onClick={() => void exportDocx()}>DOCX 내보내기</button>
        )}
        {audioAvailable && (
          <>
            <button className="btn btn-outline btn-sm" onClick={() => void downloadAudio()}>오디오 다운로드</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={job !== null || autoBusy} onClick={() => removeAudioOnly()}>오디오만 삭제</button>
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--warn-fg)' }} disabled={job !== null} onClick={() => void removeMeeting()}>삭제</button>
      </div>
      {(audioAvailable || hasMeaningfulTranscript(segments)) && (
        <details className="advanced" style={{ marginBottom: 18 }}>
          <summary>개별 실행 (재전사·화자 구분·요약 따로)</summary>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {audioAvailable && (
              <>
                <button className="btn btn-outline btn-sm" disabled={job !== null} onClick={() => void retranscribe()}>
                  {job?.kind === 'retranscribe' ? job.status : '고품질 재전사'}
                </button>
                {segments.length > 0 && (
                  <>
                    <button className="btn btn-outline btn-sm" disabled={job !== null} onClick={() => void diarize()}>
                      {job?.kind === 'diarize' ? job.status : '화자 구분'}
                    </button>
                    <input
                      className="input"
                      style={{ width: 110 }}
                      type="number"
                      min={1}
                      max={99}
                      placeholder="화자 수(자동)"
                      aria-label="화자 수"
                      disabled={job !== null}
                      value={numSpeakers}
                      onChange={e => setNumSpeakers(e.target.value)}
                    />
                  </>
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
                    <button className="btn btn-outline btn-sm" disabled={job !== null} onClick={() => void runSummarize()}>
                      {job?.kind === 'summarize' ? (job.status || '요약 중…') : 'AI 요약'}
                    </button>
                  )
                  : (
                    <button className="btn btn-outline btn-sm" onClick={() => void copyPrompt()}>AI 프롬프트 복사</button>
                  )}
              </>
            )}
          </div>
        </details>
      )}
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
        <section className="card" onMouseUp={onTranscriptMouseUp}>
          {groupConsecutiveBySpeaker(segments).map(run => {
            const color = run.speaker ? speakerColor(run.speaker) : null
            return (
              // 같은 화자의 연속 발화는 한 묶음으로: 배지 1개 + 각 발화를 [MM:SS] 텍스트 줄로.
              <div
                key={run.items[0].id}
                className="row"
                style={{ justifyContent: 'flex-start', gap: 10, alignItems: 'baseline', marginBottom: 6 }}
              >
                {run.speaker && color && (
                  <button
                    type="button"
                    className="badge"
                    style={{ background: color.bg, color: color.fg }}
                    onClick={() => startRename(run.speaker!)}
                  >
                    {meeting.speakerNames?.[run.speaker] ?? run.speaker}
                  </button>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {run.items.map(s => (
                    <p key={s.id} className="row" style={{ justifyContent: 'flex-start', gap: 10, alignItems: 'baseline' }}>
                      <span className="seg-time">[{formatTimestamp(s.startSec)}]</span> {s.text}
                    </p>
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}
      {copyToast && <div className="toast">복사했어요! AI 채팅에 붙여넣어 주세요.</div>}
      {selectedWord && (
        <div className="toast">
          <button type="button" className="toast-action" style={{ marginLeft: 0 }} onClick={() => void correctSelected()}>
            {`'${selectedWord}' 보정하기`}
          </button>
          <button type="button" className="toast-action" aria-label="닫기" onClick={() => setSelectedWord(null)}>×</button>
        </div>
      )}
      {correctToast && <div className="toast">보정했어요 · 앞으로 자동으로 반영됩니다</div>}
      {renamingSpeaker && (
        <div
          role="dialog"
          aria-label="화자 이름"
          onClick={closeRename}
          style={{
            position: 'fixed', inset: 0, zIndex: 200, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 16,
            background: 'rgba(15, 18, 34, 0.35)',
          }}
        >
          <div className="card" style={{ width: 320, maxWidth: '100%' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px' }}>화자 이름</h3>
            {(() => {
              // 기존 화자 이름들(지금 바꾸는 라벨 제외) — 하나를 "선택"하면 그 화자로 병합된다.
              // 라벨 기준으로 걸러야, 다른 라벨이 우연히 같은 이름을 가진 경우에도 그 화자로 병합할 수 있다.
              const existing = [...new Set(
                Object.entries(meeting.speakerNames ?? {})
                  .filter(([label]) => label !== renamingSpeaker)
                  .map(([, n]) => n.trim())
                  .filter(Boolean),
              )]
              return existing.length > 0 && (
                <div className="row" style={{ flexWrap: 'wrap', gap: 8, justifyContent: 'flex-start', marginBottom: 12 }}>
                  {existing.map(name => (
                    <button key={name} type="button" className="btn btn-outline btn-sm" onClick={() => void mergeSpeakerInto(name)}>
                      {name}
                    </button>
                  ))}
                </div>
              )
            })()}
            <input
              className="input"
              aria-label="새 화자 이름"
              placeholder="새 이름 입력"
              value={renameInput}
              autoFocus
              onChange={e => setRenameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void applyRename(renameInput) }}
            />
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={closeRename}>취소</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void applyRename(renameInput)}>저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
