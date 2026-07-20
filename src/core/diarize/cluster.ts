export function cosineSim(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export interface ClusterOpts {
  /** 병합을 멈추는 코사인 유사도 하한(테스트·튜닝용). 없으면 pyannote 기본 거리 임계를 쓴다.
   *  numSpeakers가 있으면 무시된다. */
  threshold?: number
  /** 사용자가 아는 화자 수 — 임계와 무관하게 이 수까지 병합한다(pyannote의 num_speakers와 동일). */
  numSpeakers?: number
  /** 각 임베딩 구간의 발화 길이(초). 작은 클러스터 흡수·대형 회의 상한에 쓰인다. */
  durations?: number[]
  /** O(n²) 거리 행렬 메모리 상한 — 초과 시 긴 구간만 클러스터링하고 나머지는 센트로이드 배정. */
  maxRegions?: number
}

// pyannote/speaker-diarization-3.1 config.yaml의 clustering.threshold — 정규화 임베딩의
// 클러스터 센트로이드 간 유클리드 거리 임계(단위벡터에서 코사인 ~0.75 등가). 같은 임베딩 모델
// (wespeaker-resnet34-LM)에 검증된 값이라 그대로 쓴다. 과분할이 여전하면 올리고, 서로 다른
// 화자가 합쳐지면 내리는 튜닝 지점.
const PYANNOTE_CENTROID_DIST = 0.7045654963945799
// pyannote min_cluster_size 이식: 총 발화가 이보다 짧은 클러스터는 잡음·맞장구로 보고
// 가장 비슷한 큰 클러스터로 흡수한다. 단 유사도가 ABSORB_MIN_SIM 미만이면 짧아도 뚜렷한
// 화자로 보고 유지한다(3화자를 2화자로 뭉개는 것이 라벨 몇 개 남는 것보다 나쁨).
const SMALL_CLUSTER_SEC = 6
const ABSORB_MIN_SIM = 0.45
// n=2500이면 유사도 행렬(Float32) ≈ 24MB. 15시간급 회의도 이 안에서 병합이 수 초에 끝난다.
const MAX_CLUSTER_REGIONS = 2500

function toUnit(e: Float32Array | number[]): Float32Array {
  let norm = 0
  for (let i = 0; i < e.length; i++) norm += e[i] * e[i]
  norm = Math.sqrt(norm)
  const out = new Float32Array(e.length)
  if (norm === 0) return out
  for (let i = 0; i < e.length; i++) out[i] = e[i] / norm
  return out
}

// 클러스터 멤버들의 단위벡터 평균(정규화 안 함 — cosineSim이 크기를 무시하므로 충분).
function centroidOf(unit: Float32Array[], members: number[]): Float32Array {
  const c = new Float32Array(unit[0].length)
  for (const m of members) for (let i = 0; i < c.length; i++) c[i] += unit[m][i]
  return c
}

// 센트로이드 연결(centroid-linkage) 병합 본체 — pyannote 3.1과 동일한 방식.
// 정규화 임베딩의 클러스터 평균(센트로이드) 간 유클리드 거리가 임계 미만인 동안 병합한다.
// 평균 연결(쌍별 평균)과 달리 클러스터가 커질수록 센트로이드에서 구간별 잡음이 상쇄되어,
// 짧은 구간·양자화 임베딩의 낮은 쌍별 유사도에서도 같은 화자 조각들이 연쇄적으로 합쳐진다.
// simThreshold(코사인)가 주어지면 단위벡터 등가 거리 d=√(2(1−cos))로 변환해 쓴다.
function clusterCore(
  embeddings: Float32Array[], simThreshold: number | undefined, numSpeakers?: number, durations?: number[],
): number[] {
  const n = embeddings.length
  if (n === 0) return []
  const distThreshold = simThreshold === undefined
    ? PYANNOTE_CENTROID_DIST
    : Math.sqrt(Math.max(0, 2 * (1 - simThreshold)))
  const unit = embeddings.map(toUnit)
  const dim = unit[0].length
  // 클러스터 합 벡터(센트로이드 = sums/size). 누적 오차를 줄이려 배정밀도로 유지한다.
  const sums = unit.map(u => Float64Array.from(u))
  const dist = new Float32Array(n * n)
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      let dot = 0
      for (let k = 0; k < dim; k++) dot += unit[i][k] * unit[j][k]
      // 단위벡터의 유클리드 거리: d² = 2 − 2·cos
      const d = Math.sqrt(Math.max(0, 2 - 2 * dot))
      dist[i * n + j] = dist[j * n + i] = d
    }

  const alive = new Array<boolean>(n).fill(true)
  const size = new Array<number>(n).fill(1)
  const members: number[][] = Array.from({ length: n }, (_, i) => [i])
  let aliveCount = n
  const target = numSpeakers && numSpeakers >= 1 ? Math.floor(numSpeakers) : null

  while (aliveCount > 1 && (!target || aliveCount > target)) {
    let best = Infinity, bi = -1, bj = -1
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue
        const d = dist[i * n + j]
        if (d < best) { best = d; bi = i; bj = j }
      }
    }
    if (bi < 0) break
    if (!target && best >= distThreshold) break
    for (let k = 0; k < dim; k++) sums[bi][k] += sums[bj][k]
    size[bi] += size[bj]
    members[bi].push(...members[bj])
    members[bj] = []
    alive[bj] = false
    aliveCount--
    // 병합된 클러스터의 센트로이드가 바뀌었으니 다른 모든 클러스터와의 거리를 갱신한다.
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi) continue
      let d2 = 0
      for (let t = 0; t < dim; t++) {
        const diff = sums[bi][t] / size[bi] - sums[k][t] / size[k]
        d2 += diff * diff
      }
      const d = Math.sqrt(d2)
      dist[bi * n + k] = dist[k * n + bi] = d
    }
  }

  let clusters = members.filter((m, i) => alive[i] && m.length > 0)

  // 작은 클러스터 흡수 — durations가 있고 화자 수 강제가 아닐 때만.
  if (!target && durations) {
    const total = (m: number[]) => m.reduce((s, i) => s + durations[i], 0)
    const large = clusters.filter(m => total(m) >= SMALL_CLUSTER_SEC)
    if (large.length > 0 && large.length < clusters.length) {
      const centroids = new Map(large.map(m => [m, centroidOf(unit, m)]))
      const kept: number[][] = [...large]
      for (const m of clusters) {
        if (large.includes(m)) continue
        const c = centroidOf(unit, m)
        let bestSim = -Infinity, bestCluster: number[] | null = null
        for (const l of large) {
          const s = cosineSim(c, centroids.get(l)!)
          if (s > bestSim) { bestSim = s; bestCluster = l }
        }
        if (bestCluster && bestSim >= ABSORB_MIN_SIM) bestCluster.push(...m)
        else kept.push(m) // 큰 클러스터와 닮지 않은 소수 화자는 유지
      }
      clusters = kept
    }
  }

  const out = new Array<number>(n).fill(0)
  clusters.forEach((m, c) => m.forEach(i => { out[i] = c }))
  return out
}

/**
 * 화자 임베딩 응집 클러스터링(pyannote 3.1 방식 센트로이드 연결·유클리드 거리).
 * 센트로이드 병합은 거리가 임계 아래로 내려오는 연쇄(비단조)를 일으켜, 쌍별로는 멀어 보이는
 * 같은 화자 조각들도 클러스터가 커지며 합쳐진다.
 * - numSpeakers 지정 시 그 수까지 강제 병합(임계 무시).
 * - durations 지정 시 총 발화 SMALL_CLUSTER_SEC 미만 클러스터를 큰 클러스터로 흡수해
 *   잡음·맞장구가 화자로 승격되는 과분할을 막는다.
 * - 구간이 maxRegions를 넘으면 긴 구간만 클러스터링하고 나머지는 센트로이드 최근접 배정.
 */
export function clusterEmbeddings(embeddings: Float32Array[], opts: ClusterOpts = {}): number[] {
  const { threshold, numSpeakers, durations, maxRegions = MAX_CLUSTER_REGIONS } = opts
  const n = embeddings.length
  if (n === 0) return []
  if (!durations || n <= maxRegions) return clusterCore(embeddings, threshold, numSpeakers, durations)

  // 대형 회의: 발화가 긴(임베딩이 신뢰할 만한) 상위 maxRegions만 병합하고 나머지는 배정만.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => durations[b] - durations[a])
  const top = order.slice(0, maxRegions)
  const rest = order.slice(maxRegions)
  const subIdx = clusterCore(top.map(i => embeddings[i]), threshold, numSpeakers, top.map(i => durations[i]))

  const out = new Array<number>(n).fill(0)
  top.forEach((orig, i) => { out[orig] = subIdx[i] })
  const clusterCount = Math.max(...subIdx) + 1
  const unitAll = embeddings.map(toUnit)
  const centroids: Float32Array[] = []
  for (let c = 0; c < clusterCount; c++)
    centroids.push(centroidOf(unitAll, top.filter((_, i) => subIdx[i] === c)))
  // 어느 센트로이드와도 닮지 않은(ABSORB_MIN_SIM 미만) 구간은 강제 편입하지 않고 모아뒀다가
  // 자기들끼리 클러스터링해 새 화자로 남긴다 — 짧게만 말한 화자가 지워지는 것을 막는다.
  const leftovers: number[] = []
  for (const orig of rest) {
    let bestSim = -Infinity, bestC = 0
    for (let c = 0; c < clusterCount; c++) {
      const s = cosineSim(unitAll[orig], centroids[c])
      if (s > bestSim) { bestSim = s; bestC = c }
    }
    if (bestSim >= ABSORB_MIN_SIM) out[orig] = bestC
    else leftovers.push(orig)
  }
  if (leftovers.length > 0) {
    const leftIdx = clusterCore(leftovers.map(i => embeddings[i]), threshold, undefined, leftovers.map(i => durations[i]))
    leftovers.forEach((orig, i) => { out[orig] = clusterCount + leftIdx[i] })
  }
  return out
}

export function labelClusters(clusterIdx: number[], regionStarts: number[]): string[] {
  const firstSeen = new Map<number, number>()
  clusterIdx.forEach((c, i) => {
    const cur = firstSeen.get(c)
    if (cur === undefined || regionStarts[i] < cur) firstSeen.set(c, regionStarts[i])
  })
  const ordered = [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c)
  const nameOf = new Map(ordered.map((c, rank) => [c, `SPK${rank + 1}`]))
  return clusterIdx.map(c => nameOf.get(c)!)
}
