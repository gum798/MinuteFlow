export interface SpeakerRegion { start: number; end: number; speaker: string }

// WhisperX assign_word_speakers 이식: 화자별 교집합 합산 최대 → 배정, 무교집합 시 최근접
export function assignSpeakers<T extends { startSec: number; endSec: number }>(
  segments: T[], regions: SpeakerRegion[],
): (T & { speaker?: string })[] {
  return segments.map(seg => {
    if (regions.length === 0) return { ...seg }
    const bySpeaker = new Map<string, number>()
    for (const r of regions) {
      const inter = Math.min(r.end, seg.endSec) - Math.max(r.start, seg.startSec)
      if (inter > 0) bySpeaker.set(r.speaker, (bySpeaker.get(r.speaker) ?? 0) + inter)
    }
    if (bySpeaker.size > 0) {
      const speaker = [...bySpeaker.entries()].sort((a, b) => b[1] - a[1])[0][0]
      return { ...seg, speaker }
    }
    // 최근접: 세그먼트 midpoint와 구간 midpoint 거리 최소
    const mid = (seg.startSec + seg.endSec) / 2
    let best = regions[0], bestDist = Infinity
    for (const r of regions) {
      const d = Math.abs((r.start + r.end) / 2 - mid)
      if (d < bestDist) { bestDist = d; best = r }
    }
    return { ...seg, speaker: best.speaker }
  })
}
