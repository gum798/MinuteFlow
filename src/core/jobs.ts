// 회의별 장기 작업(재전사·화자 구분·요약)을 담는 전역 스토어.
// 녹음 세션(core/recorder/session.ts)과 동일하게 라우트 이동(컴포넌트 unmount)에도
// 진행 상태가 살아남도록, React 밖의 외부 스토어 + useSyncExternalStore 규약을 따른다.

export type JobKind = 'retranscribe' | 'diarize' | 'summarize'

export interface MeetingJob {
  meetingId: string
  kind: JobKind
  status: string
}

export interface JobDoneDetail {
  meetingId: string
  kind: JobKind
  error?: string
}

// 전역 작업 목록 — 변경 시에만 새 배열로 교체하고, getJobs는 그 캐시를 그대로 반환한다
// (useSyncExternalStore는 스냅샷 참조가 바뀔 때만 재렌더하므로 안정 참조가 필수).
let jobs: MeetingJob[] = []
const listeners = new Set<() => void>()

/** 목록을 새 참조로 교체하고 구독자에게 알린다. */
function commit(next: MeetingJob[]): void {
  jobs = next
  for (const l of [...listeners]) l()
}

export function subscribeJobs(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 캐시된 스냅샷을 반환한다 (변경 전까지 같은 참조). */
export function getJobs(): MeetingJob[] {
  return jobs
}

/** 해당 회의에 진행 중인 작업이 하나라도 있는지. */
export function isJobRunning(meetingId: string): boolean {
  return jobs.some(j => j.meetingId === meetingId)
}

/**
 * (meetingId, kind) 작업을 실행한다. fn은 setStatus로 진행 문구를 갱신한다.
 * 같은 (meetingId, kind)가 이미 진행 중이면 중복 실행을 막고 no-op.
 * 종료 시(성공/실패) 목록에서 제거하고 'minuteflow:job-done' CustomEvent를 발행한다
 * (실패 시 detail.error에 메시지). 이 함수 자체는 예외를 던지지 않는다.
 */
export async function runJob(
  meetingId: string,
  kind: JobKind,
  fn: (setStatus: (s: string) => void) => Promise<void>,
): Promise<void> {
  if (jobs.some(j => j.meetingId === meetingId && j.kind === kind)) return

  const isThis = (j: MeetingJob): boolean => j.meetingId === meetingId && j.kind === kind
  commit([...jobs, { meetingId, kind, status: '' }])

  const setStatus = (status: string): void => {
    commit(jobs.map(j => (isThis(j) ? { ...j, status } : j)))
  }

  let error: string | undefined
  try {
    await fn(setStatus)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    commit(jobs.filter(j => !isThis(j)))
    const detail: JobDoneDetail = error !== undefined
      ? { meetingId, kind, error }
      : { meetingId, kind }
    window.dispatchEvent(new CustomEvent<JobDoneDetail>('minuteflow:job-done', { detail }))
  }
}

/** 테스트 간 전역 작업 상태 누수를 막는다. */
export function __resetJobsForTests(): void {
  jobs = []
  listeners.clear()
}
