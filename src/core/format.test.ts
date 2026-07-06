import { formatTimestamp } from './format'

test('1시간 미만은 MM:SS', () => {
  expect(formatTimestamp(0)).toBe('00:00')
  expect(formatTimestamp(65)).toBe('01:05')
  expect(formatTimestamp(599.9)).toBe('09:59')
})

test('1시간 이상은 H:MM:SS', () => {
  expect(formatTimestamp(3600)).toBe('1:00:00')
  expect(formatTimestamp(3725)).toBe('1:02:05')
})

test('음수는 00:00으로 클램프', () => {
  expect(formatTimestamp(-5)).toBe('00:00')
})
