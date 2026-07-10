// 녹음 후처리 파이프라인. 두 진입점이 있다:
//  - runPartPipeline: 녹음 중 완성된 부(part)를 백그라운드에서 재전사→화자 구분 (요약 없음)
//  - runFinalPipeline: 세션 종료 시 마지막 부 후처리 후 전체 부 통합 요약
// 모든 실행은 enqueue()를 거쳐 직렬화된다 — Whisper 모델이 동시에 둘 이상 로드되는 것을 막고,
// 부 후처리와 최종 요약이 서로 겹치지 않게 자연히 순서가 정해진다. fire-and-forget으로 호출된다.

import { retranscribeMeeting, diarizeMeeting, summarizeMeeting, summarizeGroup } from './meetingActions'
import type { SummaryTemplate } from './summarize/prompts'

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
export async function runFinalPipeline(partIds: string[], template: SummaryTemplate = 'minutes'): Promise<void> {
  if (partIds.length === 0) return
  const lastId = partIds[partIds.length - 1]
  await runPartPipeline(lastId) // 재전사·화자 구분 — 한 단계가 실패해도 내부에서 잡고 다음으로 넘어간다.
  // 요약 결과를 사용자에게 알린다 — 자동 처리는 화면 밖에서 도는 경우가 많아, 끝났는지·왜 안 됐는지 보이게.
  let outcome: 'done' | 'no-key' | 'no-segments' | 'no-content' | 'error' = 'error'
  try {
    outcome = partIds.length > 1
      ? await summarizeGroup(partIds, template)
      : await summarizeMeeting(lastId, template)
  } catch {
    outcome = 'error'
  }
  const message = {
    done: '자동 정리가 끝났어요 — 회의록·화자·요약이 준비됐습니다.',
    'no-key': '재전사·화자 구분을 끝냈어요. AI 요약은 설정에 Gemini 키를 넣으면 자동으로 됩니다.',
    'no-segments': '재전사·화자 구분을 끝냈어요. 요약할 대화 내용이 충분하지 않았습니다.',
    'no-content': '재전사·화자 구분을 끝냈어요. 요약할 대화 내용이 충분하지 않았습니다.',
    error: '자동 정리 중 문제가 있었어요. 회의록에서 다시 시도해주세요.',
  }[outcome]
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('minuteflow:pipeline-done', { detail: { meetingId: lastId, outcome, message } }))
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
