import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Meeting } from '../../core/types'
import {
  listMeetings, findInterruptedMeetings, finalizeInterrupted, deleteMeeting,
} from '../../core/store/meetings'
import { ensurePersistentStorage, getStorageUsage } from '../../core/store/storage'
import { formatTimestamp } from '../../core/format'

export default function Home() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [interrupted, setInterrupted] = useState<Meeting[]>([])
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const navigate = useNavigate()

  async function refresh() {
    setMeetings(await listMeetings())
    setInterrupted(await findInterruptedMeetings())
    setUsage(await getStorageUsage())
  }

  useEffect(() => {
    void ensurePersistentStorage()
    void refresh()
  }, [])

  async function recover(id: string) {
    await finalizeInterrupted(id)
    navigate(`/meeting/${id}`)
  }

  async function remove(id: string) {
    if (!window.confirm('이 회의록을 삭제할까요? 되돌릴 수 없습니다.')) return
    await deleteMeeting(id)
    await refresh()
  }

  const done = meetings.filter(m => m.status === 'done')

  return (
    <main>
      <h1>MinuteFlow</h1>
      <p>
        <Link to="/record">🎙️ 녹음 시작</Link>
      </p>
      {interrupted.map(m => (
        <div key={m.id} role="alert">
          복구할 녹음이 있습니다: {m.title}{' '}
          <button onClick={() => recover(m.id)}>복구</button>
        </div>
      ))}
      {done.length === 0 ? (
        <p>아직 회의록이 없습니다. 녹음을 시작해보세요.</p>
      ) : (
        <ul>
          {done.map(m => (
            <li key={m.id}>
              <Link to={`/meeting/${m.id}`}>{m.title}</Link>{' '}
              ({formatTimestamp(m.durationSec)}){' '}
              <button onClick={() => remove(m.id)}>삭제</button>
            </li>
          ))}
        </ul>
      )}
      {usage && usage.quota > 0 && (
        <footer>
          저장 공간: {(usage.usage / 1e6).toFixed(1)}MB / {(usage.quota / 1e9).toFixed(1)}GB 사용 중
        </footer>
      )}
    </main>
  )
}
