import { downmixToMono, decodeTo16kMono, type AudioBufferLike } from './decode'

function fakeBuffer(channels: Float32Array[], sampleRate = 16000): AudioBufferLike {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    getChannelData: (i: number) => channels[i],
  }
}

test('스테레오는 (L+R)×√2/2로 다운믹스', () => {
  const out = downmixToMono([new Float32Array([1, 0]), new Float32Array([1, 1])])
  expect(out[0]).toBeCloseTo(Math.SQRT2, 5)      // (1+1)*√2/2 = √2
  expect(out[1]).toBeCloseTo(Math.SQRT2 / 2, 5)  // (0+1)*√2/2
})

test('모노는 그대로', () => {
  const mono = new Float32Array([0.1, 0.2])
  expect(downmixToMono([mono])).toBe(mono)
})

test('decodeTo16kMono는 16kHz 컨텍스트로 디코딩해 모노를 반환한다', async () => {
  const rates: number[] = []
  const createCtx = (rate: number) => {
    rates.push(rate)
    return {
      decodeAudioData: async () => fakeBuffer([new Float32Array([0.5, 0.5])]),
      close: async () => {},
    }
  }
  const out = await decodeTo16kMono(new ArrayBuffer(4), createCtx)
  expect(rates).toEqual([16000])
  expect(Array.from(out)).toEqual([0.5, 0.5])
})

test('디코딩 실패는 명확한 에러로 전파된다', async () => {
  const createCtx = () => ({
    decodeAudioData: async () => { throw new DOMException('invalid content') },
    close: async () => {},
  })
  await expect(decodeTo16kMono(new ArrayBuffer(4), createCtx)).rejects.toThrow(/디코딩/)
})
