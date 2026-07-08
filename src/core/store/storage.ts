import { db } from './db'

export interface StorageBreakdown {
  totalUsage: number // meetingBytes + cacheBytes 실측 합 (estimate는 삭제 직후 stale — 실측 기반으로 즉시 반영)
  quota: number
  meetingBytes: number // IndexedDB 회의 데이터 — audioChunks의 data.byteLength 합(근사)
  cacheBytes: number // 비-workbox 캐시(모델·wasm) 엔트리 크기 실합산
}

export async function ensurePersistentStorage(): Promise<boolean> {
  const storage = navigator.storage
  if (!storage?.persist || !storage.persisted) return false
  if (await storage.persisted()) return true
  return storage.persist()
}

export async function getStorageUsage(): Promise<{ usage: number; quota: number } | null> {
  const storage = navigator.storage
  if (!storage?.estimate) return null
  const { usage = 0, quota = 0 } = await storage.estimate()
  return { usage, quota }
}

// 비-workbox 캐시(모델·wasm)의 실제 바이트 합 — Content-Length 우선, 없으면 blob 크기(디스크 백드 핸들이라 저비용)
export async function getModelCacheBytes(): Promise<number> {
  if (typeof caches === 'undefined') return 0
  let total = 0
  const keys = await caches.keys()
  for (const key of keys.filter(k => !k.startsWith('workbox'))) {
    const cache = await caches.open(key)
    for (const req of await cache.keys()) {
      const res = await cache.match(req)
      if (!res) continue
      const len = Number(res.headers.get('content-length'))
      total += Number.isFinite(len) && len > 0 ? len : (await res.blob()).size
    }
  }
  return total
}

export async function getStorageBreakdown(): Promise<StorageBreakdown | null> {
  const storage = navigator.storage
  const quota = storage?.estimate ? ((await storage.estimate()).quota ?? 0) : 0
  let meetingBytes = 0
  await db.audioChunks.each(c => { meetingBytes += c.data.byteLength })
  const cacheBytes = await getModelCacheBytes()
  return { totalUsage: meetingBytes + cacheBytes, quota, meetingBytes, cacheBytes }
}

// workbox-* 캐시(앱 셸 프리캐시)는 보존하고, 모델·wasm 캐시만 지운다. 삭제한 캐시 수 반환.
export async function clearModelCaches(): Promise<number> {
  if (typeof caches === 'undefined') return 0
  const keys = await caches.keys()
  const targets = keys.filter(k => !k.startsWith('workbox'))
  await Promise.all(targets.map(k => caches.delete(k)))
  return targets.length
}
