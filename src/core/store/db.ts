import Dexie, { type Table } from 'dexie'
import type { Meeting, AudioChunk, TranscriptSegment, Summary } from '../types'

export class MinuteFlowDB extends Dexie {
  meetings!: Table<Meeting, string>
  audioChunks!: Table<AudioChunk, number>
  transcriptSegments!: Table<TranscriptSegment, number>
  summaries!: Table<Summary, number>

  constructor() {
    super('minuteflow')
    this.version(1).stores({
      meetings: 'id, createdAt, status',
      audioChunks: '++id, meetingId, [meetingId+seq]',
      transcriptSegments: '++id, meetingId, [meetingId+startSec]',
      summaries: '++id, meetingId',
    })
  }
}

export const db = new MinuteFlowDB()
