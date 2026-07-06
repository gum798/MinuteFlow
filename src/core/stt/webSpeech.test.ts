import { WebSpeechEngine, getSpeechRecognitionCtor, type WebSpeechEvents } from './webSpeech'

class FakeRecognition {
  static instances: FakeRecognition[] = []
  lang = ''
  continuous = false
  interimResults = false
  onresult: ((ev: unknown) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  started = 0
  constructor() { FakeRecognition.instances.push(this) }
  start() { this.started++ }
  stop() { this.onend?.() }
  abort() {}
  emitResult(items: Array<{ text: string; isFinal: boolean }>, resultIndex = 0) {
    const results = items.map(i => Object.assign([{ transcript: i.text }], { isFinal: i.isFinal }))
    this.onresult?.({ resultIndex, results })
  }
}

function make() {
  FakeRecognition.instances = []
  const events: WebSpeechEvents = { onInterim: vi.fn(), onFinal: vi.fn(), onStatus: vi.fn() }
  const engine = new WebSpeechEngine(FakeRecognition as never, 'ko-KR', events)
  return { engine, events }
}

test('start는 ko-KR continuous 인식을 시작한다', () => {
  const { engine, events } = make()
  engine.start()
  const rec = FakeRecognition.instances[0]
  expect(rec.lang).toBe('ko-KR')
  expect(rec.continuous).toBe(true)
  expect(rec.interimResults).toBe(true)
  expect(rec.started).toBe(1)
  expect(events.onStatus).toHaveBeenLastCalledWith('listening')
})

test('final 결과는 onFinal, 중간 결과는 onInterim', () => {
  const { engine, events } = make()
  engine.start()
  const rec = FakeRecognition.instances[0]
  rec.emitResult([{ text: '안녕하세요', isFinal: false }])
  expect(events.onInterim).toHaveBeenLastCalledWith('안녕하세요')
  rec.emitResult([{ text: '안녕하세요 여러분', isFinal: true }])
  expect(events.onFinal).toHaveBeenLastCalledWith('안녕하세요 여러분')
  expect(events.onInterim).toHaveBeenLastCalledWith('')
})

test('스스로 멈추면 자동 재시작한다', () => {
  const { engine, events } = make()
  engine.start()
  const rec = FakeRecognition.instances[0]
  rec.onend?.()
  expect(rec.started).toBe(2)
  expect(events.onStatus).toHaveBeenCalledWith('restarting')
  expect(events.onStatus).toHaveBeenLastCalledWith('listening')
})

test('사용자 stop 후에는 재시작하지 않는다', () => {
  const { engine, events } = make()
  engine.start()
  const rec = FakeRecognition.instances[0]
  engine.stop()
  expect(rec.started).toBe(1)
  expect(events.onStatus).toHaveBeenLastCalledWith('stopped')
})

test('getSpeechRecognitionCtor는 프리픽스 폴백한다', () => {
  expect(getSpeechRecognitionCtor({})).toBeNull()
  expect(getSpeechRecognitionCtor({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition)
  expect(getSpeechRecognitionCtor({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition)
})
