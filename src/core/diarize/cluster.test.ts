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
  const idx = clusterEmbeddings([A, B, A2, B2], 0.75)
  expect(idx[0]).toBe(idx[2]) // A들
  expect(idx[1]).toBe(idx[3]) // B들
  expect(idx[0]).not.toBe(idx[1])
  expect(new Set(idx).size).toBe(2)
})

test('임계 1.0이면 아무것도 병합 안 됨', () => {
  const idx = clusterEmbeddings([A, B, A2], 1.0)
  expect(new Set(idx).size).toBe(3)
})

test('단일 임베딩', () => {
  expect(clusterEmbeddings([A])).toEqual([0])
})

test('labelClusters는 첫 등장 순으로 SPK 번호를 준다', () => {
  // 임베딩 0,1,2 / 클러스터 [1,0,1] / start [5, 0, 7] → 클러스터0 첫등장 0초=SPK1, 클러스터1 첫등장 5초=SPK2
  expect(labelClusters([1, 0, 1], [5, 0, 7])).toEqual(['SPK2', 'SPK1', 'SPK2'])
})
