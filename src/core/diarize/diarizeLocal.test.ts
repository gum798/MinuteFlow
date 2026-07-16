import { DiarizeEngine } from './diarizeLocal'
import type { SpeakerRegion } from './assign'

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
  return new DiarizeEngine(() => new FakeWorker() as unknown as Worker)
}

test('diarize는 워커에 오디오를 보내고 done regions를 resolve한다', async () => {
  const engine = makeEngine()
  const audio = new Float32Array([0.1, 0.2])
  const p = engine.diarize(audio)
  const w = FakeWorker.instances[0]
  expect(w.posted[0]).toMatchObject({ type: 'diarize' })
  const regions: SpeakerRegion[] = [
    { start: 0, end: 3.2, speaker: 'SPK1' },
    { start: 3.2, end: 5, speaker: 'SPK2' },
  ]
  w.emit({ status: 'done', regions })
  expect(await p).toEqual(regions)
})

test('diarize는 numSpeakers를 워커 메시지에 실어 보낸다', async () => {
  const engine = makeEngine()
  const p = engine.diarize(new Float32Array(1), undefined, 3)
  const w = FakeWorker.instances[0]
  expect(w.posted[0]).toMatchObject({ type: 'diarize', numSpeakers: 3 })
  w.emit({ status: 'done', regions: [] })
  await p
})

test('progress·info 이벤트가 onProgress로 매핑된다', async () => {
  const engine = makeEngine()
  const seen: unknown[] = []
  const p = engine.diarize(new Float32Array(1), x => seen.push(x))
  const w = FakeWorker.instances[0]
  w.emit({ status: 'progress', file: 'model.onnx', progress: 42 })
  w.emit({ status: 'info', message: '화자 묶는 중…' })
  w.emit({ status: 'done', regions: [] })
  await p
  expect(seen).toEqual([
    { kind: 'download', file: 'model.onnx', progress: 42 },
    { kind: 'status', message: '화자 묶는 중…' },
  ])
})

test('error 상태는 reject된다', async () => {
  const engine = makeEngine()
  const p = engine.diarize(new Float32Array(1))
  FakeWorker.instances[0].emit({ status: 'error', message: '모델 로드 실패' })
  await expect(p).rejects.toThrow('모델 로드 실패')
})

test('진행 중 두 번째 diarize 호출은 즉시 reject된다', async () => {
  const engine = makeEngine()
  const first = engine.diarize(new Float32Array(1))
  const second = engine.diarize(new Float32Array(1))
  await expect(second).rejects.toThrow('이미 화자 분리가 진행 중입니다')
  expect(FakeWorker.instances).toHaveLength(1) // 두 번째 호출은 워커를 새로 만들지 않는다
  FakeWorker.instances[0].emit({ status: 'done', regions: [] })
  expect(await first).toEqual([]) // 첫 작업은 정상 완료된다
})

test('dispose는 진행 중 Promise를 취소 에러로 reject하고 워커를 종료한다', async () => {
  const engine = makeEngine()
  const p = engine.diarize(new Float32Array(1))
  engine.dispose()
  await expect(p).rejects.toThrow('화자 분리가 취소되었습니다')
  expect(FakeWorker.instances[0].terminated).toBe(true)
})

// 워커를 가짜로: 'extract' 메시지에 고정 targets/embeddings로 응답
class FakeExtractWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  postMessage(msg: { type: string }) {
    if (msg.type === 'extract') {
      queueMicrotask(() => this.onmessage?.({ data: {
        status: 'extracted',
        targets: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
        embeddings: [new Float32Array([1, 0]), new Float32Array([0, 1])],
      } } as MessageEvent))
    }
  }
  terminate() {}
}

test('DiarizeEngine.extract는 워커의 targets/embeddings를 그대로 돌려준다', async () => {
  const eng = new DiarizeEngine(() => new FakeExtractWorker() as unknown as Worker)
  const out = await eng.extract(new Float32Array(16000))
  expect(out.targets).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }])
  expect(out.embeddings).toHaveLength(2)
  expect(Array.from(out.embeddings[0])).toEqual([1, 0])
  eng.dispose()
})
