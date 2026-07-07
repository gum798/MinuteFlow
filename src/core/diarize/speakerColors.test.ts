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
