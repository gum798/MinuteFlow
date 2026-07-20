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

const baseMeeting = { title: 't', createdAt: 0, durationSec: 0, status: 'done' as const, language: 'ko-KR' }

test('getStorageBreakdown은 회의 audioBytes 메타데이터 합과 캐시 실측을 분리한다', async () => {
  await db.meetings.clear()
  await db.audioChunks.clear()
  await db.meetings.add({ ...baseMeeting, id: 'a', audioBytes: 100 })
  await db.meetings.add({ ...baseMeeting, id: 'b', audioBytes: 200 })
  // audioBytes가 있으면 청크는 읽지 않는다(단락) — 메타데이터와 다른 크기의 청크를 심어 고정.
  await db.audioChunks.add({ meetingId: 'a', seq: 0, data: new Uint8Array(999).buffer, mimeType: 'audio/webm', startedAt: 0 })
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

test('audioBytes가 없는 옛 회의는 청크를 한 번만 실측해 메타데이터를 채운다(자가 치유)', async () => {
  await db.meetings.clear()
  await db.audioChunks.clear()
  await db.meetings.add({ ...baseMeeting, id: 'legacy' }) // audioBytes 없음
  await db.audioChunks.add({ meetingId: 'legacy', seq: 0, data: new Uint8Array(100).buffer, mimeType: 'audio/webm', startedAt: 0 })
  await db.audioChunks.add({ meetingId: 'legacy', seq: 1, data: new Uint8Array(200).buffer, mimeType: 'audio/webm', startedAt: 0 })
  vi.stubGlobal('navigator', { ...navigator, storage: undefined })
  vi.stubGlobal('caches', undefined)

  expect(await getStorageBreakdown()).toMatchObject({ meetingBytes: 300 })
  // 실측값이 메타데이터로 저장되어 다음부터는 청크를 읽지 않는다.
  expect((await db.meetings.get('legacy'))?.audioBytes).toBe(300)
})

test('soft-delete된 회의의 오디오도 purge 전까지는 사용량에 포함된다', async () => {
  await db.meetings.clear()
  await db.audioChunks.clear()
  await db.meetings.add({ ...baseMeeting, id: 'del', audioBytes: 400, deletedAt: Date.now() })
  vi.stubGlobal('navigator', { ...navigator, storage: undefined })
  vi.stubGlobal('caches', undefined)
  expect(await getStorageBreakdown()).toMatchObject({ meetingBytes: 400 })
})

test('getModelCacheBytes는 content-length 없으면 blob 크기로 폴백', async () => {
  const fakeRes = { headers: { get: () => null }, blob: async () => ({ size: 42 }) }
  vi.stubGlobal('caches', {
    keys: async () => ['onnx-wasm'],
    open: async () => ({ keys: async () => [{}, {}], match: async () => fakeRes }),
  })
  expect(await getModelCacheBytes()).toBe(84)
})

test('getStorageBreakdown은 estimate 미지원이어도 동작한다 (quota 0)', async () => {
  await db.meetings.clear()
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
