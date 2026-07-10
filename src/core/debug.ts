// src/core/debug.ts
// 개발자용 디버그 로거. 기본 켜짐 — localStorage['mf-debug']='0'으로 끈다.
// 긴 녹음 처리(디코딩·전사·화자)의 단계·소요시간을 콘솔에서 추적하기 위한 최소 도구.

export function isDebugEnabled(): boolean {
  try {
    return localStorage.getItem('mf-debug') !== '0'
  } catch {
    return false
  }
}

export function dlog(scope: string, ...args: unknown[]): void {
  if (!isDebugEnabled()) return
  console.debug(`[MF:${scope}]`, ...args)
}

/** 시작~end() 사이 경과(ms)를 dlog로 남기는 타이머. */
export function dtimer(scope: string, label: string): () => void {
  const started = performance.now()
  return () => dlog(scope, `${label} (${Math.round((performance.now() - started) * 10) / 10}ms)`)
}
