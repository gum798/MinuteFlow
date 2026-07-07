import type { Meeting, TranscriptSegment } from '../types'
import { formatTimestamp } from '../format'

export type SummaryTemplate = 'minutes' | 'brief' | 'timeline'

export const TEMPLATE_LABELS: Record<SummaryTemplate, string> = {
  minutes: '회의록',
  brief: '짧은 요약',
  timeline: '타임라인',
}

const INSTRUCTIONS: Record<SummaryTemplate, string> = {
  minutes: `아래 회의 전사문을 바탕으로 한국어 회의록을 Markdown으로 작성해줘. 구성:
## 안건
## 논의 요지
## 결정사항
## 액션아이템 (담당자가 언급됐으면 함께)
전사문에 없는 내용은 지어내지 마.`,
  brief: `아래 회의 전사문을 한국어 3~5문장으로 요약해줘. 핵심 결론 위주로.`,
  timeline: `아래 회의 전사문을 시간순 타임라인으로 정리해줘. Markdown 목록으로, 각 항목은 "- **[MM:SS]** 내용" 형식.`,
}

export function buildSummaryPrompt(
  template: SummaryTemplate, meeting: Meeting, segments: TranscriptSegment[],
): string {
  const lines = segments.filter(s => s.isFinal).map(s => {
    const ts = `[${formatTimestamp(s.startSec)}]`
    const name = s.speaker ? ` (${meeting.speakerNames?.[s.speaker] ?? s.speaker})` : ''
    return `${ts}${name} ${s.text}`
  })
  return [
    INSTRUCTIONS[template],
    '',
    `회의 제목: ${meeting.title}`,
    `길이: ${formatTimestamp(meeting.durationSec)}`,
    '',
    '--- 전사문 ---',
    ...lines,
  ].join('\n')
}
