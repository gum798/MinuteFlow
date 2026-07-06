import { ensurePersistentStorage, getStorageUsage } from './storage'

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
