import { cosineSim, clusterEmbeddings, labelClusters } from './cluster'

const A = new Float32Array([1, 0, 0])
const A2 = new Float32Array([0.98, 0.02, 0])
const B = new Float32Array([0, 1, 0])
const B2 = new Float32Array([0.05, 0.99, 0])

test('cosineSim 기본 성질', () => {
  expect(cosineSim(A, A)).toBeCloseTo(1, 5)
  expect(cosineSim(A, B)).toBeCloseTo(0, 5)
})

test('유사한 임베딩끼리 묶인다 (2화자)', () => {
  const idx = clusterEmbeddings([A, B, A2, B2], { threshold: 0.75 })
  expect(idx[0]).toBe(idx[2]) // A들
  expect(idx[1]).toBe(idx[3]) // B들
  expect(idx[0]).not.toBe(idx[1])
  expect(new Set(idx).size).toBe(2)
})

test('임계 1.0이면 아무것도 병합 안 됨', () => {
  const idx = clusterEmbeddings([A, B, A2], { threshold: 1.0 })
  expect(new Set(idx).size).toBe(3)
})

test('단일 임베딩', () => {
  expect(clusterEmbeddings([A])).toEqual([0])
})

test('기본 임계(pyannote)에서 유사도 ~0.6의 단독 쌍은 병합되지 않는다', () => {
  // 코사인 0.6 — 다른 화자끼리도 나올 수 있는 영역. pyannote 기본 임계(센트로이드 거리
  // 0.7046 ≈ 코사인 0.75 등가)에선 단독 쌍을 병합하지 않아야 한다(과병합 방지).
  const P = new Float32Array([1, 0, 0])
  const Q = new Float32Array([0.6, 0.8, 0])
  expect(new Set(clusterEmbeddings([P, Q])).size).toBe(2)
})

test('직접 병합엔 먼 두 조각도 중간 조각을 다리 삼아 센트로이드 연쇄로 합쳐진다', () => {
  // 같은 화자의 세 조각 Am(+노이즈), Bm(중심), Cm(−노이즈).
  // Am–Cm 단독으론 코사인 0.6(거리 0.894 ≥ 임계)이라 안 합쳐지지만,
  // Am–Bm이 먼저 뭉치면 센트로이드가 중심으로 이동해 Cm과의 거리(0.673)가 임계 아래로
  // 내려와 하나로 합쳐진다 — 평균 연결에는 없는 센트로이드 연결의 연쇄(비단조) 병합.
  const Am = new Float32Array([1, 0.5, 0])
  const Bm = new Float32Array([1, 0, 0])
  const Cm = new Float32Array([1, -0.5, 0])
  expect(new Set(clusterEmbeddings([Am, Cm])).size).toBe(2) // 직접은 병합 안 됨
  expect(new Set(clusterEmbeddings([Am, Bm, Cm])).size).toBe(1) // 다리를 통해 연쇄 병합
})

test('numSpeakers를 주면 임계와 무관하게 그 수까지 병합한다', () => {
  // 서로 직교(유사도 0)인 4방향도 3개로 강제 병합된다.
  const dirs = [
    new Float32Array([1, 0, 0, 0]),
    new Float32Array([0, 1, 0, 0]),
    new Float32Array([0, 0, 1, 0]),
    new Float32Array([0, 0, 0, 1]),
  ]
  expect(new Set(clusterEmbeddings(dirs, { numSpeakers: 3 })).size).toBe(3)
})

test('numSpeakers가 임베딩 수 이상이면 병합하지 않는다', () => {
  expect(new Set(clusterEmbeddings([A, B], { numSpeakers: 5 })).size).toBe(2)
})

test('numSpeakers가 있으면 비슷한 것부터 병합된다', () => {
  // A·A2(0.999)가 A·B(0)보다 먼저 병합 → 3개로 줄이면 A들이 한 클러스터.
  const idx = clusterEmbeddings([A, B, A2, new Float32Array([0, 0, 1])], { numSpeakers: 3 })
  expect(idx[0]).toBe(idx[2])
  expect(new Set(idx).size).toBe(3)
})

describe('작은 클러스터 흡수 (durations 제공 시)', () => {
  // 화자1: A 방향 3구간(각 10초). 잡음 X: A와 유사도 0.5(임계 아래·흡수 기준 위), B와는 0. 1초.
  // 소수지만 뚜렷한 화자 B: A와 유사도 0(흡수 기준 아래), 2초.
  const X = new Float32Array([0.5, 0, Math.sqrt(1 - 0.25)])
  const embs = [A, A2, new Float32Array([0.99, 0.01, 0]), X, B]
  const durations = [10, 10, 10, 1, 2]

  test('짧은 잡음 클러스터는 가장 비슷한 큰 클러스터로 흡수된다', () => {
    const idx = clusterEmbeddings(embs, { durations })
    expect(idx[3]).toBe(idx[0]) // X → A 클러스터로 흡수
    expect(new Set(idx).size).toBe(2) // A들+X / B
  })

  test('큰 클러스터와 충분히 비슷하지 않은 소수 화자는 유지된다', () => {
    const idx = clusterEmbeddings(embs, { durations })
    expect(idx[4]).not.toBe(idx[0]) // B는 자기 클러스터 유지
  })

  test('모든 클러스터가 작으면 흡수를 건너뛴다', () => {
    const idx = clusterEmbeddings([A, B], { durations: [1, 1] })
    expect(new Set(idx).size).toBe(2)
  })

  test('numSpeakers가 있으면 흡수 없이 강제 병합만 한다', () => {
    const idx = clusterEmbeddings(embs, { durations, numSpeakers: 2 })
    expect(new Set(idx).size).toBe(2)
  })
})

test('maxRegions 초과 시 긴 구간만 클러스터링하고 나머지는 센트로이드로 배정한다', () => {
  // 5개 중 상위 3개(10·9·8초)만 클러스터링 — A(10), A2(9), B(8) → 2클러스터.
  // 나머지 A3(1초)→A 클러스터, B2(1초)→B 클러스터로 배정.
  const A3 = new Float32Array([0.97, 0.03, 0])
  const embs = [A, A2, B, A3, B2]
  const idx = clusterEmbeddings(embs, { durations: [10, 9, 8, 1, 1], maxRegions: 3 })
  expect(idx[0]).toBe(idx[1])
  expect(idx[3]).toBe(idx[0])
  expect(idx[4]).toBe(idx[2])
  expect(new Set(idx).size).toBe(2)
})

test('maxRegions 초과분이 어느 클러스터와도 닮지 않으면 강제 편입하지 않고 새 화자로 남긴다', () => {
  // 상위 4개(A·A·B·B)만 클러스터링. 나머지 C 2개는 A·B 모두와 직교(유사도 0) →
  // 가장 가까운 센트로이드에 강제 배정하지 않고 자기들끼리 새 클러스터를 이룬다.
  const C = new Float32Array([0, 0, 1])
  const C2 = new Float32Array([0, 0.02, 0.98])
  const embs = [A, A2, B, B2, C, C2]
  const idx = clusterEmbeddings(embs, { durations: [10, 9, 8, 7, 1, 1], maxRegions: 4 })
  expect(idx[4]).toBe(idx[5]) // C들끼리 같은 화자
  expect(idx[4]).not.toBe(idx[0])
  expect(idx[4]).not.toBe(idx[2])
  expect(new Set(idx).size).toBe(3)
})

test('labelClusters는 첫 등장 순으로 SPK 번호를 준다', () => {
  // 임베딩 0,1,2 / 클러스터 [1,0,1] / start [5, 0, 7] → 클러스터0 첫등장 0초=SPK1, 클러스터1 첫등장 5초=SPK2
  expect(labelClusters([1, 0, 1], [5, 0, 7])).toEqual(['SPK2', 'SPK1', 'SPK2'])
})
