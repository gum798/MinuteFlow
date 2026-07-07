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

test('filterEmbeddable은 0.4초 미만을 제외한다', () => {
  const out = filterEmbeddable([
    { start: 0, end: 0.3 }, { start: 1, end: 1.5 }, { start: 2, end: 2.39 },
  ])
  expect(out).toEqual([{ start: 1, end: 1.5 }])
})
