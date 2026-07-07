import { toMarkdown, toPlainText, exportFilename, downloadBlob } from './exporters'
import type { Meeting, TranscriptSegment, Summary } from '../types'

const meeting: Meeting = {
  id: 'm1', title: '주간회의', createdAt: new Date('2026-07-06T10:00:00').getTime(),
  durationSec: 3725, status: 'done', language: 'ko-KR',
}
const segments: TranscriptSegment[] = [
  { meetingId: 'm1', startSec: 0, endSec: 5, text: '시작하겠습니다', source: 'webspeech', isFinal: true },
  { meetingId: 'm1', startSec: 5, endSec: 8, text: '(중간)', source: 'webspeech', isFinal: false },
  { meetingId: 'm1', startSec: 65, endSec: 70, text: '다음 안건입니다', source: 'webspeech', isFinal: true },
]

test('toMarkdown은 제목·메타·final 세그먼트만 포함한다', () => {
  const md = toMarkdown(meeting, segments)
  expect(md).toContain('# 주간회의')
  expect(md).toContain('1:02:05') // durationSec
  expect(md).toContain('**[00:00]** 시작하겠습니다')
  expect(md).toContain('**[01:05]** 다음 안건입니다')
  expect(md).not.toContain('(중간)')
})

test('toPlainText는 타임스탬프와 텍스트를 줄 단위로', () => {
  const txt = toPlainText(meeting, segments)
  expect(txt).toContain('[00:00] 시작하겠습니다')
  expect(txt).not.toContain('#')
})

test('화자가 있으면 이름과 함께 내보낸다', () => {
  const m2 = { ...meeting, speakerNames: { SPK1: '김팀장' } }
  const segs = [
    { meetingId: 'm1', startSec: 0, endSec: 5, text: '시작', source: 'whisper', isFinal: true, speaker: 'SPK1' },
    { meetingId: 'm1', startSec: 5, endSec: 9, text: '네', source: 'whisper', isFinal: true, speaker: 'SPK2' },
  ] as TranscriptSegment[]
  const md = toMarkdown(m2, segs)
  expect(md).toContain('**김팀장** — 시작')
  expect(md).toContain('**SPK2** — 네') // 이름 미지정은 라벨 그대로
  const txt = toPlainText(m2, segs)
  expect(txt).toContain('[00:00] 김팀장: 시작')
})

test('화자가 없으면 기존 형식 유지', () => {
  expect(toMarkdown(meeting, segments)).toContain('**[00:00]** 시작하겠습니다')
})

test('summaries를 넘기면 AI 요약 섹션을 전사 앞에 넣는다', () => {
  const summaries: Summary[] = [
    { meetingId: 'm1', template: 'minutes', markdown: '## 안건\n- 예산 검토', provider: 'gemini-3.5-flash', createdAt: 1 },
    { meetingId: 'm1', template: 'brief', markdown: '예산을 검토했다.', provider: 'gemini-3.5-flash', createdAt: 2 },
  ]
  const md = toMarkdown(meeting, segments, summaries)
  expect(md).toContain('## AI 요약 (회의록)')
  expect(md).toContain('## AI 요약 (짧은 요약)')
  expect(md).toContain('- 예산 검토')
  // 요약 섹션은 전사 섹션보다 앞에 온다
  expect(md.indexOf('## AI 요약')).toBeLessThan(md.indexOf('## 전사'))
  // 인자 없으면 요약 섹션 없음 (기존 호출 무영향)
  expect(toMarkdown(meeting, segments)).not.toContain('## AI 요약')
})

test('exportFilename은 날짜 프리픽스와 안전한 파일명', () => {
  expect(exportFilename(meeting, 'md')).toBe('2026-07-06-주간회의.md')
  expect(exportFilename({ ...meeting, title: 'a/b:c' }, 'txt')).toBe('2026-07-06-a_b_c.txt')
})

test('downloadBlob은 a 태그 클릭으로 저장을 트리거하고 revoke를 지연시킨다', () => {
  vi.useFakeTimers()
  const click = vi.fn()
  const a = document.createElement('a')
  a.click = click
  vi.spyOn(document, 'createElement').mockReturnValueOnce(a)
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL,
  })
  downloadBlob('t.md', new Blob(['x']))
  expect(a.download).toBe('t.md')
  expect(a.href).toContain('blob:fake')
  expect(click).toHaveBeenCalled()
  // revoke는 동기적으로 호출되지 않는다 (대용량 다운로드 절단 방지)
  expect(revokeObjectURL).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1_000)
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
