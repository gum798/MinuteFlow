import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Meeting } from '../../core/types'
import {
  listMeetings, findInterruptedMeetings, finalizeInterrupted,
  softDeleteMeeting, restoreMeeting, purgeDeleted, purgeMeeting,
} from '../../core/store/meetings'
import { ensurePersistentStorage, getStorageUsage } from '../../core/store/storage'
import { formatTimestamp } from '../../core/format'
import { useUndoToast, UNDO_MS } from '../UndoToast'

export default function Home() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [interrupted, setInterrupted] = useState<Meeting[]>([])
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const navigate = useNavigate()
  const showUndoToast = useUndoToast()

  const refresh = useCallback(async () => {
    setMeetings(await listMeetings())
    setInterrupted(await findInterruptedMeetings())
    setUsage(await getStorageUsage())
  }, [])

  useEffect(() => {
    void ensurePersistentStorage()
    // 탭이 만료 전에 닫혀 남은 soft-deleted 잔여를 정리(단, 실행취소 대기 중인 최신 삭제는 보존)
    void purgeDeleted(UNDO_MS)
    void refresh()
    // 다른 화면(회의 상세)에서 실행취소로 복구되면 목록을 다시 로드
    const onRefresh = () => { void refresh() }
    window.addEventListener('minuteflow:refresh', onRefresh)
    return () => window.removeEventListener('minuteflow:refresh', onRefresh)
  }, [refresh])

  async function recover(id: string) {
    await finalizeInterrupted(id)
    navigate(`/meeting/${id}`)
  }

  async function remove(id: string) {
    await softDeleteMeeting(id)
    await refresh()
    showUndoToast({
      message: '회의록을 삭제했어요.',
      onUndo: () => { void (async () => { await restoreMeeting(id); await refresh() })() },
      onExpire: () => { void purgeMeeting(id) },
    })
  }

  const done = meetings.filter(m => m.status === 'done')

  return (
    <div>
      <div className="row" style={{ marginBottom: 22 }}>
        <div>
          <h1>회의록</h1>
          <p className="sub">모든 데이터는 이 브라우저에만 저장됩니다</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/upload" className="btn btn-outline">파일 업로드</Link>
          <Link to="/record?autostart=1" className="btn btn-primary">🎙️ 녹음 시작</Link>
        </div>
      </div>
      {interrupted.map(m => (
        <div key={m.id} className="alert-warn alert" role="alert">
          복구할 녹음이 있습니다: {m.title}{' '}
          <button className="btn btn-ghost btn-sm" onClick={() => recover(m.id)}>복구</button>
        </div>
      ))}
      {done.length === 0 ? (
        <p className="sub">아직 회의록이 없습니다. 녹음을 시작해보세요.</p>
      ) : (
        <div className="card-grid">
          {done.map(m => (
            <div key={m.id} className="card hoverable">
              <div className="row" style={{ marginBottom: 8 }}>
                <Link to={`/meeting/${m.id}`}>{m.title}</Link>
                <span className="badge badge-ok">확정</span>
              </div>
              <div className="row">
                <span className="muted">
                  {new Date(m.createdAt).toLocaleDateString('ko-KR')} · {formatTimestamp(m.durationSec)}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => remove(m.id)}>삭제</button>
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
