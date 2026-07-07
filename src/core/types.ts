export type SttSource = 'webspeech' | 'whisper' | 'groq'

export interface Meeting {
  id: string
  title: string
  createdAt: number
  durationSec: number
  status: 'recording' | 'done'
  language: string
  speakerNames?: Record<string, string>
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
