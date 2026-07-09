// 녹음 종료 후 자동 처리 파이프라인: 재전사 → 화자 구분 → AI 요약(Gemini 키 있을 때만).
// 각 단계는 meetingActions를 통해 전역 작업 스토어에 진행 상태를 싣는다 → Meeting 화면에
// 도착하면 잡 스토어 구독으로 진행 상황이 자동 표시된다. fire-and-forget으로 호출된다.

import { retranscribeMeeting, diarizeMeeting, summarizeMeeting } from './meetingActions'

/**
 * 회의 하나에 대해 자동 파이프라인을 순차 실행한다.
 * - 재전사가 오디오 없음('no-audio')이거나 실패(throw)면 중단.
 * - 재전사가 'done'/'empty'면 화자 구분으로 진행하고, 이어서 요약을 시도한다.
 * - 요약은 Gemini 키가 없으면 'no-key'로 조용히 스킵된다.
 * 각 단계의 예외는 이미 job-done 이벤트로 표면화되므로, 여기서는 중단만 하고 재throw하지 않는다.
 */
export async function runAutoPipeline(meetingId: string): Promise<void> {
  try {
    const transcribed = await retranscribeMeeting(meetingId)
    if (transcribed === 'no-audio') return // 재전사할 오디오가 없으면 이후 단계도 의미 없음
    await diarizeMeeting(meetingId)
    await summarizeMeeting(meetingId, 'minutes')
  } catch {
    // 어느 단계든 던지면 중단. 에러는 이미 runJob의 job-done(error) 이벤트로 알려졌다.
  }
}
