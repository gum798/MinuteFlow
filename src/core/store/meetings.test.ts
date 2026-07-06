import { db } from './db'
import {
  createMeeting, appendAudioChunk, appendSegment, finishMeeting,
  updateMeetingTitle, listMeetings, getMeeting, getSegments,
  getMeetingAudio, findInterruptedMeetings, finalizeInterrupted, deleteMeeting,
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
