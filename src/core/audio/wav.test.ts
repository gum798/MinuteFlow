import { encodeWav16k, splitForGroq } from './wav'

test('WAV 헤더가 16kHz mono 16bit로 인코딩된다', async () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
  const blob = encodeWav16k(samples)
  const buf = new DataView(await blob.arrayBuffer())
  expect(blob.type).toBe('audio/wav')
  expect(buf.getUint32(0, false)).toBe(0x52494646) // 'RIFF'
  expect(buf.getUint32(8, false)).toBe(0x57415645) // 'WAVE'
  expect(buf.getUint32(24, true)).toBe(16000)      // sampleRate
  expect(buf.getUint16(22, true)).toBe(1)          // channels
  expect(buf.getUint16(34, true)).toBe(16)         // bits
  expect(buf.byteLength).toBe(44 + samples.length * 2)
  expect(buf.getInt16(44, true)).toBe(0)
  expect(buf.getInt16(46, true)).toBe(16384)       // 0.5 → Math.round(0.5*32767)=round(16383.5)=16384
  expect(buf.getInt16(50, true)).toBe(32767)       // 1 → 클램프 상한
  expect(buf.getInt16(52, true)).toBe(-32767)      // -1 → Math.round(-1*32767)
})

test('splitForGroq는 maxSec 단위로 오프셋과 함께 분할한다', () => {
  const oneSec = 16000
  const samples = new Float32Array(oneSec * 5) // 5초
  const parts = splitForGroq(samples, 2)
  expect(parts.map(p => p.offsetSec)).toEqual([0, 2, 4])
  expect(parts.map(p => p.samples.length)).toEqual([oneSec * 2, oneSec * 2, oneSec])
})

test('한 조각이면 분할 없음', () => {
  const parts = splitForGroq(new Float32Array(16000), 750)
  expect(parts).toHaveLength(1)
  expect(parts[0].offsetSec).toBe(0)
})
