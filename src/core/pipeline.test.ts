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
    await expect(runPartPipeline('m1')).resolves.toBeUndefined()
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
