import { WhisperLocalEngine, detectWebGPU } from './whisperLocal'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  posted: unknown[] = []
  terminated = false
  constructor() { FakeWorker.instances.push(this) }
  postMessage(msg: unknown) { this.posted.push(msg) }
  terminate() { this.terminated = true }
  emit(data: unknown) { this.onmessage?.({ data }) }
}

beforeEach(() => { FakeWorker.instances = [] })

function makeEngine() {
  return new WhisperLocalEngine(() => new FakeWorker() as unknown as Worker)
}

test('transcribe는 워커에 오디오·옵션을 보내고 done 청크를 세그먼트로 변환한다', async () => {
  const engine = makeEngine()
  const audio = new Float32Array([0.1])
  const p = engine.transcribe(audio, {
    model: 'onnx-community/whisper-base', device: 'wasm', language: 'ko',
  })
  const w = FakeWorker.instances[0]
  expect(w.posted[0]).toMatchObject({ type: 'transcribe', model: 'onnx-community/whisper-base', device: 'wasm', language: 'ko' })
  w.emit({ status: 'done', chunks: [
    { text: ' 안녕하세요', timestamp: [0, 3.2] },
    { text: ' 반갑습니다', timestamp: [3.2, null] },
  ] })
  const segs = await p
  expect(segs).toEqual([
    { startSec: 0, endSec: 3.2, text: '안녕하세요' },
    { startSec: 3.2, endSec: 3.2, text: '반갑습니다' }, // null end 방어
  ])
})

test('progress 이벤트가 onProgress로 전달된다', async () => {
  const engine = makeEngine()
  const seen: unknown[] = []
  const p = engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' }, x => seen.push(x))
  const w = FakeWorker.instances[0]
  w.emit({ status: 'progress', file: 'model.onnx', progress: 42 })
  w.emit({ status: 'info', message: '워밍업 중' })
  w.emit({ status: 'done', chunks: [] })
  await p
  expect(seen).toEqual([
    { kind: 'download', file: 'model.onnx', progress: 42 },
    { kind: 'status', message: '워밍업 중' },
  ])
})

test('error 상태는 reject된다', async () => {
  const engine = makeEngine()
  const p = engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' })
  FakeWorker.instances[0].emit({ status: 'error', message: '메모리 부족' })
  await expect(p).rejects.toThrow('메모리 부족')
})

test('dispose는 워커를 종료한다', () => {
  const engine = makeEngine()
  void engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' }).catch(() => {})
  engine.dispose()
  expect(FakeWorker.instances[0].terminated).toBe(true)
})

test('진행 중 두 번째 transcribe 호출은 즉시 reject된다', async () => {
  const engine = makeEngine()
  const first = engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' })
  const second = engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' })
  await expect(second).rejects.toThrow('이미 전사가 진행 중입니다')
  expect(FakeWorker.instances).toHaveLength(1) // 두 번째 호출은 워커를 새로 만들지 않는다
  FakeWorker.instances[0].emit({ status: 'done', chunks: [] })
  expect(await first).toEqual([]) // 첫 작업은 정상 완료된다
})

test('dispose는 진행 중 Promise를 취소 에러로 reject한다', async () => {
  const engine = makeEngine()
  const p = engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' })
  engine.dispose()
  await expect(p).rejects.toThrow('전사가 취소되었습니다')
  expect(FakeWorker.instances[0].terminated).toBe(true)
})

test('detectWebGPU는 adapter가 null이면 false', async () => {
  vi.stubGlobal('navigator', { ...navigator, gpu: { requestAdapter: async () => null } })
  expect(await detectWebGPU()).toBe(false)
  vi.stubGlobal('navigator', { ...navigator, gpu: undefined })
  expect(await detectWebGPU()).toBe(false)
  vi.stubGlobal('navigator', { ...navigator, gpu: { requestAdapter: async () => ({}) } })
  expect(await detectWebGPU()).toBe(true)
  vi.unstubAllGlobals()
})
