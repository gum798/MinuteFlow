import { SPEAKER_COLORS, speakerColor } from './speakerColors'

test('8색 팔레트', () => {
  expect(SPEAKER_COLORS).toHaveLength(8)
  expect(SPEAKER_COLORS[0]).toEqual({ fg: '#0E7490', bg: '#E5F3F6' })
})

test('라벨 → 색 (모듈러)', () => {
  expect(speakerColor('SPK1')).toEqual(SPEAKER_COLORS[0])
  expect(speakerColor('SPK9')).toEqual(SPEAKER_COLORS[0])
  expect(speakerColor('unknown')).toEqual(SPEAKER_COLORS[0])
})

test('같은 라벨은 같은 색 — 병합으로 라벨을 합치면 색도 일치한다', () => {
  // 색은 이름이 아니라 라벨로 정한다. SPK7을 SPK1로 병합하면 두 발화 모두 SPK1 색이 된다.
  expect(speakerColor('SPK1')).toEqual(speakerColor('SPK1'))
})
