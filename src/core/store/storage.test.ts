import { ensurePersistentStorage, getStorageUsage, getStorageBreakdown, getModelCacheBytes, clearModelCaches } from './storage'
import { db } from './db'

afterEach(() => vi.unstubAllGlobals())

function stubStorage(overrides: Partial<StorageManager>) {
  vi.stubGlobal('navigator', { ...navigator, storage: overrides as StorageManager })
}

test('이미 persisted면 persist()를 다시 요청하지 않는다', async () => {
  const persist = vi.fn()
  stubStorage({ persisted: async () => true, persist })
  expect(await ensurePersistentStorage()).toBe(true)
  expect(persist).not.toHaveBeenCalled()
})

test('persisted가 아니면 persist()를 요청한다', async () => {
  stubStorage({ persisted: async () => false, persist: async () => true })
  expect(await ensurePersistentStorage()).toBe(true)
})

test('storage API가 없으면 false', async () => {
  vi.stubGlobal('navigator', { ...navigator, storage: undefined })
  expect(await ensurePersistentStorage()).toBe(false)
})

test('getStorageUsage는 estimate를 반환한다', async () => {
  stubStorage({ estimate: async () => ({ usage: 100, quota: 1000 }) })
  expect(await getStorageUsage()).toEqual({ usage: 100, quota: 1000 })
})

test('estimate 미지원이면 null', async () => {
  vi.stubGlobal('navigator', { ...navigator, storage: undefined })
  expect(await getStorageUsage()).toBeNull()
})

test('getStorageBreakdown은 회의 데이터와 캐시 실측을 분리한다', async () => {
  await db.audioChunks.clear()
  await db.audioChunks.add({ meetingId: 'a', seq: 0, data: new Uint8Array(100).buffer, mimeType: 'audio/webm', startedAt: 0 })
  await db.audioChunks.add({ meetingId: 'a', seq: 1, data: new Uint8Array(200).buffer, mimeType: 'audio/webm', startedAt: 0 })
  stubStorage({ estimate: async () => ({ usage: 999999, quota: 5000 }) })
  const fakeRes = { headers: { get: (h: string) => (h === 'content-length' ? '700' : null) } }
  vi.stubGlobal('caches', {
    keys: async () => ['transformers-cache', 'workbox-precache-v2-x'],
    open: async () => ({ keys: async () => [{}], match: async () => fakeRes }),
  })
  // totalUsage는 estimate가 아니라 실측 합 (estimate는 삭제 직후 stale — Chromium 실측으로 확인)
  expect(await getStorageBreakdown()).toEqual({
    totalUsage: 1000, quota: 5000, meetingBytes: 300, cacheBytes: 700,
  })
})

test('getModelCacheBytes는 content-length 없으면 blob 크기로 폴백', async () => {
  const fakeRes = { headers: { get: () => null }, blob: async () => ({ size: 42 }) }
  vi.stubGlobal('caches', {
    keys: async () => ['onnx-wasm'],
    open: async () => ({ keys: async () => [{}, {}], match: async () => fakeRes }),
  })
  expect(await getModelCacheBytes()).toBe(84)
})

test('getStorageBreakdown은 estimate 미지원이어도 실측으로 동작한다 (quota 0)', async () => {
  await db.audioChunks.clear()
  vi.stubGlobal('navigator', { ...navigator, storage: undefined })
  expect(await getStorageBreakdown()).toMatchObject({ quota: 0, meetingBytes: 0, cacheBytes: 0 })
})

test('clearModelCaches는 workbox 캐시는 남기고 나머지만 지운다', async () => {
  const del = vi.fn(async () => true)
  vi.stubGlobal('caches', {
    keys: async () => ['transformers-cache', 'onnx-wasm', 'workbox-precache-v2-app', 'workbox-runtime'],
    delete: del,
  })
  expect(await clearModelCaches()).toBe(2)
  expect(del).toHaveBeenCalledWith('transformers-cache')
  expect(del).toHaveBeenCalledWith('onnx-wasm')
  expect(del).not.toHaveBeenCalledWith('workbox-precache-v2-app')
  expect(del).not.toHaveBeenCalledWith('workbox-runtime')
})

test('clearModelCaches는 caches 미지원이면 0', async () => {
  vi.stubGlobal('caches', undefined)
  expect(await clearModelCaches()).toBe(0)
})
