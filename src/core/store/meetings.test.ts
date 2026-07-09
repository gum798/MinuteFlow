import { db } from './db'
import {
  createMeeting, appendAudioChunk, appendSegment, finishMeeting, markGroupFirstPart,
  updateMeetingTitle, listMeetings, getMeeting, getSegments,
  getMeetingAudio, findInterruptedMeetings, finalizeInterrupted, deleteMeeting, recoverOrphanAudio,
  createUploadMeeting, replaceAudio, replaceSegments, applySpeakers, updateSpeakerNames,
  softDeleteMeeting, restoreMeeting, purgeDeleted, purgeMeeting,
  saveSummary, getSummaries,
} from './meetings'

beforeEach(async () => {
  await Promise.all([
    db.meetings.clear(), db.audioChunks.clear(),
    db.transcriptSegments.clear(), db.summaries.clear(),
  ])
})

test('createMeeting은 recording 상태의 회의를 만든다', async () => {
  const m = await createMeeting()
  expect(m.status).toBe('recording')
  expect(m.language).toBe('ko-KR')
  expect(m.title).toMatch(/^회의 /)
  expect(await getMeeting(m.id)).toMatchObject({ id: m.id })
})

test('createMeeting은 분할 opts(groupId·partIndex·titleSuffix)를 반영한다', async () => {
  const m = await createMeeting('ko-KR', { groupId: 'g1', partIndex: 2, titleSuffix: ' (2부)' })
  expect(m.groupId).toBe('g1')
  expect(m.partIndex).toBe(2)
  expect(m.title).toMatch(/ \(2부\)$/)
  const got = await getMeeting(m.id)
  expect(got).toMatchObject({ groupId: 'g1', partIndex: 2 })
})

test('markGroupFirstPart는 첫 부에 그룹 메타를 부여하고 기본 제목일 때만 접미어를 붙인다', async () => {
  const a = await createMeeting()
  const baseTitle = a.title
  await markGroupFirstPart(a.id, a.id, baseTitle, ' (1부)')
  const got = await getMeeting(a.id)
  expect(got).toMatchObject({ groupId: a.id, partIndex: 1 })
  expect(got?.title).toBe(baseTitle + ' (1부)')

  // 사용자가 이미 제목을 바꿨다면(=기본 제목 아님) 접미어를 붙이지 않는다.
  const b = await createMeeting()
  await updateMeetingTitle(b.id, '내가 정한 제목')
  await markGroupFirstPart(b.id, b.id, b.title, ' (1부)')
  const gotB = await getMeeting(b.id)
  expect(gotB?.title).toBe('내가 정한 제목')
  expect(gotB).toMatchObject({ groupId: b.id, partIndex: 1 })
})

test('listMeetings는 createdAt 내림차순', async () => {
  const a = await createMeeting()
  await db.meetings.update(a.id, { createdAt: 1000 })
  const b = await createMeeting()
  await db.meetings.update(b.id, { createdAt: 2000 })
  const list = await listMeetings()
  expect(list.map(m => m.id)).toEqual([b.id, a.id])
})

test('오디오 청크는 seq순으로 연결되어 하나의 Blob이 된다', async () => {
  const m = await createMeeting()
  await appendAudioChunk(m.id, 1, new Blob(['BB']), 'audio/webm')
  await appendAudioChunk(m.id, 0, new Blob(['AA']), 'audio/webm')
  const blob = await getMeetingAudio(m.id)
  expect(blob).not.toBeNull()
  expect(await blob!.text()).toBe('AABB')
  expect(blob!.type).toBe('audio/webm')
})

test('청크가 없으면 getMeetingAudio는 null', async () => {
  const m = await createMeeting()
  expect(await getMeetingAudio(m.id)).toBeNull()
})

test('세그먼트는 startSec 오름차순으로 조회된다', async () => {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 10, endSec: 12, text: '둘', source: 'webspeech', isFinal: true })
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 3, text: '하나', source: 'webspeech', isFinal: true })
  const segs = await getSegments(m.id)
  expect(segs.map(s => s.text)).toEqual(['하나', '둘'])
})

test('finishMeeting과 updateMeetingTitle', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 123)
  await updateMeetingTitle(m.id, '주간회의')
  const got = await getMeeting(m.id)
  expect(got).toMatchObject({ status: 'done', durationSec: 123, title: '주간회의' })
})

test('중단된 회의를 찾아 마지막 청크 기준으로 복구한다', async () => {
  const m = await createMeeting()
  await db.meetings.update(m.id, { createdAt: 1000 })
  await appendAudioChunk(m.id, 0, new Blob(['x']), 'audio/webm')
  await db.audioChunks.where('meetingId').equals(m.id).modify({ startedAt: 31000 })
  expect((await findInterruptedMeetings()).map(x => x.id)).toEqual([m.id])
  const fixed = await finalizeInterrupted(m.id)
  // (31000 - 1000) / 1000 + 10초(청크 길이) = 40
  expect(fixed).toMatchObject({ status: 'done', durationSec: 40 })
  expect(await findInterruptedMeetings()).toEqual([])
})

test('청크가 없는 중단 회의는 duration 0으로 복구', async () => {
  const m = await createMeeting()
  const fixed = await finalizeInterrupted(m.id)
  expect(fixed).toMatchObject({ status: 'done', durationSec: 0 })
})

test('deleteMeeting은 하위 데이터까지 지운다', async () => {
  const m = await createMeeting()
  await appendAudioChunk(m.id, 0, new Blob(['x']), 'audio/webm')
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 1, text: 'a', source: 'webspeech', isFinal: true })
  await deleteMeeting(m.id)
  expect(await getMeeting(m.id)).toBeUndefined()
  expect(await db.audioChunks.where('meetingId').equals(m.id).count()).toBe(0)
  expect(await db.transcriptSegments.where('meetingId').equals(m.id).count()).toBe(0)
})

test('createUploadMeeting은 done 상태로 원본 오디오와 함께 생성된다', async () => {
  const m = await createUploadMeeting('업로드 회의', 120, new Blob(['aud']), 'audio/mp4')
  expect(m).toMatchObject({ title: '업로드 회의', durationSec: 120, status: 'done' })
  const audio = await getMeetingAudio(m.id)
  expect(await audio!.text()).toBe('aud')
  expect(audio!.type).toBe('audio/mp4')
})

test('replaceAudio는 기존 청크를 전부 지우고 단일 청크로 교체한다', async () => {
  const m = await createMeeting()
  await appendAudioChunk(m.id, 0, new Blob(['AA']), 'audio/webm')
  await appendAudioChunk(m.id, 1, new Blob(['BB']), 'audio/webm')
  await appendAudioChunk(m.id, 2, new Blob(['CC']), 'audio/webm')

  await replaceAudio(m.id, new Blob(['REPAIRED'], { type: 'audio/webm;codecs=opus' }))

  const chunks = await db.audioChunks.where('meetingId').equals(m.id).sortBy('seq')
  expect(chunks).toHaveLength(1)
  expect(chunks[0].seq).toBe(0)
  const audio = await getMeetingAudio(m.id)
  expect(await audio!.text()).toBe('REPAIRED')
  expect(audio!.type).toBe('audio/webm;codecs=opus')
})

test('replaceSegments는 기존 세그먼트를 전부 교체한다', async () => {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 1, text: '옛것', source: 'webspeech', isFinal: true })
  await replaceSegments(m.id, [
    { startSec: 0, endSec: 2, text: '새것1', source: 'whisper', isFinal: true },
    { startSec: 2, endSec: 4, text: '새것2', source: 'whisper', isFinal: true },
  ])
  const segs = await getSegments(m.id)
  expect(segs.map(s => s.text)).toEqual(['새것1', '새것2'])
  expect(segs.every(s => s.source === 'whisper')).toBe(true)
})

test('applySpeakers는 세그먼트에 화자를 기록한다', async () => {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 4, text: 'a', source: 'whisper', isFinal: true })
  await appendSegment({ meetingId: m.id, startSec: 5, endSec: 7, text: 'b', source: 'whisper', isFinal: true })
  await applySpeakers(m.id, [
    { start: 0, end: 4.5, speaker: 'SPK1' }, { start: 4.5, end: 8, speaker: 'SPK2' },
  ])
  const segs = await getSegments(m.id)
  expect(segs.map(s => s.speaker)).toEqual(['SPK1', 'SPK2'])
})

test('updateSpeakerNames는 회의에 이름 맵을 저장한다', async () => {
  const m = await createMeeting()
  await updateSpeakerNames(m.id, { SPK1: '김팀장' })
  expect((await getMeeting(m.id))?.speakerNames).toEqual({ SPK1: '김팀장' })
})

test('softDeleteMeeting하면 listMeetings에서 빠지지만 DB에는 남는다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  await softDeleteMeeting(m.id)
  expect((await listMeetings()).map(x => x.id)).not.toContain(m.id)
  expect(await getMeeting(m.id)).toBeDefined() // 아직 하드 삭제 전(soft)
})

test('restoreMeeting하면 다시 listMeetings에 나타난다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  await softDeleteMeeting(m.id)
  await restoreMeeting(m.id)
  expect((await listMeetings()).map(x => x.id)).toContain(m.id)
})

test('purgeDeleted는 soft-deleted 회의만 하위 데이터까지 완전 삭제한다', async () => {
  const keep = await createMeeting()
  await finishMeeting(keep.id, 60)
  await appendAudioChunk(keep.id, 0, new Blob(['k']), 'audio/webm')

  const gone = await createMeeting()
  await finishMeeting(gone.id, 60)
  await appendAudioChunk(gone.id, 0, new Blob(['g']), 'audio/webm')
  await appendSegment({ meetingId: gone.id, startSec: 0, endSec: 1, text: 'g', source: 'webspeech', isFinal: true })
  await softDeleteMeeting(gone.id)

  await purgeDeleted()

  // soft-deleted는 하위 데이터까지 완전 삭제
  expect(await getMeeting(gone.id)).toBeUndefined()
  expect(await db.audioChunks.where('meetingId').equals(gone.id).count()).toBe(0)
  expect(await db.transcriptSegments.where('meetingId').equals(gone.id).count()).toBe(0)
  // 삭제되지 않은 회의는 그대로 보존
  expect(await getMeeting(keep.id)).toBeDefined()
  expect(await db.audioChunks.where('meetingId').equals(keep.id).count()).toBe(1)
})

test('연속 삭제: purgeMeeting(A)는 A만 지우고 B는 남겨 실행취소를 보존한다', async () => {
  const a = await createMeeting()
  await finishMeeting(a.id, 60)
  await appendAudioChunk(a.id, 0, new Blob(['a']), 'audio/webm')
  const b = await createMeeting()
  await finishMeeting(b.id, 60)
  await appendAudioChunk(b.id, 0, new Blob(['b']), 'audio/webm')

  // A 삭제 후 5초 내 B 삭제 → 이 시점에 A 토스트가 만료 확정되며 purgeMeeting(A) 실행
  await softDeleteMeeting(a.id)
  await softDeleteMeeting(b.id)
  await purgeMeeting(a.id)

  // A만 하드 삭제, B는 soft-deleted로 잔존
  expect(await getMeeting(a.id)).toBeUndefined()
  expect(await db.audioChunks.where('meetingId').equals(a.id).count()).toBe(0)
  expect(await getMeeting(b.id)).toBeDefined()
  expect(await db.audioChunks.where('meetingId').equals(b.id).count()).toBe(1)

  // B의 실행취소가 유효 — 복구하면 목록에 다시 나타난다
  await restoreMeeting(b.id)
  expect((await listMeetings()).map(x => x.id)).toContain(b.id)
})

test('restore된 회의에 purgeMeeting을 호출하면 no-op (경합 방어)', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  await softDeleteMeeting(m.id)
  await restoreMeeting(m.id)
  // restore 후 남아있던 만료 타이머가 뒤늦게 발화해도 삭제되면 안 된다
  await purgeMeeting(m.id)
  expect(await getMeeting(m.id)).toBeDefined()
  expect((await listMeetings()).map(x => x.id)).toContain(m.id)
})

test('saveSummary는 템플릿당 최신 1개만 유지한다', async () => {
  const m = await createMeeting()
  await saveSummary(m.id, 'minutes', '# 첫번째', 'gemini-3.5-flash')
  await saveSummary(m.id, 'minutes', '# 두번째', 'gemini-3.5-flash')
  await saveSummary(m.id, 'brief', '짧은', 'gemini-3.5-flash')
  const sums = await getSummaries(m.id)
  expect(sums).toHaveLength(2)
  expect(sums.find(s => s.template === 'minutes')?.markdown).toBe('# 두번째')
})

test('getSummaries는 다른 회의를 섞지 않는다', async () => {
  const a = await createMeeting(); const b = await createMeeting()
  await saveSummary(a.id, 'brief', 'A', 'x')
  await saveSummary(b.id, 'brief', 'B', 'x')
  expect((await getSummaries(a.id)).map(s => s.markdown)).toEqual(['A'])
})

test('recoverOrphanAudio는 회의 행 없는 청크를 회의로 되살린다', async () => {
  const m = await createMeeting()
  const enc = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer
  await db.audioChunks.add({ meetingId: m.id, seq: 0, data: enc('a'), mimeType: 'audio/webm', startedAt: 1000 })
  await db.audioChunks.add({ meetingId: m.id, seq: 1, data: enc('b'), mimeType: 'audio/webm', startedAt: 11000 })
  await db.meetings.delete(m.id) // 사고: 회의 행만 삭제 (청크 잔존)
  const n = await recoverOrphanAudio()
  expect(n).toBe(1)
  const restored = await getMeeting(m.id)
  expect(restored).toMatchObject({ status: 'done' })
  expect(restored?.title).toMatch(/^복구된 녹음 /)
  expect(restored?.durationSec).toBe(20) // (11000-1000)/1000 + 10
  expect(await (await getMeetingAudio(m.id))!.text()).toBe('ab')
})

test('recoverOrphanAudio는 고아가 없으면 0이고 기존 회의를 건드리지 않는다', async () => {
  const m = await createMeeting()
  await appendAudioChunk(m.id, 0, new Blob(['x']), 'audio/webm')
  expect(await recoverOrphanAudio()).toBe(0)
  expect((await getMeeting(m.id))?.status).toBe('recording')
})
