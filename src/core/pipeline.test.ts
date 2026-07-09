import { runAutoPipeline } from './pipeline'

// meetingActions를 목으로 대체해 파이프라인의 순서·중단 로직만 검증한다.
const retranscribeMock = vi.fn(async (_id: string) => 'done')
const diarizeMock = vi.fn(async (_id: string) => 'done')
const summarizeMock = vi.fn(async (_id: string, _t: string) => 'done')
vi.mock('./meetingActions', () => ({
  retranscribeMeeting: (id: string) => retranscribeMock(id),
  diarizeMeeting: (id: string) => diarizeMock(id),
  summarizeMeeting: (id: string, t: string) => summarizeMock(id, t),
}))

beforeEach(() => {
  retranscribeMock.mockReset().mockResolvedValue('done')
  diarizeMock.mockReset().mockResolvedValue('done')
  summarizeMock.mockReset().mockResolvedValue('done')
})

test('재전사 → 화자 구분 → 요약 순서로 실행한다', async () => {
  const order: string[] = []
  retranscribeMock.mockImplementation(async () => { order.push('retranscribe'); return 'done' })
  diarizeMock.mockImplementation(async () => { order.push('diarize'); return 'done' })
  summarizeMock.mockImplementation(async () => { order.push('summarize'); return 'done' })
  await runAutoPipeline('m1')
  expect(order).toEqual(['retranscribe', 'diarize', 'summarize'])
  expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
})

test("재전사가 'no-audio'면 이후 단계를 실행하지 않는다", async () => {
  retranscribeMock.mockResolvedValue('no-audio')
  await runAutoPipeline('m1')
  expect(diarizeMock).not.toHaveBeenCalled()
  expect(summarizeMock).not.toHaveBeenCalled()
})

test('재전사가 throw하면 중단된다', async () => {
  retranscribeMock.mockRejectedValue(new Error('boom'))
  await expect(runAutoPipeline('m1')).resolves.toBeUndefined()
  expect(diarizeMock).not.toHaveBeenCalled()
  expect(summarizeMock).not.toHaveBeenCalled()
})

test("재전사가 'empty'여도 화자 구분·요약을 계속한다", async () => {
  retranscribeMock.mockResolvedValue('empty')
  await runAutoPipeline('m1')
  expect(diarizeMock).toHaveBeenCalled()
  expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
})

test("요약이 'no-key'면 조용히 종료한다", async () => {
  summarizeMock.mockResolvedValue('no-key')
  await expect(runAutoPipeline('m1')).resolves.toBeUndefined()
  expect(summarizeMock).toHaveBeenCalled()
})
