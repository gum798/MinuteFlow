import { globalSpeakerRegions } from './globalSpeakers'

test('부 경계를 넘어 같은 화자는 같은 라벨을 받는다', () => {
  // 부0: 화자A(0..1), 화자B(1..2). 부1: 화자A(0..1) — 임베딩이 부0 화자A와 동일.
  const A = new Float32Array([1, 0]); const B = new Float32Array([0, 1])
  const parts = [
    { targets: [{ start: 0, end: 1 }, { start: 1, end: 2 }], embeddings: [A, B], offsetSec: 0 },
    { targets: [{ start: 0, end: 1 }], embeddings: [new Float32Array([1, 0])], offsetSec: 100 },
  ]
  const out = globalSpeakerRegions(parts)
  expect(out).toHaveLength(2)
  // 부-상대 시각 보존
  expect(out[0].map(r => [r.start, r.end])).toEqual([[0, 1], [1, 2]])
  expect(out[1].map(r => [r.start, r.end])).toEqual([[0, 1]])
  // 전역 라벨: 부0 첫 화자 = SPK1, 부0 둘째 화자 = SPK2, 부1 화자 = 부0 첫 화자와 동일 → SPK1
  expect(out[0][0].speaker).toBe('SPK1')
  expect(out[0][1].speaker).toBe('SPK2')
  expect(out[1][0].speaker).toBe('SPK1')
})

test('임베딩이 하나도 없으면 각 부 빈 배열', () => {
  const out = globalSpeakerRegions([{ targets: [], embeddings: [], offsetSec: 0 }])
  expect(out).toEqual([[]])
})

test('numSpeakers를 주면 그 수까지 강제 병합한다', () => {
  // 서로 직교(유사도 0)인 세 화자도 numSpeakers=1이면 전부 SPK1.
  const parts = [
    {
      targets: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }],
      embeddings: [new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0]), new Float32Array([0, 0, 1])],
      offsetSec: 0,
    },
  ]
  const out = globalSpeakerRegions(parts, 1)
  expect(out[0].map(r => r.speaker)).toEqual(['SPK1', 'SPK1', 'SPK1'])
})
