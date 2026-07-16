// src/core/diarize/globalSpeakers.ts
// 여러 부(part)의 발화 구간·임베딩을 모아 전역으로 클러스터링해 부 경계를 넘어 일관된 화자 라벨을 부여한다.
// 라벨 순서(SPK1..)는 전체 회의에서 처음 등장한 화자 기준(부 offset을 더한 전역 시각으로 정렬).
// 반환은 각 부의 '부-상대' SpeakerRegion[] — 그대로 assignSpeakers(부, regions)에 넣을 수 있다.
import { clusterEmbeddings, labelClusters } from './cluster'
import type { SpeakerRegion } from './assign'

export interface PartExtract {
  targets: { start: number; end: number }[]
  embeddings: Float32Array[]
  offsetSec: number
}

export function globalSpeakerRegions(parts: PartExtract[], numSpeakers?: number): SpeakerRegion[][] {
  const allEmb: Float32Array[] = []
  const globalStarts: number[] = []
  const durations: number[] = []
  for (const p of parts) {
    for (let i = 0; i < p.embeddings.length; i++) {
      allEmb.push(p.embeddings[i])
      globalStarts.push(p.targets[i].start + p.offsetSec)
      durations.push(p.targets[i].end - p.targets[i].start)
    }
  }
  if (allEmb.length === 0) return parts.map(() => [])
  const idx = clusterEmbeddings(allEmb, { numSpeakers, durations })
  const labels = labelClusters(idx, globalStarts) // 전역 시각 기준 SPK 라벨
  // 라벨을 다시 부별로 분배(추출 순서와 동일)하고, 부-상대 시각으로 SpeakerRegion을 만든다.
  const out: SpeakerRegion[][] = []
  let k = 0
  for (const p of parts) {
    const regions = p.targets.map((t, i) => ({ start: t.start, end: t.end, speaker: labels[k + i] }))
      .sort((a, b) => a.start - b.start)
    out.push(regions)
    k += p.targets.length
  }
  return out
}
