const SAMPLE_RATE = 16000

export function encodeWav16k(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)          // fmt chunk size
  v.setUint16(20, 1, true)           // PCM
  v.setUint16(22, 1, true)           // mono
  v.setUint32(24, SAMPLE_RATE, true)
  v.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
  v.setUint16(32, 2, true)           // block align
  v.setUint16(34, 16, true)          // bits
  writeStr(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// 750초 = 16000*750*2B = 24MB < Groq 25MB 제한
export function splitForGroq(
  samples: Float32Array,
  maxSec = 750,
): { samples: Float32Array; offsetSec: number }[] {
  const maxLen = maxSec * SAMPLE_RATE
  const parts: { samples: Float32Array; offsetSec: number }[] = []
  for (let start = 0; start < samples.length; start += maxLen) {
    parts.push({
      samples: samples.subarray(start, Math.min(start + maxLen, samples.length)),
      offsetSec: start / SAMPLE_RATE,
    })
  }
  return parts.length > 0 ? parts : [{ samples, offsetSec: 0 }]
}
