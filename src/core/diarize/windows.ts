export const WINDOW_SAMPLES = 160_000 // 10초 @16kHz — pyannote segmentation-3.0 설계 창
const SAMPLE_RATE = 16_000

export interface RawRegion { start: number; end: number }

export function sliceWindows(samples: Float32Array): { window: Float32Array; offsetSec: number }[] {
  const out: { window: Float32Array; offsetSec: number }[] = []
  for (let i = 0; i < samples.length; i += WINDOW_SAMPLES) {
    out.push({
      window: samples.subarray(i, Math.min(i + WINDOW_SAMPLES, samples.length)),
      offsetSec: i / SAMPLE_RATE,
    })
  }
  return out
}

export function offsetRegions(
  regions: { start: number; end: number }[], offsetSec: number,
): RawRegion[] {
  return regions.map(r => ({ start: r.start + offsetSec, end: r.end + offsetSec }))
}

// 화자 임베딩은 최소 ~1초 이상 발화라야 신뢰할 만하다. 짧은 조각(맞장구·잡음)은 임베딩이 불안정해
// 같은 사람도 다른 클러스터로 쪼개(과분할) 화자 수가 폭증한다. 그래서 minSec 미만은 클러스터링에서
// 제외한다 — 짧은 세그먼트도 assignSpeakers가 최근접 구간으로 화자를 배정하므로 자막 커버리지는 그대로.
// (과분할이 여전하면 값을 올리고, 발화가 짧은 회의에서 화자가 안 잡히면 내리는 튜닝 지점.)
export function filterEmbeddable(regions: RawRegion[], minSec = 1.0): RawRegion[] {
  return regions.filter(r => r.end - r.start >= minSec)
}
