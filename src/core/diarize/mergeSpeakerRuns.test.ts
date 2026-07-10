import { groupConsecutiveBySpeaker } from './mergeSpeakerRuns'
import type { TranscriptSegment } from '../types'

function seg(startSec: number, text: string, speaker?: string): TranscriptSegment {
  return { meetingId: 'm', startSec, endSec: startSec + 1, text, source: 'whisper', isFinal: true, speaker }
}

test('연속된 동일 화자를 하나의 묶음으로 합친다', () => {
  const runs = groupConsecutiveBySpeaker([
    seg(0, '첫 발화', 'SPK1'),
    seg(1, '이어서', 'SPK1'),
    seg(2, '다른 사람', 'SPK2'),
  ])
  expect(runs).toHaveLength(2)
  expect(runs[0].speaker).toBe('SPK1')
  expect(runs[0].startSec).toBe(0)
  expect(runs[0].items.map(s => s.text)).toEqual(['첫 발화', '이어서'])
  expect(runs[1].speaker).toBe('SPK2')
  expect(runs[1].items.map(s => s.text)).toEqual(['다른 사람'])
})

test('speaker 없는(undefined) 세그먼트도 하나의 화자로 동일 취급해 묶는다', () => {
  const runs = groupConsecutiveBySpeaker([
    seg(0, '가'),
    seg(1, '나'),
  ])
  expect(runs).toHaveLength(1)
  expect(runs[0].speaker).toBeUndefined()
  expect(runs[0].items.map(s => s.text)).toEqual(['가', '나'])
})

test('같은 화자라도 사이에 다른 화자가 끼면 별도 묶음으로 나뉜다', () => {
  const runs = groupConsecutiveBySpeaker([
    seg(0, 'A', 'SPK1'),
    seg(1, 'B', 'SPK2'),
    seg(2, 'C', 'SPK1'),
  ])
  expect(runs).toHaveLength(3)
  expect(runs.map(r => r.speaker)).toEqual(['SPK1', 'SPK2', 'SPK1'])
})
