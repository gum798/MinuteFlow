// docs/design/design-tokens.md 화자 팔레트 verbatim
export const SPEAKER_COLORS = [
  { fg: '#0E7490', bg: '#E5F3F6' }, { fg: '#7C3AED', bg: '#F1ECFC' },
  { fg: '#B45309', bg: '#FAF0E1' }, { fg: '#BE185D', bg: '#FAE8F0' },
  { fg: '#15803D', bg: '#E7F5EC' }, { fg: '#4F46E5', bg: '#EEF0FD' },
  { fg: '#0369A1', bg: '#E3F1FA' }, { fg: '#A21CAF', bg: '#F8EAFA' },
]

export function speakerColor(label: string): { fg: string; bg: string } {
  const n = Number(/^SPK(\d+)$/.exec(label)?.[1] ?? '1')
  return SPEAKER_COLORS[(Math.max(1, n) - 1) % SPEAKER_COLORS.length]
}
