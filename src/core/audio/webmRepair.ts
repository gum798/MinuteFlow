// WebM/EBML 헤더 잃은 "고아 오디오" 자동 수선.
//
// MediaRecorder를 timeslice로 돌리면 **첫 청크에만** WebM 초기화 세그먼트(EBML 헤더 +
// Segment 메타 + Tracks)가 담긴다. 앞 청크가 유실되면 남은 바이트는 Cluster(0x1F43B675)부터
// 시작하는 헤더 없는 스트림이라 `decodeAudioData`가 거부한다.
//
// 같은 브라우저에서 동일 mimeType으로 짧은 무음 녹음을 만들어 그 초기화 세그먼트(첫 Cluster
// 이전 바이트)만 이식하면 다시 디코딩 가능해진다.

export const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]
export const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75]

/** 바이트열이 EBML 시그니처(정상 WebM 시작)로 시작하는지. */
export function startsWithEbml(bytes: Uint8Array): boolean {
  if (bytes.length < EBML_MAGIC.length) return false
  return EBML_MAGIC.every((v, i) => bytes[i] === v)
}

/** 첫 Cluster(0x1F43B675) 시작 오프셋을 단순 바이트 스캔으로 찾는다. 없으면 -1. */
export function findClusterOffset(bytes: Uint8Array, from = 0): number {
  const [a, b, c, d] = CLUSTER_ID
  for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
    if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) return i
  }
  return -1
}

/**
 * 마이크 없이 도너 헤더를 캡처한다.
 * AudioContext의 MediaStreamDestination(소스 미연결 = 무음)을 동일 mimeType으로 짧게 녹음해
 * 첫 Cluster 이전 바이트 = 초기화 세그먼트만 잘라 반환한다. 실패/미지원 시 null.
 */
export async function captureDonorHeader(mimeType: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') return null
  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext()
    // 사용자 제스처 뒤 여러 await로 transient activation이 만료됐을 수 있으니 명시적으로 재개한다
    // — suspended 상태면 그래프가 렌더링되지 않아 무음 스트림에 Cluster가 생기지 않는다.
    try { await ctx.resume() } catch { /* resume 불가 시 그대로 진행 */ }
    const dest = ctx.createMediaStreamDestination()
    // 소스를 아예 연결하지 않으면 Chrome은 프레임을 전혀 내보내지 않아 MediaRecorder가
    // dataavailable을 발화하지 않는다. 오실레이터를 gain 0으로 통과시켜 "무음이지만 살아있는"
    // 스트림을 만든다 — 마이크 불필요, 소리도 안 나지만 인코더에는 무음 프레임이 흘러 헤더가 생긴다.
    const osc = ctx.createOscillator()
    const silent = ctx.createGain()
    silent.gain.value = 0
    osc.connect(silent).connect(dest)
    osc.start()
    const options: MediaRecorderOptions | undefined =
      MediaRecorder.isTypeSupported(mimeType) ? { mimeType } : undefined
    const rec = new MediaRecorder(dest.stream, options)
    const chunks: Blob[] = []

    // 첫 dataavailable 2개 정도 모으거나 3초 타임아웃까지 대기.
    await new Promise<void>(resolve => {
      let settled = false
      const finish = () => { if (!settled) { settled = true; resolve() } }
      const timer = setTimeout(finish, 3000) // 3초 타임아웃 가드
      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
        if (chunks.length >= 2) { clearTimeout(timer); finish() }
      }
      rec.start(200)
    })

    // stop은 마지막 청크를 flush한 뒤 onstop을 발화한다.
    await new Promise<void>(resolve => {
      rec.onstop = () => resolve()
      try { rec.stop() } catch { resolve() }
    })

    const merged = new Uint8Array(await new Blob(chunks).arrayBuffer())
    const clusterOffset = findClusterOffset(merged)
    if (clusterOffset <= 0) return null // Cluster 못 찾음(=헤더 경계 불명) 또는 헤더 부재
    return merged.slice(0, clusterOffset)
  } catch {
    return null
  } finally {
    try { await ctx?.close() } catch { /* 이미 닫힘 */ }
  }
}

/**
 * 헤더 없는 WebM이면 도너 헤더를 이식해 새 Blob을 반환한다.
 * 이미 헤더가 있거나(수선 불필요) Cluster를 못 찾거나 도너 캡처 실패 시 null.
 */
export async function repairHeaderlessWebm(blob: Blob): Promise<Blob | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (startsWithEbml(bytes)) return null // 이미 정상 헤더 — 수선 불필요
  const clusterOffset = findClusterOffset(bytes)
  if (clusterOffset < 0) return null // Cluster 없음 — WebM 고아 오디오가 아님
  const type = blob.type || 'audio/webm'
  const donor = await captureDonorHeader(type)
  if (!donor) return null
  const body = bytes.subarray(clusterOffset) // 첫 Cluster부터의 본문
  return new Blob([donor, body], { type })
}
