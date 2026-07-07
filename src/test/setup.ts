import '@testing-library/jest-dom/vitest'

// Node 26 ships a native experimental `localStorage` global that is `undefined`
// unless `--localstorage-file` is passed, and it shadows jsdom's Storage. Provide
// a minimal in-memory polyfill so tests that use Web Storage work in jsdom.
if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
  class MemoryStorage implements Storage {
    private store = new Map<string, string>()
    get length(): number {
      return this.store.size
    }
    clear(): void {
      this.store.clear()
    }
    getItem(key: string): string | null {
      return this.store.has(key) ? this.store.get(key)! : null
    }
    key(index: number): string | null {
      return Array.from(this.store.keys())[index] ?? null
    }
    removeItem(key: string): void {
      this.store.delete(key)
    }
    setItem(key: string, value: string): void {
      this.store.set(key, String(value))
    }
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}
