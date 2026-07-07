export interface AudioBufferLike {
  sampleRate: number
  numberOfChannels: number
  length: number
  duration: number
  getChannelData(i: number): Float32Array
}

export interface BaseAudioContextLike {
  decodeAudioData(b: ArrayBuffer): Promise<AudioBufferLike>
  close?(): Promise<void>
}

export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const [left, right] = channels
  const out = new Float32Array(left.length)
  for (let i = 0; i < left.length; ++i) out[i] = (Math.SQRT2 * (left[i] + right[i])) / 2
  return out
}

function defaultCreateCtx(rate: number): BaseAudioContextLike {
  return new AudioContext({ sampleRate: rate }) as unknown as BaseAudioContextLike
}

async function resampleTo16k(buffer: AudioBufferLike): Promise<Float32Array> {
  // 방어 경로: 컨텍스트가 16kHz를 무시한 드문 경우 (스펙상 리샘플은 should)
  const length = Math.ceil(buffer.duration * 16000)
  const off = new OfflineAudioContext(1, length, 16000)
  const src = off.createBufferSource()
  const real = new AudioBuffer({
    length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate,
  })
  for (let c = 0; c < buffer.numberOfChannels; c++) real.copyToChannel(buffer.getChannelData(c) as Float32Array<ArrayBuffer>, c)
  src.buffer = real
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

export async function decodeTo16kMono(
  data: ArrayBuffer,
  createCtx: (rate: number) => BaseAudioContextLike = defaultCreateCtx,
): Promise<Float32Array> {
  const ctx = createCtx(16000)
  let decoded: AudioBufferLike
  try {
    decoded = await ctx.decodeAudioData(data)
  } catch {
    throw new Error('오디오를 디코딩할 수 없습니다. 지원되지 않는 형식이거나 손상된 파일입니다.')
  } finally {
    void ctx.close?.()
  }
  if (decoded.sampleRate !== 16000) return resampleTo16k(decoded)
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i))
  return downmixToMono(channels.slice(0, 2))
}
