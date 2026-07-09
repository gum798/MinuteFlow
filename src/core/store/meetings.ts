import { db } from './db'
import type { Meeting, TranscriptSegment, Summary } from '../types'
import { assignSpeakers, type SpeakerRegion } from '../diarize/assign'

const CHUNK_SEC = 10 // MediaRecorder timeslice와 일치 (Global Constraints)

function defaultTitle(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `회의 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export interface CreateMeetingOpts {
  /** 분할 그룹 id(= 첫 부의 회의 id). */
  groupId?: string
  /** 분할 그룹 내 부 번호(1부터). */
  partIndex?: number
  /** 기본 제목 뒤에 붙일 접미어 (예: ' (2부)'). */
  titleSuffix?: string
}

export async function createMeeting(language = 'ko-KR', opts: CreateMeetingOpts = {}): Promise<Meeting> {
  const now = new Date()
  const meeting: Meeting = {
    id: crypto.randomUUID(),
    title: defaultTitle(now) + (opts.titleSuffix ?? ''),
    createdAt: now.getTime(),
    durationSec: 0,
    status: 'recording',
    language,
    ...(opts.groupId !== undefined ? { groupId: opts.groupId } : {}),
    ...(opts.partIndex !== undefined ? { partIndex: opts.partIndex } : {}),
  }
  await db.meetings.add(meeting)
  return meeting
}

/**
 * 첫 분할이 발생할 때 첫 부(part)에 그룹 메타(groupId·partIndex=1)를 부여한다.
 * 제목은 아직 기본 제목(baseTitle)일 때만 titleSuffix(예: ' (1부)')를 덧붙인다
 * — 사용자가 녹음 중 제목을 바꿨다면 건드리지 않는다.
 */
export async function markGroupFirstPart(
  meetingId: string, groupId: string, baseTitle: string, titleSuffix: string,
): Promise<void> {
  const m = await db.meetings.get(meetingId)
  if (!m) return
  const patch: Partial<Meeting> = { groupId, partIndex: 1 }
  if (m.title === baseTitle) patch.title = baseTitle + titleSuffix
  await db.meetings.update(meetingId, patch)
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
  return db.meetings.orderBy('createdAt').reverse().filter(m => !m.deletedAt).toArray()
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
  return db.meetings.where('status').equals('recording').filter(m => !m.deletedAt).toArray()
}


// 주인 없는 오디오 청크 복구 — 회의 행이 삭제됐지만 청크가 남은 경우(예: 녹음 중 삭제 사고) 회의를 되살린다.
// 반환: 복구된 회의 수. 멱등(고아가 없으면 0).
export async function recoverOrphanAudio(): Promise<number> {
  const meetingIds = new Set(await db.meetings.toCollection().primaryKeys())
  const orphanIds = new Set<string>()
  await db.audioChunks.each(c => { if (!meetingIds.has(c.meetingId)) orphanIds.add(c.meetingId) })
  let recovered = 0
  for (const id of orphanIds) {
    const chunks = await db.audioChunks.where('meetingId').equals(id).sortBy('seq')
    if (chunks.length === 0) continue
    const first = chunks[0]
    const last = chunks[chunks.length - 1]
    const durationSec = Math.max(CHUNK_SEC, Math.round((last.startedAt - first.startedAt) / 1000) + CHUNK_SEC)
    const d = new Date(first.startedAt)
    const pad = (n: number) => String(n).padStart(2, '0')
    await db.meetings.add({
      id,
      title: `복구된 녹음 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      createdAt: first.startedAt,
      durationSec,
      status: 'done',
      language: 'ko-KR',
    })
    recovered++
  }
  return recovered
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

/**
 * 회의의 오디오를 단일 청크로 교체한다(트랜잭션).
 * 기존 audioChunks를 전부 지우고 seq 0 하나로 대체 — WebM 헤더 수선본 저장 등에 사용.
 */
export async function replaceAudio(meetingId: string, blob: Blob): Promise<void> {
  const data = await blob.arrayBuffer()
  await db.transaction('rw', [db.audioChunks], async () => {
    await db.audioChunks.where('meetingId').equals(meetingId).delete()
    await db.audioChunks.add({ meetingId, seq: 0, data, mimeType: blob.type, startedAt: Date.now() })
  })
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

export async function saveSummary(
  meetingId: string, template: Summary['template'], markdown: string, provider: string,
): Promise<void> {
  await db.transaction('rw', [db.summaries], async () => {
    const olds = await db.summaries.where('meetingId').equals(meetingId).toArray()
    const dup = olds.filter(s => s.template === template).map(s => s.id!)
    if (dup.length) await db.summaries.bulkDelete(dup)
    await db.summaries.add({ meetingId, template, markdown, provider, createdAt: Date.now() })
  })
}

export async function getSummaries(meetingId: string): Promise<Summary[]> {
  const rows = await db.summaries.where('meetingId').equals(meetingId).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

/** 회의를 목록에서 즉시 숨긴다(하위 데이터·오디오는 그대로 두어 실행취소를 값싸게 만든다). */
export async function softDeleteMeeting(id: string): Promise<void> {
  await db.meetings.update(id, { deletedAt: Date.now() })
}

/** soft-delete를 취소하고 다시 목록에 노출한다. */
export async function restoreMeeting(id: string): Promise<void> {
  await db.meetings.update(id, { deletedAt: undefined })
}

/**
 * 특정 회의 하나만 하드 삭제한다. soft-deleted 상태일 때만 지운다.
 * (없거나 이미 restore된 경우 no-op — 실행취소 후 남아있는 만료 타이머의 경합 방어)
 */
export async function purgeMeeting(id: string): Promise<void> {
  const m = await db.meetings.get(id)
  if (!m || m.deletedAt === undefined) return
  await deleteMeeting(id)
}

/**
 * soft-deleted 회의를 기존 캐스케이드로 완전 삭제한다.
 * `olderThanMs`를 주면 그 시간보다 오래된 것만 지운다(실행취소 대기 중인 최신 삭제는 보존).
 */
export async function purgeDeleted(olderThanMs = 0): Promise<void> {
  const cutoff = Date.now() - olderThanMs
  const rows = await db.meetings.filter(m => m.deletedAt !== undefined && m.deletedAt <= cutoff).toArray()
  for (const m of rows) await deleteMeeting(m.id)
}
