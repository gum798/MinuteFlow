import { toMarkdown, toPlainText, exportFilename, downloadBlob } from './exporters'
import type { Meeting, TranscriptSegment } from '../types'

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

test('exportFilename은 날짜 프리픽스와 안전한 파일명', () => {
  expect(exportFilename(meeting, 'md')).toBe('2026-07-06-주간회의.md')
  expect(exportFilename({ ...meeting, title: 'a/b:c' }, 'txt')).toBe('2026-07-06-a_b_c.txt')
})

test('downloadBlob은 a 태그 클릭으로 저장을 트리거한다', () => {
  const click = vi.fn()
  const a = document.createElement('a')
  a.click = click
  vi.spyOn(document, 'createElement').mockReturnValueOnce(a)
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn(),
  })
  downloadBlob('t.md', new Blob(['x']))
  expect(a.download).toBe('t.md')
  expect(a.href).toContain('blob:fake')
  expect(click).toHaveBeenCalled()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
