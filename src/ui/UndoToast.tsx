import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

interface UndoState { message: string; onUndo: () => void; onExpire: () => void }
const UndoContext = createContext<(s: UndoState) => void>(() => {})
export const useUndoToast = () => useContext(UndoContext)
export const UNDO_MS = 5000

export function UndoToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UndoState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef<UndoState | null>(null)

  const show = useCallback((s: UndoState) => {
    // 이전 토스트가 살아 있으면 그 삭제를 확정(만료 처리)하고 새 토스트로 교체
    if (timer.current) { clearTimeout(timer.current); stateRef.current?.onExpire() }
    stateRef.current = s
    setState(s)
    timer.current = setTimeout(() => {
      timer.current = null; stateRef.current = null
      setState(null)
      s.onExpire()
    }, UNDO_MS)
  }, [])

  // 언마운트 시 대기 중인 타이머 정리(만료는 실행하지 않음)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function undo() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const s = stateRef.current
    stateRef.current = null
    setState(null)
    s?.onUndo()
  }

  return (
    <UndoContext.Provider value={show}>
      {children}
      {state && (
        <div className="toast" role="status">
          {state.message}{' '}
          <button type="button" className="toast-action" onClick={undo}>실행취소</button>
        </div>
      )}
    </UndoContext.Provider>
  )
}
