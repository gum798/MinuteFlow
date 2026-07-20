export const WINDOW_SAMPLES = 160_000 // 10초 @16kHz — pyannote segmentation-3.0 설계 창
const SAMPLE_RATE = 16_000

export interface RawRegion { start: number; end: number }

export function sliceWindows(samples: Float32Array): { window: Float32Array; offsetSec: number }[] {
  const out: { window: Float32Array; offsetSec: number }[] = []
  for (let i = 0; i < samples.length; i += WINDOW_SAMPLES) {
    let window = samples.subarray(i, Math.min(i + WINDOW_SAMPLES, samples.length))
    // 마지막 부분 창은 0으로 채워 항상 창 크기로 맞춘다 — 세그멘테이션 모델(SincNet conv)은
    // 너무 짧은 입력(예: 2샘플 꼬리)에서 "Invalid input shape"로 실패한다. 무음 패딩은 발화로
    // 인식되지 않고, 패딩 구간에 걸친 결과는 clampRegions가 실제 길이로 잘라낸다.
    if (window.length < WINDOW_SAMPLES) {
      const padded = new Float32Array(WINDOW_SAMPLES)
      padded.set(window)
      window = padded
    }
    out.push({ window, offsetSec: i / SAMPLE_RATE })
  }
  return out
}

/** 패딩 구간(실제 오디오 길이 밖)에 걸친 발화 구간을 잘라낸다. 온전히 밖이면 제거. */
export function clampRegions(regions: RawRegion[], totalSec: number): RawRegion[] {
  return regions
    .filter(r => r.start < totalSec)
    .map(r => (r.end > totalSec ? { start: r.start, end: totalSec } : r))
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
