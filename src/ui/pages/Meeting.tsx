import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Meeting, TranscriptSegment } from '../../core/types'
import { getMeeting, getSegments, getMeetingAudio, updateMeetingTitle } from '../../core/store/meetings'
import { toMarkdown, toPlainText, exportFilename, downloadBlob } from '../../core/export/exporters'
import { formatTimestamp } from '../../core/format'

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>()
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (!id) return
    void (async () => {
      const m = await getMeeting(id)
      setMeeting(m ?? null)
      if (m) {
        setTitle(m.title)
        setSegments((await getSegments(id)).filter(s => s.isFinal))
      }
    })()
  }, [id])

  if (meeting === undefined) return <main><p>불러오는 중…</p></main>
  if (meeting === null) return <main><p>회의록을 찾을 수 없습니다.</p><Link to="/">홈으로</Link></main>

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

  return (
    <main>
      <p><Link to="/">← 홈</Link></p>
      <input value={title} onChange={e => setTitle(e.target.value)} onBlur={() => void saveTitle()} aria-label="회의 제목" />
      <p>길이: {formatTimestamp(meeting.durationSec)}</p>
      <p>
        <button onClick={() => exportAs('md')}>Markdown 내보내기</button>{' '}
        <button onClick={() => exportAs('txt')}>TXT 내보내기</button>{' '}
        <button onClick={() => void downloadAudio()}>오디오 다운로드</button>
      </p>
      {segments.length === 0 ? (
        <p>전사된 내용이 없습니다. (실시간 자막 미지원 환경에서 녹음된 회의는 Plan 2의 파일 전사로 처리할 수 있습니다)</p>
      ) : (
        <section>
          {segments.map(s => (
            <p key={s.id}>
              <small>[{formatTimestamp(s.startSec)}]</small> {s.text}
            </p>
          ))}
        </section>
      )}
    </main>
  )
}
