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

export function filterEmbeddable(regions: RawRegion[], minSec = 0.4): RawRegion[] {
  return regions.filter(r => r.end - r.start >= minSec)
}
