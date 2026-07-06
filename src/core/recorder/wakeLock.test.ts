import { createWakeLockManager } from './wakeLock'

function makeFakes() {
  const sentinel = { release: vi.fn(async () => {}) }
  const request = vi.fn(async () => sentinel)
  const listeners: Record<string, () => void> = {}
  const doc = {
    visibilityState: 'visible',
    addEventListener: vi.fn((t: string, fn: () => void) => { listeners[t] = fn }),
    removeEventListener: vi.fn((t: string) => { delete listeners[t] }),
  } as unknown as Document
  const nav = { wakeLock: { request } } as unknown as Navigator
  return { nav, doc, request, sentinel, listeners }
}

test('enable은 wake lock을 획득한다', async () => {
  const { nav, doc, request } = makeFakes()
  await createWakeLockManager(nav, doc).enable()
  expect(request).toHaveBeenCalledWith('screen')
})

test('visible 복귀 시 재획득한다', async () => {
  const { nav, doc, request, listeners } = makeFakes()
  await createWakeLockManager(nav, doc).enable()
  await listeners['visibilitychange']()
  expect(request).toHaveBeenCalledTimes(2)
})

test('disable 후에는 재획득하지 않는다', async () => {
  const { nav, doc, request, sentinel } = makeFakes()
  const mgr = createWakeLockManager(nav, doc)
  await mgr.enable()
  await mgr.disable()
  expect(sentinel.release).toHaveBeenCalled()
  expect(doc.removeEventListener).toHaveBeenCalled()
  expect(request).toHaveBeenCalledTimes(1)
})

test('API 미지원이면 조용히 no-op', async () => {
  const doc = { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Document
  const mgr = createWakeLockManager({} as Navigator, doc)
  await expect(mgr.enable()).resolves.toBeUndefined()
  await expect(mgr.disable()).resolves.toBeUndefined()
})
