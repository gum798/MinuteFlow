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
