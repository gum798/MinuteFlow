import type { Meeting, TranscriptSegment } from '../types'
import { formatTimestamp } from '../format'

export type SummaryTemplate = 'minutes' | 'brief' | 'timeline'

export const TEMPLATE_LABELS: Record<SummaryTemplate, string> = {
  minutes: '회의록',
  brief: '짧은 요약',
  timeline: '타임라인',
}

const OUTPUT_RULES = `출력 규칙 (반드시 지켜):
- 인사말·머리말·맺음말·설명 없이 결과 본문만 출력한다. ("작성했습니다" 같은 문장 금지)
- 최상위 제목(# ...)은 쓰지 않는다. 앱이 제목을 따로 표시한다.
- 전사문에 없는 내용은 지어내지 않는다. 특히 결정·액션아이템은 전사문에서 실제로 합의·지시된 것만 적고, 추측·일반론으로 채우지 않는다.
- 대화가 짧거나 잡담·인사뿐이면 억지로 항목을 만들지 말고, 실제 오간 내용만 간결히 정리한다.`

const INSTRUCTIONS: Record<SummaryTemplate, string> = {
  minutes: `아래 회의 전사문을 바탕으로 한국어 회의록을 Markdown으로 작성한다. 아래 섹션 중 전사문에 실제 내용이 있는 것만 포함한다(내용이 없으면 그 섹션 자체를 생략):
## 안건
## 논의 요지
## 결정사항 (실제로 결정·합의된 것이 있을 때만)
## 액션아이템 (담당자·할 일이 언급됐을 때만)`,
  brief: `아래 회의 전사문을 한국어 3~5문장으로 요약한다. 핵심 결론 위주로.`,
  timeline: `아래 회의 전사문을 시간순 타임라인으로 정리한다. Markdown 목록으로, 각 항목은 "- **[MM:SS]** 내용" 형식.`,
}

// 자동 생성된 기본 제목인지 판별한다.
// createMeeting: '회의 YYYY-MM-DD HH:mm', 고아 오디오 복구: '복구된 녹음 YYYY-MM-DD HH:mm'
// 분할 녹음이면 기본 제목 뒤에 ' (N부)' 접미가 붙을 수 있다(예: '회의 2026-07-09 13:06 (3부)').
const DEFAULT_TITLE_RE = /^(회의|복구된 녹음) \d{4}-\d{2}-\d{2} \d{2}:\d{2}( \(\d+부\))?$/
export function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_RE.test(title)
}

const TITLE_INSTRUCTION = `이 회의는 아직 제목이 없다. 응답의 맨 첫 줄은 반드시 \`제목: \`로 시작하고, 전사문의 핵심 주제를 담은 구체적 제목(8~20자)을 쓴 뒤 빈 줄 하나를 두고 본문을 시작한다.
- 좋은 예: \`제목: 결제 모듈 출시 일정 점검\`, \`제목: 테스트 데이터 작성 방안 논의\`
- 금지: 날짜·시간·"회의"라는 단어만으로 된 제목 (예: "7월 8일 회의" 금지). 날짜·시간은 앱이 제목 뒤에 자동으로 붙이므로 제목에 넣지 않는다.`

// 여러 부로 나뉜 녹음을 통합 요약할 때 지시문 맨 앞에 붙인다.
const GROUP_INSTRUCTION = `아래 전사문은 여러 부(part)로 나뉘어 연속 녹음된 하나의 회의다. 모든 부를 통합해 하나의 회의록으로 작성한다.`

// 한 부의 세그먼트를 '[MM:SS] (화자) 내용' 줄들로 직렬화한다.
function transcriptLines(meeting: Meeting, segments: TranscriptSegment[]): string[] {
  return segments.filter(s => s.isFinal).map(s => {
    const ts = `[${formatTimestamp(s.startSec)}]`
    const name = s.speaker ? ` (${meeting.speakerNames?.[s.speaker] ?? s.speaker})` : ''
    return `${ts}${name} ${s.text}`
  })
}

export function buildSummaryPrompt(
  template: SummaryTemplate, meeting: Meeting, segments: TranscriptSegment[],
  opts?: { suggestTitle?: boolean },
): string {
  // 기본 제목(자동 생성)은 프롬프트에 넣지 않는다 — 모델이 무의미한 제목을 헤딩으로 메아리치는 것 방지
  const titleMeta = isDefaultTitle(meeting.title) ? [] : [`회의 제목: ${meeting.title}`]
  return [
    INSTRUCTIONS[template],
    '',
    OUTPUT_RULES,
    ...(opts?.suggestTitle ? ['', TITLE_INSTRUCTION] : []),
    '',
    ...titleMeta,
    `길이: ${formatTimestamp(meeting.durationSec)}`,
    '',
    '--- 전사문 ---',
    ...transcriptLines(meeting, segments),
  ].join('\n')
}

/**
 * 여러 부를 통합해 하나의 회의록을 만드는 프롬프트를 만든다.
 * 지시문·출력규칙·제목지시는 단일 요약과 동일하게 재사용하고, 본문만 부마다 '--- N부 전사문 ---'로 나눈다.
 * 부별 타임스탬프는 부 시작 기준이므로 그 점을 한 줄 명시한다.
 */
export function buildGroupSummaryPrompt(
  template: SummaryTemplate,
  parts: { meeting: Meeting; segments: TranscriptSegment[] }[],
  opts?: { suggestTitle?: boolean },
): string {
  const sections = parts.flatMap((part, i) => {
    const n = part.meeting.partIndex ?? i + 1
    return [`--- ${n}부 전사문 ---`, ...transcriptLines(part.meeting, part.segments)]
  })
  // 제목 메타는 첫 부 기준(사용자 지정 제목만) — 기본 제목은 넣지 않는다.
  const firstTitle = parts[0]?.meeting.title
  const titleMeta = firstTitle && !isDefaultTitle(firstTitle) ? [`회의 제목: ${firstTitle}`] : []
  const totalDuration = parts.reduce((n, p) => n + p.meeting.durationSec, 0)
  return [
    GROUP_INSTRUCTION,
    '',
    INSTRUCTIONS[template],
    '',
    OUTPUT_RULES,
    ...(opts?.suggestTitle ? ['', TITLE_INSTRUCTION] : []),
    '',
    '타임스탬프는 각 부 시작 기준입니다.',
    ...titleMeta,
    `길이: ${formatTimestamp(totalDuration)}`,
    '',
    ...sections,
  ].join('\n')
}

// 응답에서 '제목: ...' 첫 줄을 떼어낸다(순수 함수).
// 첫 비어있지 않은 줄이 매치되면 제목(60자 클램프)과 그 줄·직후 빈 줄들을 제거한 본문을 반환.
// 미매치면 { title: null, body: 원문 } — AI가 형식을 안 지킨 경우 그대로 둔다.
const SUGGESTED_TITLE_RE = /^제목[:：]\s*(.+)$/
const TITLE_SCAN_LINES = 10
export function extractSuggestedTitle(markdown: string): { title: string | null; body: string } {
  const lines = markdown.split('\n')
  const limit = Math.min(lines.length, TITLE_SCAN_LINES)
  for (let i = 0; i < limit; i++) {
    const match = SUGGESTED_TITLE_RE.exec(lines[i].trim())
    if (!match) continue
    const title = match[1].trim().slice(0, 60)
    let rest = i + 1
    while (rest < lines.length && lines[rest].trim() === '') rest++
    // 제목 줄 이전의 프리앰블(인사말 등)은 본문에서 제거
    return { title, body: lines.slice(rest).join('\n') }
  }
  return { title: null, body: markdown }
}

// AI 제목 뒤에 회의 시각을 붙인다 — 예: '결제 일정 점검 (2026-07-08 15:58)'
export function withDateSuffix(title: string, createdAt: number): string {
  const d = new Date(createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${title} (${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())})`
}
