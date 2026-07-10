// docs/design/design-tokens.md 화자 팔레트 verbatim
export const SPEAKER_COLORS = [
  { fg: '#0E7490', bg: '#E5F3F6' }, { fg: '#7C3AED', bg: '#F1ECFC' },
  { fg: '#B45309', bg: '#FAF0E1' }, { fg: '#BE185D', bg: '#FAE8F0' },
  { fg: '#15803D', bg: '#E7F5EC' }, { fg: '#4F46E5', bg: '#EEF0FD' },
  { fg: '#0369A1', bg: '#E3F1FA' }, { fg: '#A21CAF', bg: '#F8EAFA' },
]

// 색은 화자의 내부 라벨(SPK<n>)로 정한다. 서로 다른 클러스터를 같은 사람으로 합치는 것은
// 이름 매핑이 아니라 라벨 병합(mergeSpeakerLabel)으로 처리한다 — 병합하면 라벨이 같아져 색도 일치한다.
export function speakerColor(label: string): { fg: string; bg: string } {
  const n = Number(/^SPK(\d+)$/.exec(label)?.[1] ?? '1')
  return SPEAKER_COLORS[(Math.max(1, n) - 1) % SPEAKER_COLORS.length]
}
