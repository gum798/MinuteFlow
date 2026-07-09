// 녹음 후처리 파이프라인. 두 진입점이 있다:
//  - runPartPipeline: 녹음 중 완성된 부(part)를 백그라운드에서 재전사→화자 구분 (요약 없음)
//  - runFinalPipeline: 세션 종료 시 마지막 부 후처리 후 전체 부 통합 요약
// 모든 실행은 enqueue()를 거쳐 직렬화된다 — Whisper 모델이 동시에 둘 이상 로드되는 것을 막고,
// 부 후처리와 최종 요약이 서로 겹치지 않게 자연히 순서가 정해진다. fire-and-forget으로 호출된다.

import { retranscribeMeeting, diarizeMeeting, summarizeMeeting, summarizeGroup } from './meetingActions'

// 순차 실행 큐의 꼬리. enqueue마다 chain.then(fn)으로 이어 붙인다.
let chain: Promise<void> = Promise.resolve()

/**
 * fn을 순차 큐에 넣고, 이번 fn의 완료를 나타내는 promise를 반환한다.
 * 앞선 작업이 실패해도 큐는 끊기지 않는다(다음 fn은 계속 실행) — chain은 항상 거부되지 않게 유지한다.
 */
export function enqueue(fn: () => Promise<void>): Promise<void> {
  const result = chain.then(fn)
  chain = result.catch(() => {}) // 체인은 절대 거부하지 않게 하여 이후 작업이 계속 실행되도록
  return result
}

/**
 * 완성된 한 부(part)의 후처리: 재전사 → 화자 구분 (요약 없음 — 요약은 세션 종료 시 통합해서 한다).
 * 재전사가 오디오 없음('no-audio')이거나 실패(throw)면 중단. 예외는 이미 job-done 이벤트로 표면화된다.
 */
export async function runPartPipeline(meetingId: string): Promise<void> {
  try {
    const transcribed = await retranscribeMeeting(meetingId)
    if (transcribed === 'no-audio') return // 재전사할 오디오가 없으면 화자 구분도 의미 없음
    await diarizeMeeting(meetingId)
  } catch {
    // 어느 단계든 던지면 중단. 에러는 이미 runJob의 job-done(error) 이벤트로 알려졌다.
  }
}

/**
 * 세션 종료 시 최종 파이프라인: 마지막 부를 후처리한 뒤 요약한다.
 * - 여러 부면 전체를 통합해 summarizeGroup, 단일 부면 summarizeMeeting.
 * - 요약은 마지막 부 화면에 진행/결과가 표시된다(summarizeGroup·summarizeMeeting 참고).
 */
export async function runFinalPipeline(partIds: string[]): Promise<void> {
  if (partIds.length === 0) return
  const lastId = partIds[partIds.length - 1]
  await runPartPipeline(lastId)
  try {
    if (partIds.length > 1) await summarizeGroup(partIds, 'minutes')
    else await summarizeMeeting(lastId, 'minutes')
  } catch {
    // 요약 단계 예외도 job-done 이벤트로 표면화되므로 여기서는 중단만 한다.
  }
}

/**
 * 회의 하나에 대한 자동 파이프라인 (호환 유지). 이제 단일-부 최종 파이프라인에 위임한다.
 */
export async function runAutoPipeline(meetingId: string): Promise<void> {
  await runFinalPipeline([meetingId])
}

/** 테스트 간 큐 상태 누수를 막는다. */
export function __resetPipelineForTests(): void {
  chain = Promise.resolve()
}
