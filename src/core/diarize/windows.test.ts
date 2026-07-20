import { sliceWindows, offsetRegions, filterEmbeddable, clampRegions, WINDOW_SAMPLES } from './windows'

test('10초 윈도우로 분할하고 마지막 부분 창은 0으로 채워 항상 창 크기를 유지한다', () => {
  const samples = new Float32Array(WINDOW_SAMPLES * 2 + 16000) // 25초
  samples[WINDOW_SAMPLES * 2] = 0.5 // 꼬리 창 첫 샘플 표식
  const ws = sliceWindows(samples)
  expect(ws.map(w => w.offsetSec)).toEqual([0, 10, 20])
  // 세그멘테이션 모델은 너무 짧은 입력에서 실패한다("Invalid input shape") — 모든 창은 같은 길이여야 한다.
  expect(ws.map(w => w.window.length)).toEqual([WINDOW_SAMPLES, WINDOW_SAMPLES, WINDOW_SAMPLES])
  expect(ws[2].window[0]).toBe(0.5) // 실제 데이터 보존
  expect(ws[2].window[16000]).toBe(0) // 이후는 0 패딩
})

test('창 크기의 배수보다 몇 샘플 긴 오디오(2샘플 꼬리)도 안전한 창을 만든다', () => {
  const samples = new Float32Array(WINDOW_SAMPLES + 2)
  samples[WINDOW_SAMPLES] = 0.5
  const ws = sliceWindows(samples)
  expect(ws).toHaveLength(2)
  expect(ws[1].window.length).toBe(WINDOW_SAMPLES)
  expect(ws[1].window[0]).toBe(0.5)
  expect(ws[1].window[2]).toBe(0)
})

test('한 창보다 짧은 오디오는 패딩된 단일 창', () => {
  const ws = sliceWindows(new Float32Array(16000 * 3)) // 3초
  expect(ws).toHaveLength(1)
  expect(ws[0].window.length).toBe(WINDOW_SAMPLES)
})

test('창 크기의 정확한 배수면 패딩 없이 그대로 분할한다', () => {
  const ws = sliceWindows(new Float32Array(WINDOW_SAMPLES * 2))
  expect(ws.map(w => w.window.length)).toEqual([WINDOW_SAMPLES, WINDOW_SAMPLES])
})

test('빈 입력은 빈 결과', () => {
  expect(sliceWindows(new Float32Array(0))).toEqual([])
})

test('offsetRegions는 전역 시각으로 이동한다', () => {
  expect(offsetRegions([{ start: 1.5, end: 3 }], 20)).toEqual([{ start: 21.5, end: 23 }])
})

test('clampRegions는 패딩 구간의 발화를 실제 오디오 길이로 자른다', () => {
  expect(clampRegions([
    { start: 0, end: 5 },      // 온전히 안쪽 — 유지
    { start: 22, end: 27 },    // 끝이 실제 길이(25초) 초과 — 25로 클램프
    { start: 25.5, end: 28 },  // 온전히 패딩 구간 — 제거
  ], 25)).toEqual([
    { start: 0, end: 5 },
    { start: 22, end: 25 },
  ])
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
