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

// 자동 생성된 기본 제목인지 판별한다.
// createMeeting: '회의 YYYY-MM-DD HH:mm', 고아 오디오 복구: '복구된 녹음 YYYY-MM-DD HH:mm'
const DEFAULT_TITLE_RE = /^(회의|복구된 녹음) \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
export function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_RE.test(title)
}

const TITLE_INSTRUCTION = '응답의 첫 줄에 `제목: <내용을 대표하는 간결한 회의 제목(20자 이내)>` 을 쓰고, 빈 줄 하나 뒤 본문을 작성해줘.'

export function buildSummaryPrompt(
  template: SummaryTemplate, meeting: Meeting, segments: TranscriptSegment[],
  opts?: { suggestTitle?: boolean },
): string {
  const lines = segments.filter(s => s.isFinal).map(s => {
    const ts = `[${formatTimestamp(s.startSec)}]`
    const name = s.speaker ? ` (${meeting.speakerNames?.[s.speaker] ?? s.speaker})` : ''
    return `${ts}${name} ${s.text}`
  })
  return [
    ...(opts?.suggestTitle ? [TITLE_INSTRUCTION, ''] : []),
    INSTRUCTIONS[template],
    '',
    `회의 제목: ${meeting.title}`,
    `길이: ${formatTimestamp(meeting.durationSec)}`,
    '',
    '--- 전사문 ---',
    ...lines,
  ].join('\n')
}

// 응답에서 '제목: ...' 첫 줄을 떼어낸다(순수 함수).
// 첫 비어있지 않은 줄이 매치되면 제목(60자 클램프)과 그 줄·직후 빈 줄들을 제거한 본문을 반환.
// 미매치면 { title: null, body: 원문 } — AI가 형식을 안 지킨 경우 그대로 둔다.
const SUGGESTED_TITLE_RE = /^제목[:：]\s*(.+)$/
export function extractSuggestedTitle(markdown: string): { title: string | null; body: string } {
  const lines = markdown.split('\n')
  let head = 0
  while (head < lines.length && lines[head].trim() === '') head++
  const match = head < lines.length ? SUGGESTED_TITLE_RE.exec(lines[head].trim()) : null
  if (!match) return { title: null, body: markdown }
  const title = match[1].trim().slice(0, 60)
  let rest = head + 1
  while (rest < lines.length && lines[rest].trim() === '') rest++
  return { title, body: lines.slice(rest).join('\n') }
}
