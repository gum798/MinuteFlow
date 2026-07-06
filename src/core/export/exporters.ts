import type { Meeting, TranscriptSegment } from '../types'
import { formatTimestamp } from '../format'

function finalSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter(s => s.isFinal)
}

function meetingDate(meeting: Meeting): string {
  const d = new Date(meeting.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function toMarkdown(meeting: Meeting, segments: TranscriptSegment[]): string {
  const lines = finalSegments(segments).map(
    s => `- **[${formatTimestamp(s.startSec)}]** ${s.text}`,
  )
  return [
    `# ${meeting.title}`,
    '',
    `- 일시: ${meetingDate(meeting)}`,
    `- 길이: ${formatTimestamp(meeting.durationSec)}`,
    '',
    '## 전사',
    '',
    ...lines,
    '',
  ].join('\n')
}

export function toPlainText(meeting: Meeting, segments: TranscriptSegment[]): string {
  const lines = finalSegments(segments).map(
    s => `[${formatTimestamp(s.startSec)}] ${s.text}`,
  )
  return [`${meeting.title} (${meetingDate(meeting)}, ${formatTimestamp(meeting.durationSec)})`, '', ...lines, ''].join('\n')
}

export function exportFilename(meeting: Meeting, ext: string): string {
  const safe = meeting.title.replace(/[\\/:*?"<>|]/g, '_')
  return `${meetingDate(meeting)}-${safe}.${ext}`
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
