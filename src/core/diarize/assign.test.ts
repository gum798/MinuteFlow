import { assignSpeakers, type SpeakerRegion } from './assign'

const regions: SpeakerRegion[] = [
  { start: 0, end: 5, speaker: 'SPK1' },
  { start: 5, end: 8, speaker: 'SPK2' },
  { start: 8, end: 10, speaker: 'SPK1' },
]

test('최대 교집합 화자를 배정한다', () => {
  const out = assignSpeakers([{ startSec: 1, endSec: 4 }], regions)
  expect(out[0].speaker).toBe('SPK1')
})

test('여러 구간과 겹치면 화자별 합산으로 결정한다', () => {
  // 4~9초: SPK1과 교집합 (4~5)+(8~9)=2, SPK2와 (5~8)=3 → SPK2
  const out = assignSpeakers([{ startSec: 4, endSec: 9 }], regions)
  expect(out[0].speaker).toBe('SPK2')
})

test('교집합이 없으면 최근접 화자', () => {
  // 20~22초: 모든 구간과 무교집합 → midpoint 21에 가장 가까운 구간은 8~10(mid 9, SPK1)
  const out = assignSpeakers([{ startSec: 20, endSec: 22 }], regions)
  expect(out[0].speaker).toBe('SPK1')
})

test('regions가 비면 speaker 미부여', () => {
  const out = assignSpeakers([{ startSec: 0, endSec: 1 }], [])
  expect(out[0].speaker).toBeUndefined()
})

test('원본 세그먼트 필드를 보존한다', () => {
  const out = assignSpeakers([{ startSec: 1, endSec: 2, text: '안녕' } as never], regions)
  expect((out[0] as { text: string }).text).toBe('안녕')
})
