import type { TranscriptSegment } from '../types'

/** 연속된 동일 화자 세그먼트를 하나로 묶은 표시 단위. 데이터는 바꾸지 않고 렌더에만 쓴다. */
export interface SpeakerRun {
  /** 묶음의 화자 라벨(그룹 첫 세그먼트 기준). speaker 없는 묶음은 undefined. */
  speaker?: string
  /** 묶음 시작 시각(첫 세그먼트 startSec). */
  startSec: number
  /** 이 묶음에 속한 세그먼트들(원본, 순서 보존). */
  items: TranscriptSegment[]
}

/**
 * 세그먼트 목록을 연속된 동일 speaker 묶음으로 그룹핑한다(undefined도 하나의 화자로 동일 취급).
 * 회의록에서 같은 화자의 연속 발화를 배지 하나 아래로 이어 보여주기 위한 순수 헬퍼.
 */
export function groupConsecutiveBySpeaker(segments: TranscriptSegment[]): SpeakerRun[] {
  const runs: SpeakerRun[] = []
  for (const seg of segments) {
    const last = runs[runs.length - 1]
    if (last && last.speaker === seg.speaker) {
      last.items.push(seg)
    } else {
      runs.push({ speaker: seg.speaker, startSec: seg.startSec, items: [seg] })
    }
  }
  return runs
}
