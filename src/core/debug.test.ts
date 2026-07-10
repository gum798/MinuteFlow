// src/core/debug.test.ts
import { dlog, isDebugEnabled, dtimer } from './debug'

beforeEach(() => localStorage.clear())

test('mf-debug=0이면 로그를 찍지 않는다', () => {
  localStorage.setItem('mf-debug', '0')
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  dlog('test', 'hello')
  expect(spy).not.toHaveBeenCalled()
  expect(isDebugEnabled()).toBe(false)
  spy.mockRestore()
})

test('기본(플래그 없음)은 켜져 있고 [MF:scope] 프리픽스로 찍는다', () => {
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  dlog('decode', 'x', 1)
  expect(isDebugEnabled()).toBe(true)
  expect(spy).toHaveBeenCalledWith('[MF:decode]', 'x', 1)
  spy.mockRestore()
})

test('dtimer는 종료 시 경과(ms)를 포함해 로그한다', () => {
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  const end = dtimer('diarize', '클러스터링')
  end()
  expect(spy).toHaveBeenCalledTimes(1)
  const [prefix, msg] = spy.mock.calls[0]
  expect(prefix).toBe('[MF:diarize]')
  expect(String(msg)).toMatch(/클러스터링 \(\d+(\.\d+)?ms\)/)
  spy.mockRestore()
})
