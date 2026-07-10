// 화자 병합: 서로 다른 diarization 클러스터(SPK 라벨)를 "같은 사람"으로 합친다.
// 색·연속 발화 묶기·요약이 모두 segment.speaker(내부 라벨)를 기준으로 동작하므로,
// 이름만 같게 두는 대신 라벨 자체를 하나로 합쳐야 진짜로 한 사람으로 취급된다.
// (이름 철자가 우연히 같은 것과 구분 — 병합은 사용자가 기존 이름을 "선택"했을 때만 일어난다.)

const SPK_MAX = Number.MAX_SAFE_INTEGER

// 'SPK<n>' 라벨의 번호(정렬용). SPK 형식이 아니면 가장 뒤로.
function spkNum(label: string): number {
  return Number(/^SPK(\d+)$/.exec(label)?.[1] ?? SPK_MAX)
}

/**
 * name을 표시 이름으로 가진 기존 라벨 중 대표 하나를 고른다(가장 낮은 SPK 번호 → 색이 안정적).
 * exclude(지금 이름을 바꾸는 라벨) 자신은 제외한다. 대상이 없으면 null(=합칠 상대 없음, 그냥 새 이름).
 */
export function canonicalSpeakerLabel(
  names: Record<string, string>, name: string, exclude: string,
): string | null {
  const target = name.trim()
  if (!target) return null
  const matches = Object.keys(names).filter(l => l !== exclude && (names[l] ?? '').trim() === target)
  if (matches.length === 0) return null
  return matches.reduce((best, l) => (spkNum(l) < spkNum(best) ? l : best))
}

/** from 라벨을 가진 세그먼트를 to 라벨로 재지정한다(그 외 필드·순서 보존). */
export function relabelSpeaker<T extends { speaker?: string }>(segments: T[], from: string, to: string): T[] {
  if (from === to) return segments
  return segments.map(s => (s.speaker === from ? { ...s, speaker: to } : s))
}
