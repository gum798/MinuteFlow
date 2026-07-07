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
