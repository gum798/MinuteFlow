import { db } from './db'

export interface StorageBreakdown {
  totalUsage: number
  quota: number
  meetingBytes: number // IndexedDB 회의 데이터 — audioChunks의 data.byteLength 합(근사)
  cacheBytes: number // totalUsage - meetingBytes, 음수면 0 (모델 캐시+앱 근사)
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

export async function getStorageBreakdown(): Promise<StorageBreakdown | null> {
  const storage = navigator.storage
  if (!storage?.estimate) return null
  const { usage = 0, quota = 0 } = await storage.estimate()
  let meetingBytes = 0
  await db.audioChunks.each(c => { meetingBytes += c.data.byteLength })
  return { totalUsage: usage, quota, meetingBytes, cacheBytes: Math.max(0, usage - meetingBytes) }
}

// workbox-* 캐시(앱 셸 프리캐시)는 보존하고, 모델·wasm 캐시만 지운다. 삭제한 캐시 수 반환.
export async function clearModelCaches(): Promise<number> {
  if (typeof caches === 'undefined') return 0
  const keys = await caches.keys()
  const targets = keys.filter(k => !k.startsWith('workbox'))
  await Promise.all(targets.map(k => caches.delete(k)))
  return targets.length
}
