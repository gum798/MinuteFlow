import { pickMimeType } from './mime'

test('첫 번째 지원 타입을 고른다', () => {
  expect(pickMimeType(t => t === 'audio/webm')).toBe('audio/webm')
  expect(pickMimeType(t => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus')
  expect(pickMimeType(t => t === 'audio/mp4')).toBe('audio/mp4')
})

test('지원 타입이 없으면 undefined', () => {
  expect(pickMimeType(() => false)).toBeUndefined()
})
