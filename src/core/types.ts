export type SttSource = 'webspeech' | 'whisper' | 'groq'

export interface Meeting {
  id: string
  title: string
  createdAt: number
  durationSec: number
  status: 'recording' | 'done'
  language: string
  speakerNames?: Record<string, string>
  /** soft-delete 표시. 값이 있으면 목록에서 숨기고, 만료/정리 시 하드 삭제한다. (optional·비인덱스) */
  deletedAt?: number
  /** 분할 녹음 그룹 id(= 첫 부의 회의 id). 분할이 실제 발생한 회의에만 부여된다. (optional·비인덱스) */
  groupId?: string
  /** 분할 그룹 내 부(part) 번호. 1부터 시작. (optional·비인덱스) */
  partIndex?: number
  /** 이 회의 오디오 청크들의 총 바이트 — 저장 시 누적 기록해 저장 공간 표시를 실측 없이 합산한다.
   *  없으면(옛 데이터) getStorageBreakdown이 한 번 실측해 채운다. (optional·비인덱스) */
  audioBytes?: number
}

export interface AudioChunk {
  id?: number
  meetingId: string
  seq: number
  data: ArrayBuffer
  mimeType: string
  startedAt: number
}

export interface TranscriptSegment {
  id?: number
  meetingId: string
  startSec: number
  endSec: number
  text: string
  source: SttSource
  isFinal: boolean
  speaker?: string
}

export interface Summary {
  id?: number
  meetingId: string
  template: 'minutes' | 'brief' | 'timeline'
  markdown: string
  provider: string
  createdAt: number
}
