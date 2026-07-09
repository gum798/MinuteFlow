import { buildSummaryPrompt, extractSuggestedTitle, isDefaultTitle, TEMPLATE_LABELS } from './prompts'
import type { Meeting, TranscriptSegment } from '../types'

const meeting: Meeting = {
  id: 'm1', title: '주간회의', createdAt: 0, durationSec: 600, status: 'done',
  language: 'ko-KR', speakerNames: { SPK1: '김팀장' },
}
const segments: TranscriptSegment[] = [
  { meetingId: 'm1', startSec: 0, endSec: 5, text: '시작합니다', source: 'whisper', isFinal: true, speaker: 'SPK1' },
  { meetingId: 'm1', startSec: 65, endSec: 70, text: '네 알겠습니다', source: 'whisper', isFinal: true, speaker: 'SPK2' },
  { meetingId: 'm1', startSec: 80, endSec: 85, text: '무화자 발언', source: 'whisper', isFinal: true },
]

test('전사문이 타임스탬프·화자 이름과 함께 직렬화된다', () => {
  const p = buildSummaryPrompt('minutes', meeting, segments)
  expect(p).toContain('[00:00] (김팀장) 시작합니다')   // speakerNames 치환
  expect(p).toContain('[01:05] (SPK2) 네 알겠습니다')  // 미치환 라벨 그대로
  expect(p).toContain('[01:20] 무화자 발언')           // 화자 없으면 괄호 생략
  expect(p).toContain('주간회의')
})

test('템플릿별 지시문이 다르다', () => {
  const minutes = buildSummaryPrompt('minutes', meeting, segments)
  const brief = buildSummaryPrompt('brief', meeting, segments)
  const timeline = buildSummaryPrompt('timeline', meeting, segments)
  expect(minutes).toContain('결정사항')
  expect(minutes).toContain('액션아이템')
  expect(brief).toContain('3~5문장')
  expect(timeline).toContain('시간순')
  expect(new Set([minutes, brief, timeline]).size).toBe(3)
})

test('TEMPLATE_LABELS', () => {
  expect(TEMPLATE_LABELS.minutes).toBe('회의록')
})

test('isDefaultTitle: 자동 생성 제목만 참', () => {
  expect(isDefaultTitle('회의 2026-07-06 14:30')).toBe(true)       // createMeeting 기본
  expect(isDefaultTitle('복구된 녹음 2026-07-06 14:30')).toBe(true) // 고아 오디오 복구
  expect(isDefaultTitle('주간 제품 회의')).toBe(false)              // 사용자 지정
  expect(isDefaultTitle('recording_2026-07-06.webm')).toBe(false)  // 업로드 파일명풍
  expect(isDefaultTitle('회의 2026-07-06')).toBe(false)            // 시각 없는 부분 매치
})

test('suggestTitle 옵션이면 제목 지시문이 붙는다', () => {
  const without = buildSummaryPrompt('minutes', meeting, segments)
  const withTitle = buildSummaryPrompt('minutes', meeting, segments, { suggestTitle: true })
  expect(without).not.toContain('맨 첫 줄은 반드시')
  expect(withTitle).toContain('맨 첫 줄은 반드시')
  expect(withTitle).toContain('금지: 날짜')
  expect(withTitle).toContain('결정사항') // 기존 지시문도 유지
})

test('extractSuggestedTitle: 제목 줄을 떼어낸다', () => {
  const r = extractSuggestedTitle('제목: 주간 제품 회의\n\n## 요약\n내용')
  expect(r.title).toBe('주간 제품 회의')
  expect(r.body).toBe('## 요약\n내용')
  expect(r.body).not.toContain('제목:')
})

test('extractSuggestedTitle: 미매치면 원문 그대로', () => {
  const md = '## 요약\n내용'
  const r = extractSuggestedTitle(md)
  expect(r.title).toBeNull()
  expect(r.body).toBe(md)
})

test('extractSuggestedTitle: 제목은 60자로 클램프', () => {
  const long = 'ㄱ'.repeat(80)
  const r = extractSuggestedTitle(`제목: ${long}\n\n본문`)
  expect(r.title).toHaveLength(60)
})

test('기본 제목은 프롬프트 메타데이터에서 제외된다 (메아리 방지)', () => {
  const def = { ...meeting, title: '회의 2026-07-08 15:58' }
  expect(buildSummaryPrompt('minutes', def, segments)).not.toContain('회의 2026-07-08 15:58')
  expect(buildSummaryPrompt('minutes', meeting, segments)).toContain('회의 제목: 주간회의')
})

test('출력 규칙(인사말 금지)이 모든 템플릿에 포함된다', () => {
  for (const t of ['minutes', 'brief', 'timeline'] as const) {
    expect(buildSummaryPrompt(t, meeting, segments)).toContain('인사말·머리말')
  }
})

test('extractSuggestedTitle은 프리앰블 뒤의 제목 줄도 찾고 프리앰블을 버린다', () => {
  const raw = '요청하신 회의록입니다.\n\n제목: 결제 일정 점검\n\n## 안건\n내용'
  const { title, body } = extractSuggestedTitle(raw)
  expect(title).toBe('결제 일정 점검')
  expect(body).toBe('## 안건\n내용')
  expect(body).not.toContain('요청하신')
})
