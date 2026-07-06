import { ChunkedRecorder, type ChunkedRecorderEvents } from './chunkedRecorder'

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  ondataavailable: ((ev: { data: Blob }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onstop: (() => void) | null = null
  state = 'inactive'
  constructor(public stream: MediaStream, public options?: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this)
  }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.onstop?.() }
  requestData() {}
  emit(data = 'x') { this.ondataavailable?.({ data: new Blob([data]) }) }
}

function make(events: Partial<ChunkedRecorderEvents> = {}) {
  const ev: ChunkedRecorderEvents = {
    onChunk: vi.fn(), onStallRestart: vi.fn(), onError: vi.fn(), ...events,
  }
  const rec = new ChunkedRecorder({} as MediaStream, ev, {
    mimeType: 'audio/webm',
    createRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
  })
  return { rec, ev }
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

test('청크마다 onChunk가 증가하는 seq로 불린다', () => {
  const { rec, ev } = make()
  rec.start()
  const inner = FakeMediaRecorder.instances[0]
  inner.emit('a')
  inner.emit('b')
  expect(ev.onChunk).toHaveBeenNthCalledWith(1, expect.any(Blob), 0)
  expect(ev.onChunk).toHaveBeenNthCalledWith(2, expect.any(Blob), 1)
})

test('빈 blob은 무시한다', () => {
  const { rec, ev } = make()
  rec.start()
  FakeMediaRecorder.instances[0].ondataavailable?.({ data: new Blob([]) })
  expect(ev.onChunk).not.toHaveBeenCalled()
})

test('25초간 청크가 없으면 재시작하고 seq는 이어진다', () => {
  const { rec, ev } = make()
  rec.start()
  FakeMediaRecorder.instances[0].emit('a') // seq 0
  vi.advanceTimersByTime(26_000)
  expect(ev.onStallRestart).toHaveBeenCalledTimes(1)
  expect(FakeMediaRecorder.instances).toHaveLength(2) // 재생성됨
  FakeMediaRecorder.instances[1].emit('b')
  expect(ev.onChunk).toHaveBeenLastCalledWith(expect.any(Blob), 1)
})

test('정상 수신 중에는 재시작하지 않는다', () => {
  const { rec, ev } = make()
  rec.start()
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(10_000)
    FakeMediaRecorder.instances[0].emit(`c${i}`)
  }
  expect(ev.onStallRestart).not.toHaveBeenCalled()
})

test('stop()은 flush 후 resolve하고 워치독을 멈춘다', async () => {
  const { rec, ev } = make()
  rec.start()
  const p = rec.stop()
  await p
  vi.advanceTimersByTime(60_000)
  expect(ev.onStallRestart).not.toHaveBeenCalled()
})
