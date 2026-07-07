import { render, screen, fireEvent, act } from '@testing-library/react'
import { UndoToastProvider, useUndoToast, UNDO_MS } from './UndoToast'
import * as store from '../core/store/meetings'

function Trigger(props: { onUndo?: () => void; onExpire?: () => void; message?: string }) {
  const show = useUndoToast()
  return (
    <button onClick={() => show({
      message: props.message ?? '삭제됨',
      onUndo: props.onUndo ?? (() => {}),
      onExpire: props.onExpire ?? (() => {}),
    })}>show</button>
  )
}

test('토스트를 표시하면 메시지와 실행취소 버튼이 보인다', () => {
  render(<UndoToastProvider><Trigger message="회의록을 삭제했어요." /></UndoToastProvider>)
  fireEvent.click(screen.getByText('show'))
  expect(screen.getByRole('status')).toHaveTextContent('회의록을 삭제했어요.')
  expect(screen.getByRole('button', { name: '실행취소' })).toBeInTheDocument()
})

test('실행취소를 누르면 onUndo가 호출되고 onExpire는 호출되지 않으며 토스트가 닫힌다', () => {
  const onUndo = vi.fn()
  const onExpire = vi.fn()
  render(<UndoToastProvider><Trigger onUndo={onUndo} onExpire={onExpire} /></UndoToastProvider>)
  fireEvent.click(screen.getByText('show'))
  fireEvent.click(screen.getByRole('button', { name: '실행취소' }))
  expect(onUndo).toHaveBeenCalledTimes(1)
  expect(onExpire).not.toHaveBeenCalled()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('시간이 지나 만료되면 onExpire가 호출되고 토스트가 사라진다', () => {
  vi.useFakeTimers()
  try {
    const onUndo = vi.fn()
    const onExpire = vi.fn()
    render(<UndoToastProvider><Trigger onUndo={onUndo} onExpire={onExpire} /></UndoToastProvider>)
    fireEvent.click(screen.getByText('show'))
    expect(onExpire).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(UNDO_MS) })
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onUndo).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})

test('토스트가 만료되면 purgeDeleted(하드 삭제)가 실행된다', () => {
  vi.useFakeTimers()
  try {
    const purgeSpy = vi.spyOn(store, 'purgeDeleted').mockResolvedValue(undefined)
    render(
      <UndoToastProvider>
        <Trigger onExpire={() => { void store.purgeDeleted() }} />
      </UndoToastProvider>,
    )
    fireEvent.click(screen.getByText('show'))
    expect(purgeSpy).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(UNDO_MS) })
    expect(purgeSpy).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

test('새 토스트로 교체되면 이전 토스트의 onExpire가 확정된다', () => {
  vi.useFakeTimers()
  try {
    const firstExpire = vi.fn()
    function Multi() {
      const show = useUndoToast()
      return (
        <>
          <button onClick={() => show({ message: '첫번째', onUndo: () => {}, onExpire: firstExpire })}>a</button>
          <button onClick={() => show({ message: '두번째', onUndo: () => {}, onExpire: () => {} })}>b</button>
        </>
      )
    }
    render(<UndoToastProvider><Multi /></UndoToastProvider>)
    fireEvent.click(screen.getByText('a'))
    fireEvent.click(screen.getByText('b'))
    expect(firstExpire).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('두번째')
  } finally {
    vi.useRealTimers()
  }
})
