import { toDocxBlob } from './docx'
import type { Meeting, TranscriptSegment, Summary } from '../types'

const meeting: Meeting = {
  id: 'm1', title: '주간회의', createdAt: new Date('2026-07-06T10:00:00').getTime(),
  durationSec: 3725, status: 'done', language: 'ko-KR',
  speakerNames: { SPK1: '김팀장' },
}
const segments: TranscriptSegment[] = [
  { meetingId: 'm1', startSec: 0, endSec: 5, text: '시작하겠습니다', source: 'whisper', isFinal: true, speaker: 'SPK1' },
  { meetingId: 'm1', startSec: 65, endSec: 70, text: '다음 안건입니다', source: 'whisper', isFinal: true },
]

test('DOCX Blob이 생성된다', async () => {
  const blob = await toDocxBlob(meeting, segments, [])
  expect(blob.size).toBeGreaterThan(1000)
  expect(blob.type).toContain('officedocument')
})

test('요약을 포함하면 문서 크기가 커진다', async () => {
  const summaries: Summary[] = [
    { meetingId: 'm1', template: 'minutes', markdown: '## 안건\n- 예산 검토\n- 일정 확정', provider: 'gemini-3.5-flash', createdAt: 1 },
  ]
  const without = await toDocxBlob(meeting, segments, [])
  const withSummary = await toDocxBlob(meeting, segments, summaries)
  expect(withSummary.size).toBeGreaterThan(without.size)
})
