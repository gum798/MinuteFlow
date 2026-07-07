import { useSyncExternalStore } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { UndoToastProvider } from './UndoToast'
import { subscribeRecording, getRecordingState } from '../core/recorder/session'
import { formatTimestamp } from '../core/format'

const NAV = [
  { to: '/', label: '홈' },
  { to: '/record', label: '녹음' },
  { to: '/upload', label: '업로드' },
  { to: '/settings', label: '설정' },
]

export default function AppShell() {
  const { phase, elapsedSec } = useSyncExternalStore(subscribeRecording, getRecordingState)
  return (
    <UndoToastProvider>
      <div className="shell">
        <aside className="sidebar">
          <div className="logo"><i>M</i>MinuteFlow</div>
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              {n.label}
            </NavLink>
          ))}
          {phase !== 'idle' && (
            <NavLink to="/record" className="rec-chip">
              <span className="dot" />녹음 중 · {formatTimestamp(elapsedSec)}
            </NavLink>
          )}
        </aside>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </UndoToastProvider>
  )
}
