import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { subscribeRecording, getRecordingState } from '../../core/recorder/session'
import { subscribeJobs, getJobs, JOB_LABELS } from '../../core/jobs'
import type { Meeting } from '../../core/types'
import {
  listMeetings, findInterruptedMeetings, finalizeInterrupted,
  softDeleteMeeting, restoreMeeting, purgeDeleted, purgeMeeting, recoverOrphanAudio,
  softDeleteGroup, restoreGroup, purgeGroup,
} from '../../core/store/meetings'
import { ensurePersistentStorage, getStorageBreakdown } from '../../core/store/storage'
import { formatTimestamp } from '../../core/format'
import { useUndoToast, UNDO_MS } from '../UndoToast'

/**
 * 분할 회의를 그룹(groupId ?? id)으로 묶어 대표와 전체 부 목록을 만든다.
 * 대표 = 완료(done)된 부 중 partIndex가 가장 큰 부(통합 요약·AI 제목이 거기 붙는다).
 * 마지막 부가 아직 녹음 중이면 그 앞의 완료된 부를 대표로 삼는다. 완료된 부가 하나도 없는
 * 그룹은 카드를 만들지 않는다(녹음 중 그룹은 복구 배너가 담당). 미분할 회의는 자기 자신이 대표.
 * 대표 createdAt 내림차순으로 정렬해 listMeetings의 최신순을 유지한다.
 */
function groupRepresentatives(meetings: Meeting[]): { rep: Meeting; parts: Meeting[] }[] {
  const groups = new Map<string, Meeting[]>()
  for (const m of meetings) {
    const key = m.groupId ?? m.id
    const arr = groups.get(key)
    if (arr) arr.push(m)
    else groups.set(key, [m])
  }
  const result: { rep: Meeting; parts: Meeting[] }[] = []
  for (const parts of groups.values()) {
    const sorted = [...parts].sort((a, b) => (a.partIndex ?? 1) - (b.partIndex ?? 1))
    const rep = sorted.filter(m => m.status === 'done').at(-1)
    if (rep) result.push({ rep, parts: sorted })
  }
  return result.sort((a, b) => b.rep.createdAt - a.rep.createdAt)
}

export default function Home() {
  // null = 아직 로드 전(로딩 표시). 빈 배열과 구분해야 "아직 회의록이 없습니다"가 로드 전에 번쩍이지 않는다.
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [interrupted, setInterrupted] = useState<Meeting[]>([])
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null) // usage = 실측(회의+모델캐시), 설정 화면과 동일 기준
  const navigate = useNavigate()
  const showUndoToast = useUndoToast()
  const recording = useSyncExternalStore(subscribeRecording, getRecordingState)
  const jobs = useSyncExternalStore(subscribeJobs, getJobs)

  const refresh = useCallback(async () => {
    setMeetings(await listMeetings())
    setInterrupted(await findInterruptedMeetings())
  }, [])

  useEffect(() => {
    // 목록 먼저 — 아래 백그라운드 작업들은 모든 오디오 청크(GB급)를 읽어 메인 스레드를
    // 수십 초 막을 수 있으므로, 반드시 목록이 화면에 뜬 뒤에 시작한다.
    void refresh().then(() => {
      void ensurePersistentStorage()
      // 탭이 만료 전에 닫혀 남은 soft-deleted 잔여를 정리(단, 실행취소 대기 중인 최신 삭제는 보존)
      void purgeDeleted(UNDO_MS)
      // 주인 잃은 오디오(회의 행만 삭제된 사고) 복구 — 찾으면 목록을 다시 로드
      void recoverOrphanAudio().then(n => { if (n > 0) void refresh() })
      // 저장 공간 실측 — 목록과 독립적으로 준비되는 대로 하단 바에 채워진다.
      void getStorageBreakdown().then(b => setUsage(b ? { usage: b.totalUsage, quota: b.quota } : null))
    })
    // 다른 화면(회의 상세)에서 실행취소로 복구되면 목록을 다시 로드
    const onRefresh = () => { void refresh() }
    window.addEventListener('minuteflow:refresh', onRefresh)
    return () => window.removeEventListener('minuteflow:refresh', onRefresh)
  }, [refresh])

  async function recover(id: string) {
    await finalizeInterrupted(id)
    navigate(`/meeting/${id}`)
  }

  // 복구 배너의 단일(녹음 중) 회의 삭제 — 그룹과 무관하게 그 회의 하나만 처리한다.
  async function remove(id: string) {
    await softDeleteMeeting(id)
    await refresh()
    showUndoToast({
      message: '회의록을 삭제했어요.',
      onUndo: () => { void (async () => { await restoreMeeting(id); await refresh() })() },
      onExpire: () => { void purgeMeeting(id) },
    })
  }

  // 그룹 카드 삭제 — 분할 부 전체를 함께 지운다(대표만 지우면 통합 요약이 소실되고 나머지 부가 되살아난다).
  // 미분할 회의면 softDeleteGroup이 [자기 자신]만 다루므로 동작이 동일하다.
  async function removeGroup(rep: Meeting) {
    const ids = await softDeleteGroup(rep)
    await refresh()
    showUndoToast({
      message: '회의록을 삭제했어요.',
      onUndo: () => { void (async () => { await restoreGroup(ids); await refresh() })() },
      onExpire: () => { void purgeGroup(ids) },
    })
  }

  // 분할 회의는 그룹당 대표(완료된 마지막 부) 1개만 카드로 노출한다.
  const done = groupRepresentatives(meetings ?? [])

  return (
    <div>
      <div className="row" style={{ marginBottom: 22 }}>
        <div>
          <h1>회의록</h1>
          <p className="sub">모든 데이터는 이 브라우저에만 저장됩니다</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/upload" className="btn btn-outline">파일 업로드</Link>
          {recording.phase === 'idle' ? (
            <Link to="/record?autostart=1" className="btn btn-primary">🎙️ 녹음 시작</Link>
          ) : (
            <Link to="/record" className="btn rec-chip" style={{ height: 38 }}>
              <span className="dot" />녹음 중 · {formatTimestamp(recording.elapsedSec)}
            </Link>
          )}
        </div>
      </div>
      {interrupted.filter(m => m.id !== recording.meetingId).map(m => (
        <div key={m.id} className="alert-warn alert" role="alert">
          복구할 녹음이 있습니다: {m.title}{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => recover(m.id)}>복구</button>{' '}
          <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--warn-fg)' }} onClick={() => void remove(m.id)}>삭제</button>
        </div>
      ))}
      {meetings === null ? (
        <p className="sub">회의록을 불러오는 중…</p>
      ) : done.length === 0 ? (
        <p className="sub">아직 회의록이 없습니다. 녹음을 시작해보세요.</p>
      ) : (
        <div className="card-grid">
          {done.map(({ rep: m, parts }) => (
            <div
              key={m.id}
              className="card hoverable"
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/meeting/${m.id}`)}
            >
              <div className="row" style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <Link to={`/meeting/${m.id}`} onClick={e => e.stopPropagation()}>{m.title}</Link>
                  {parts.length > 1 && <span className="badge badge-gray">{parts.length}개 부</span>}
                </div>
                {(() => {
                  // 그룹 내 어느 부라도 작업 중이면 진행 배지를 보여준다.
                  const job = jobs.find(j => parts.some(p => p.id === j.meetingId))
                  return job
                    ? <span className="badge badge-accent"><span className="dot" />{JOB_LABELS[job.kind]}</span>
                    : <span className="badge badge-ok">확정</span>
                })()}
              </div>
              <div className="row">
                <span className="muted">
                  {new Date(m.createdAt).toLocaleDateString('ko-KR')} · {formatTimestamp(m.durationSec)}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); void removeGroup(m) }}>삭제</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {usage && usage.quota > 0 && (
        <div style={{ marginTop: 24 }}>
          <div className="progress" style={{ marginBottom: 6 }}>
            <i style={{ width: `${Math.min(100, (usage.usage / usage.quota) * 100)}%` }} />
          </div>
          <p className="muted">
            저장 공간: {(usage.usage / 1e6).toFixed(1)}MB / {(usage.quota / 1e9).toFixed(1)}GB 사용 중
          </p>
        </div>
      )}
    </div>
  )
}
