import { sliceWindows, offsetRegions, filterEmbeddable, WINDOW_SAMPLES } from './windows'

test('10초 윈도우로 분할하고 잔여를 포함한다', () => {
  const samples = new Float32Array(WINDOW_SAMPLES * 2 + 16000) // 25초
  const ws = sliceWindows(samples)
  expect(ws.map(w => w.offsetSec)).toEqual([0, 10, 20])
  expect(ws[2].window.length).toBe(16000)
})

test('빈 입력은 빈 결과', () => {
  expect(sliceWindows(new Float32Array(0))).toEqual([])
})

test('offsetRegions는 전역 시각으로 이동한다', () => {
  expect(offsetRegions([{ start: 1.5, end: 3 }], 20)).toEqual([{ start: 21.5, end: 23 }])
})

test('filterEmbeddable은 1초 미만 짧은 조각을 제외한다(과분할 방지)', () => {
  const out = filterEmbeddable([
    { start: 0, end: 0.3 },   // 0.3초 — 제외
    { start: 1, end: 1.5 },   // 0.5초 — 제외
    { start: 2, end: 3.2 },   // 1.2초 — 유지
    { start: 4, end: 4.9 },   // 0.9초 — 제외
  ])
  expect(out).toEqual([{ start: 2, end: 3.2 }])
})

test('filterEmbeddable 경계: 1초 이상만 남긴다', () => {
  expect(filterEmbeddable([{ start: 0, end: 0.99 }])).toEqual([])
  expect(filterEmbeddable([{ start: 0, end: 1.0 }])).toEqual([{ start: 0, end: 1.0 }])
  expect(filterEmbeddable([{ start: 0, end: 1.5 }])).toEqual([{ start: 0, end: 1.5 }])
})
