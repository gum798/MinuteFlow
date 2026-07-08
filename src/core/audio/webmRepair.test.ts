import { startsWithEbml, findClusterOffset, EBML_MAGIC, CLUSTER_ID } from './webmRepair'

test('startsWithEbml는 EBML 시그니처로 시작할 때만 true', () => {
  expect(startsWithEbml(new Uint8Array([...EBML_MAGIC, 0x01, 0x02]))).toBe(true)
  expect(startsWithEbml(new Uint8Array([...CLUSTER_ID, 0x00]))).toBe(false)
  expect(startsWithEbml(new Uint8Array([0x1a, 0x45]))).toBe(false) // 너무 짧음
  expect(startsWithEbml(new Uint8Array([]))).toBe(false)
})

test('findClusterOffset는 첫 Cluster 시작 오프셋을 찾는다', () => {
  const bytes = new Uint8Array([0xaa, 0xbb, ...CLUSTER_ID, 0xcc])
  expect(findClusterOffset(bytes)).toBe(2)
})

test('findClusterOffset는 Cluster가 없으면 -1', () => {
  expect(findClusterOffset(new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44]))).toBe(-1)
})

test('findClusterOffset는 from 이후만 스캔한다', () => {
  const bytes = new Uint8Array([...CLUSTER_ID, 0x00, ...CLUSTER_ID])
  expect(findClusterOffset(bytes)).toBe(0)
  expect(findClusterOffset(bytes, 1)).toBe(5) // 첫 Cluster 건너뛰고 두 번째
})

test('고아 오디오(헤더 없음)는 EBML로 시작하지 않고 Cluster를 가진다', () => {
  const orphan = new Uint8Array([...CLUSTER_ID, 0x81, 0x00])
  expect(startsWithEbml(orphan)).toBe(false)
  expect(findClusterOffset(orphan)).toBe(0)
})
