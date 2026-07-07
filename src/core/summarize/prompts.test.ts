import { buildSummaryPrompt, TEMPLATE_LABELS } from './prompts'
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
