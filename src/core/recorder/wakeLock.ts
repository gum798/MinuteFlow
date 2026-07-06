type Sentinel = { release(): Promise<void> }

export function createWakeLockManager(
  nav: Navigator = navigator,
  doc: Document = document,
) {
  let sentinel: Sentinel | null = null
  let active = false

  async function acquire(): Promise<void> {
    const wakeLock = (nav as { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }).wakeLock
    if (!wakeLock) return
    try { sentinel = await wakeLock.request('screen') } catch { /* 저전력 모드 등에서 거부될 수 있음 */ }
  }

  async function onVisibility(): Promise<void> {
    if (active && doc.visibilityState === 'visible') await acquire()
  }

  return {
    async enable(): Promise<void> {
      active = true
      doc.addEventListener('visibilitychange', onVisibility)
      await acquire()
    },
    async disable(): Promise<void> {
      active = false
      doc.removeEventListener('visibilitychange', onVisibility)
      await sentinel?.release().catch(() => {})
      sentinel = null
    },
  }
}
