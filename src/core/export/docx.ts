import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import type { Meeting, TranscriptSegment, Summary } from '../types'
import { formatTimestamp } from '../format'
import { TEMPLATE_LABELS } from '../summarize/prompts'

function meetingDate(meeting: Meeting): string {
  const d = new Date(meeting.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function displayName(meeting: Meeting, speaker: string): string {
  return meeting.speakerNames?.[speaker] ?? speaker
}

export async function toDocxBlob(
  meeting: Meeting, segments: TranscriptSegment[], summaries: Summary[] = [],
): Promise<Blob> {
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(meeting.title)] }),
    new Paragraph({ children: [new TextRun(`일시: ${meetingDate(meeting)}`)] }),
    new Paragraph({ children: [new TextRun(`길이: ${formatTimestamp(meeting.durationSec)}`)] }),
  ]

  for (const s of summaries) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun(`AI 요약 (${TEMPLATE_LABELS[s.template]})`)],
    }))
    for (const line of s.markdown.split('\n')) {
      children.push(new Paragraph({ children: [new TextRun(line)] }))
    }
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('전사')] }))
  for (const s of segments.filter(seg => seg.isFinal)) {
    const ts = `[${formatTimestamp(s.startSec)}]`
    const text = s.speaker ? `${ts} ${displayName(meeting, s.speaker)} — ${s.text}` : `${ts} ${s.text}`
    children.push(new Paragraph({ children: [new TextRun(text)] }))
  }

  const doc = new Document({ sections: [{ children }] })
  return Packer.toBlob(doc)
}
