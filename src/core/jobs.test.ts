import { subscribeJobs, getJobs, isJobRunning, runJob, __resetJobsForTests, type JobDoneDetail } from './jobs'

beforeEach(() => __resetJobsForTests())
afterEach(() => __resetJobsForTests())

function collectDone(): { events: JobDoneDetail[]; stop: () => void } {
  const events: JobDoneDetail[] = []
  const handler = (e: Event): void => { events.push((e as CustomEvent<JobDoneDetail>).detail) }
  window.addEventListener('minuteflow:job-done', handler)
  return { events, stop: () => window.removeEventListener('minuteflow:job-done', handler) }
}

test('실행 중에는 스냅샷에 진행 문구와 함께 노출된다', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const cb = vi.fn()
  subscribeJobs(cb)

  const p = runJob('m1', 'diarize', async setStatus => {
    setStatus('화자 구분 중…')
    await gate
  })

  expect(getJobs()).toEqual([{ meetingId: 'm1', kind: 'diarize', status: '화자 구분 중…' }])
  expect(isJobRunning('m1')).toBe(true)
  expect(cb).toHaveBeenCalled()
  // getJobs는 변경 전까지 같은 참조 (useSyncExternalStore 안전)
  expect(getJobs()).toBe(getJobs())

  release()
  await p
  expect(getJobs()).toEqual([])
  expect(isJobRunning('m1')).toBe(false)
})

test('같은 (meetingId,kind)가 진행 중이면 중복 실행은 no-op — fn은 1회만 실행', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const fn = vi.fn(async () => { await gate })

  const p1 = runJob('m1', 'diarize', fn)
  const p2 = runJob('m1', 'diarize', fn) // 진행 중 → no-op
  expect(fn).toHaveBeenCalledTimes(1)
  expect(getJobs()).toHaveLength(1)

  release()
  await Promise.all([p1, p2])
})

test('완료 시 목록에서 제거되고 job-done 이벤트(detail)를 발행한다', async () => {
  const { events, stop } = collectDone()
  await runJob('m1', 'summarize', async () => {})
  stop()
  expect(getJobs()).toEqual([])
  expect(events).toEqual([{ meetingId: 'm1', kind: 'summarize' }])
})

test('실패 시 job-done 이벤트 detail.error에 메시지를 담고 목록에서 제거한다', async () => {
  const { events, stop } = collectDone()
  await runJob('m1', 'retranscribe', async () => { throw new Error('전사 실패') })
  stop()
  expect(getJobs()).toEqual([])
  expect(events).toEqual([{ meetingId: 'm1', kind: 'retranscribe', error: '전사 실패' }])
})

test('getJobs()는 변경 전까지 같은 참조, 추가/제거 시엔 새 참조를 반환한다 (useSyncExternalStore 안정성)', async () => {
  const empty = getJobs()
  expect(getJobs()).toBe(empty) // 변경 없음 → 같은 참조 유지

  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const p = runJob('m1', 'diarize', async () => { await gate })

  const running = getJobs()
  expect(running).not.toBe(empty)   // 작업 추가 → 새 참조
  expect(getJobs()).toBe(running)   // 이후 변경이 없으면 같은 참조 유지

  release()
  await p
  const after = getJobs()
  expect(after).not.toBe(running)   // 작업 제거 → 새 참조
  expect(after).toEqual([])
})

test('여러 회의의 작업이 독립적으로 공존하고 isJobRunning은 각각 반영한다', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const p1 = runJob('m1', 'summarize', async () => { await gate })
  const p2 = runJob('m2', 'diarize', async () => { await gate })

  expect(getJobs()).toHaveLength(2)
  expect(isJobRunning('m1')).toBe(true)
  expect(isJobRunning('m2')).toBe(true)
  expect(isJobRunning('m3')).toBe(false)

  release()
  await Promise.all([p1, p2])
  expect(getJobs()).toEqual([])
  expect(isJobRunning('m1')).toBe(false)
  expect(isJobRunning('m2')).toBe(false)
})
