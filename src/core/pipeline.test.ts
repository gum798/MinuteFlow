import { enqueue, runPartPipeline, runFinalPipeline, runAutoPipeline, __resetPipelineForTests } from './pipeline'

// meetingActions를 목으로 대체해 파이프라인의 순서·위임 로직만 검증한다.
const retranscribeMock = vi.fn(async (_id: string) => 'done')
const diarizeMock = vi.fn(async (_id: string) => 'done')
const summarizeMock = vi.fn(async (_id: string, _t: string) => 'done')
const summarizeGroupMock = vi.fn(async (_ids: string[], _t: string) => 'done')
vi.mock('./meetingActions', () => ({
  retranscribeMeeting: (id: string) => retranscribeMock(id),
  diarizeMeeting: (id: string) => diarizeMock(id),
  summarizeMeeting: (id: string, t: string) => summarizeMock(id, t),
  summarizeGroup: (ids: string[], t: string) => summarizeGroupMock(ids, t),
}))

beforeEach(() => {
  __resetPipelineForTests()
  retranscribeMock.mockReset().mockResolvedValue('done')
  diarizeMock.mockReset().mockResolvedValue('done')
  summarizeMock.mockReset().mockResolvedValue('done')
  summarizeGroupMock.mockReset().mockResolvedValue('done')
})

const tick = () => new Promise(r => setTimeout(r, 5))

describe('enqueue — 순차 큐', () => {
  test('넣은 fn들이 순서대로, 서로 겹치지 않게 실행된다', async () => {
    const order: string[] = []
    const p1 = enqueue(async () => { order.push('a-start'); await tick(); order.push('a-end') })
    const p2 = enqueue(async () => { order.push('b-start'); await tick(); order.push('b-end') })
    await Promise.all([p1, p2])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  test('앞 fn이 throw해도 뒤 fn은 실행된다', async () => {
    const ran: string[] = []
    const p1 = enqueue(async () => { throw new Error('boom') })
    const p2 = enqueue(async () => { ran.push('b') })
    await p1.catch(() => {})
    await p2
    expect(ran).toEqual(['b'])
  })

  test('반환 promise는 해당 fn의 완료(거부 포함)를 나타낸다', async () => {
    await expect(enqueue(async () => { throw new Error('x') })).rejects.toThrow('x')
  })
})

describe('runPartPipeline — 부 후처리 (요약 없음)', () => {
  test('재전사 → 화자 구분 순서로 실행하고 요약은 하지 않는다', async () => {
    const order: string[] = []
    retranscribeMock.mockImplementation(async () => { order.push('retranscribe'); return 'done' })
    diarizeMock.mockImplementation(async () => { order.push('diarize'); return 'done' })
    await runPartPipeline('m1')
    expect(order).toEqual(['retranscribe', 'diarize'])
    expect(summarizeMock).not.toHaveBeenCalled()
    expect(summarizeGroupMock).not.toHaveBeenCalled()
  })

  test("재전사가 'no-audio'면 화자 구분을 하지 않는다", async () => {
    retranscribeMock.mockResolvedValue('no-audio')
    await runPartPipeline('m1')
    expect(diarizeMock).not.toHaveBeenCalled()
  })

  test('재전사가 throw해도 던지지 않고 중단한다', async () => {
    retranscribeMock.mockRejectedValue(new Error('boom'))
    await expect(runPartPipeline('m1')).resolves.toBe(false)
    expect(diarizeMock).not.toHaveBeenCalled()
  })

  test("재전사가 'too-long'이면 화자 구분을 건너뛰고 true를 반환한다", async () => {
    retranscribeMock.mockResolvedValue('too-long')
    await expect(runPartPipeline('m1')).resolves.toBe(true)
    expect(diarizeMock).not.toHaveBeenCalled()
  })
})

describe('runFinalPipeline — 마지막 부 후처리 후 통합/단일 요약', () => {
  test('여러 부면 마지막 부 후처리 후 summarizeGroup을 전체 부 id로 호출한다', async () => {
    await runFinalPipeline(['m1', 'm2', 'm3'])
    expect(retranscribeMock).toHaveBeenCalledWith('m3') // 마지막 부만 후처리
    expect(diarizeMock).toHaveBeenCalledWith('m3')
    expect(summarizeGroupMock).toHaveBeenCalledWith(['m1', 'm2', 'm3'], 'minutes')
    expect(summarizeMock).not.toHaveBeenCalled()
  })

  test('단일 부면 summarizeMeeting을 호출한다', async () => {
    await runFinalPipeline(['m1'])
    expect(retranscribeMock).toHaveBeenCalledWith('m1')
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
    expect(summarizeGroupMock).not.toHaveBeenCalled()
  })

  test('빈 배열이면 아무것도 하지 않는다', async () => {
    await runFinalPipeline([])
    expect(retranscribeMock).not.toHaveBeenCalled()
    expect(summarizeMock).not.toHaveBeenCalled()
    expect(summarizeGroupMock).not.toHaveBeenCalled()
  })
})

test('runAutoPipeline은 단일-부 최종 파이프라인에 위임한다(호환)', async () => {
  const order: string[] = []
  retranscribeMock.mockImplementation(async () => { order.push('retranscribe'); return 'done' })
  diarizeMock.mockImplementation(async () => { order.push('diarize'); return 'done' })
  summarizeMock.mockImplementation(async () => { order.push('summarize'); return 'done' })
  await runAutoPipeline('m1')
  expect(order).toEqual(['retranscribe', 'diarize', 'summarize'])
  expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
})

describe('runFinalPipeline — 템플릿 전달', () => {
  test('단일 부: template을 summarizeMeeting에 그대로 넘긴다', async () => {
    await runFinalPipeline(['m1'], 'brief')
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'brief')
    expect(summarizeGroupMock).not.toHaveBeenCalled()
  })

  test('여러 부: template을 summarizeGroup에 그대로 넘긴다', async () => {
    await runFinalPipeline(['m1', 'm2'], 'timeline')
    expect(summarizeGroupMock).toHaveBeenCalledWith(['m1', 'm2'], 'timeline')
    expect(summarizeMock).not.toHaveBeenCalled()
  })

  test('template 미지정 시 기본 minutes로 요약한다', async () => {
    await runFinalPipeline(['m1'])
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
  })
})

// 버그 1("자동으로 하는것만 안되"): 화자 구분 단계가 어떤 식으로 실패하든 요약은 반드시 실행돼야 한다.
describe('runFinalPipeline — 화자 구분/재전사 실패에도 요약은 진행 (버그 1)', () => {
  test("화자 구분이 'empty'여도 요약은 호출된다", async () => {
    diarizeMock.mockResolvedValue('empty')
    await runFinalPipeline(['m1'])
    expect(diarizeMock).toHaveBeenCalledWith('m1')
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
  })

  test("화자 구분이 'no-audio'여도 요약은 호출된다", async () => {
    diarizeMock.mockResolvedValue('no-audio')
    await runFinalPipeline(['m1'])
    expect(diarizeMock).toHaveBeenCalledWith('m1')
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
  })

  test('화자 구분이 throw해도 요약은 호출된다', async () => {
    diarizeMock.mockRejectedValue(new Error('diar boom'))
    await runFinalPipeline(['m1'])
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
  })

  test("재전사가 'no-audio'면 화자 구분은 건너뛰지만 요약은 여전히 진행된다", async () => {
    retranscribeMock.mockResolvedValue('no-audio')
    await runFinalPipeline(['m1'])
    expect(diarizeMock).not.toHaveBeenCalled()
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
  })

  test('재전사가 throw해도 요약은 여전히 진행된다', async () => {
    retranscribeMock.mockRejectedValue(new Error('retr boom'))
    await runFinalPipeline(['m1'])
    expect(diarizeMock).not.toHaveBeenCalled()
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
  })
})

// pipeline-done 이벤트: 자동 처리는 화면 밖에서 도는 경우가 많아, 모든 결과가 사용자에게 표면화돼야 한다.
type PipelineDoneDetail = { meetingId: string; outcome: string; message: string }
function collectPipelineDone(): { events: PipelineDoneDetail[]; stop: () => void } {
  const events: PipelineDoneDetail[] = []
  const handler = (e: Event): void => { events.push((e as CustomEvent<PipelineDoneDetail>).detail) }
  window.addEventListener('minuteflow:pipeline-done', handler)
  return { events, stop: () => window.removeEventListener('minuteflow:pipeline-done', handler) }
}

describe('runFinalPipeline — pipeline-done 이벤트', () => {
  // 단일 부에서 도달 가능한 outcome들 (no-segments는 단일 부 summarizeMeeting에서만 나온다).
  test.each(['done', 'no-key', 'no-content', 'no-segments'] as const)(
    "결과 '%s'면 이벤트를 정확히 1번, 비어있지 않은 message와 함께 발행한다",
    async outcome => {
      summarizeMock.mockResolvedValue(outcome)
      const { events, stop } = collectPipelineDone()
      await runFinalPipeline(['m1'])
      stop()
      expect(events).toHaveLength(1)
      expect(events[0].meetingId).toBe('m1')
      expect(events[0].outcome).toBe(outcome)
      expect(typeof events[0].message).toBe('string')
      expect(events[0].message.length).toBeGreaterThan(0)
    },
  )

  test("요약이 throw하면 outcome 'error'로 이벤트를 발행한다", async () => {
    summarizeMock.mockRejectedValue(new Error('summ boom'))
    const { events, stop } = collectPipelineDone()
    await runFinalPipeline(['m1'])
    stop()
    expect(events).toHaveLength(1)
    expect(events[0].outcome).toBe('error')
    expect(events[0].message.length).toBeGreaterThan(0)
  })

  test('여러 부면 meetingId는 마지막 부 id다', async () => {
    summarizeGroupMock.mockResolvedValue('done')
    const { events, stop } = collectPipelineDone()
    await runFinalPipeline(['m1', 'm2', 'm3'])
    stop()
    expect(events).toHaveLength(1)
    expect(events[0].meetingId).toBe('m3')
    expect(events[0].outcome).toBe('done')
  })

  test('빈 배열이면 이벤트를 발행하지 않는다', async () => {
    const { events, stop } = collectPipelineDone()
    await runFinalPipeline([])
    stop()
    expect(events).toEqual([])
  })

  test('모든 outcome 값에 대해 message가 정의돼 있다 (undefined/빈 문자열 없음)', async () => {
    for (const outcome of ['done', 'no-key', 'no-content', 'no-segments'] as const) {
      summarizeMock.mockReset().mockResolvedValue(outcome)
      const { events, stop } = collectPipelineDone()
      await runFinalPipeline(['m1'])
      stop()
      expect(events[0].message).toBeDefined()
      expect(events[0].message).not.toBe('')
    }
    // error outcome도 메시지가 있어야 한다.
    summarizeMock.mockReset().mockRejectedValue(new Error('x'))
    const { events, stop } = collectPipelineDone()
    await runFinalPipeline(['m1'])
    stop()
    expect(events[0].message).toBeDefined()
    expect(events[0].message).not.toBe('')
  })
})

// 버그("자동정리 눌러도 아무것도 안돼"): 너무 긴 녹음은 재전사·화자 구분을 건너뛰고 요약만 진행하되,
// 사용자에게 건너뛴 사실을 message로 알려야 한다.
describe('runFinalPipeline — 너무 긴 녹음(재전사 too-long)', () => {
  test('재전사·화자 구분은 건너뛰지만 요약은 진행하고, message로 건너뜀을 알린다', async () => {
    retranscribeMock.mockResolvedValue('too-long')
    summarizeMock.mockResolvedValue('done')
    const { events, stop } = collectPipelineDone()
    await runFinalPipeline(['m1'])
    stop()
    expect(diarizeMock).not.toHaveBeenCalled()
    expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
    expect(events).toHaveLength(1)
    expect(events[0].outcome).toBe('done')
    expect(events[0].message).toContain('건너뛰')
  })

  test('키가 없어도(no-key) 건너뜀 안내 message를 발행한다', async () => {
    retranscribeMock.mockResolvedValue('too-long')
    summarizeMock.mockResolvedValue('no-key')
    const { events, stop } = collectPipelineDone()
    await runFinalPipeline(['m1'])
    stop()
    expect(events[0].outcome).toBe('no-key')
    expect(events[0].message).toContain('건너뛰')
    expect(events[0].message.length).toBeGreaterThan(0)
  })
})
