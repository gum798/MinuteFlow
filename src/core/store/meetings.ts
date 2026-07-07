import { db } from './db'
import type { Meeting, TranscriptSegment } from '../types'
import { assignSpeakers, type SpeakerRegion } from '../diarize/assign'

const CHUNK_SEC = 10 // MediaRecorder timeslice와 일치 (Global Constraints)

function defaultTitle(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `회의 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export async function createMeeting(language = 'ko-KR'): Promise<Meeting> {
  const now = new Date()
  const meeting: Meeting = {
    id: crypto.randomUUID(),
    title: defaultTitle(now),
    createdAt: now.getTime(),
    durationSec: 0,
    status: 'recording',
    language,
  }
  await db.meetings.add(meeting)
  return meeting
}

export async function appendAudioChunk(
  meetingId: string, seq: number, blob: Blob, mimeType: string,
): Promise<void> {
  const data = await blob.arrayBuffer()
  await db.audioChunks.add({ meetingId, seq, data, mimeType, startedAt: Date.now() })
}

export async function appendSegment(seg: Omit<TranscriptSegment, 'id'>): Promise<void> {
  await db.transcriptSegments.add(seg)
}

export async function finishMeeting(id: string, durationSec: number): Promise<void> {
  await db.meetings.update(id, { status: 'done', durationSec })
}

export async function updateMeetingTitle(id: string, title: string): Promise<void> {
  await db.meetings.update(id, { title })
}

export function listMeetings(): Promise<Meeting[]> {
  return db.meetings.orderBy('createdAt').reverse().toArray()
}

export function getMeeting(id: string): Promise<Meeting | undefined> {
  return db.meetings.get(id)
}

export function getSegments(meetingId: string): Promise<TranscriptSegment[]> {
  return db.transcriptSegments.where('[meetingId+startSec]')
    .between([meetingId, -Infinity], [meetingId, Infinity]).toArray()
}

export async function getMeetingAudio(meetingId: string): Promise<Blob | null> {
  const chunks = await db.audioChunks.where('meetingId').equals(meetingId).sortBy('seq')
  if (chunks.length === 0) return null
  return new Blob(chunks.map(c => c.data), { type: chunks[0].mimeType })
}

export function findInterruptedMeetings(): Promise<Meeting[]> {
  return db.meetings.where('status').equals('recording').toArray()
}

export async function finalizeInterrupted(id: string): Promise<Meeting | undefined> {
  const meeting = await db.meetings.get(id)
  if (!meeting) return undefined
  const chunks = await db.audioChunks.where('meetingId').equals(id).sortBy('seq')
  const last = chunks.at(-1)
  const durationSec = last
    ? Math.max(0, Math.round((last.startedAt - meeting.createdAt) / 1000) + CHUNK_SEC)
    : 0
  await finishMeeting(id, durationSec)
  return db.meetings.get(id)
}

export async function createUploadMeeting(
  title: string, durationSec: number, blob: Blob, mimeType: string, language = 'ko-KR',
): Promise<Meeting> {
  const meeting: Meeting = {
    id: crypto.randomUUID(), title, createdAt: Date.now(), durationSec, status: 'done', language,
  }
  const data = await blob.arrayBuffer()
  await db.transaction('rw', [db.meetings, db.audioChunks], async () => {
    await db.meetings.add(meeting)
    await db.audioChunks.add({ meetingId: meeting.id, seq: 0, data, mimeType, startedAt: meeting.createdAt })
  })
  return meeting
}

export async function replaceSegments(
  meetingId: string, segs: Omit<TranscriptSegment, 'id' | 'meetingId'>[],
): Promise<void> {
  await db.transaction('rw', [db.transcriptSegments], async () => {
    await db.transcriptSegments.where('meetingId').equals(meetingId).delete()
    await db.transcriptSegments.bulkAdd(segs.map(s => ({ ...s, meetingId })))
  })
}

export async function applySpeakers(meetingId: string, regions: SpeakerRegion[]): Promise<void> {
  await db.transaction('rw', [db.transcriptSegments], async () => {
    const segs = await db.transcriptSegments.where('meetingId').equals(meetingId).toArray()
    const assigned = assignSpeakers(segs, regions)
    await db.transcriptSegments.bulkPut(assigned)
  })
}

export async function updateSpeakerNames(meetingId: string, names: Record<string, string>): Promise<void> {
  await db.meetings.update(meetingId, { speakerNames: names })
}

export async function deleteMeeting(id: string): Promise<void> {
  await db.transaction('rw', [db.meetings, db.audioChunks, db.transcriptSegments, db.summaries], async () => {
    await db.audioChunks.where('meetingId').equals(id).delete()
    await db.transcriptSegments.where('meetingId').equals(id).delete()
    await db.summaries.where('meetingId').equals(id).delete()
    await db.meetings.delete(id)
  })
}
