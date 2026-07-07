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

// average-linkage agglomerative: 쌍별 유사도 평균이 threshold 이상인 동안 병합
export function clusterEmbeddings(embeddings: Float32Array[], threshold = 0.75): number[] {
  const n = embeddings.length
  if (n === 0) return []
  // 쌍별 유사도 사전 계산
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      sim[i][j] = sim[j][i] = cosineSim(embeddings[i], embeddings[j])

  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i])
  const avgSim = (a: number[], b: number[]) => {
    let s = 0
    for (const i of a) for (const j of b) s += sim[i][j]
    return s / (a.length * b.length)
  }

  for (;;) {
    let best = -Infinity, bi = -1, bj = -1
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const s = avgSim(clusters[i], clusters[j])
        if (s > best) { best = s; bi = i; bj = j }
      }
    if (bi < 0 || best < threshold) break
    clusters[bi] = clusters[bi].concat(clusters[bj])
    clusters.splice(bj, 1)
    if (clusters.length === 1) break
  }

  const out = new Array<number>(n).fill(0)
  clusters.forEach((members, c) => members.forEach(m => { out[m] = c }))
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
