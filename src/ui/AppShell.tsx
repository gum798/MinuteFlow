import { useSyncExternalStore, useEffect } from 'react'
import { NavLink, Link, Outlet } from 'react-router-dom'
import { UndoToastProvider } from './UndoToast'
import { subscribeRecording, getRecordingState } from '../core/recorder/session'
import { formatTimestamp } from '../core/format'

const NAV = [
  { to: '/', label: '홈', glyph: '🏠' },
  { to: '/record', label: '녹음', glyph: '🎙️' },
  { to: '/upload', label: '업로드', glyph: '📁' },
  { to: '/settings', label: '설정', glyph: '⚙️' },
]

export default function AppShell() {
  const { phase, elapsedSec } = useSyncExternalStore(subscribeRecording, getRecordingState)
  useEffect(() => {
    document.body.classList.toggle('is-recording', phase !== 'idle')
    return () => document.body.classList.remove('is-recording')
  }, [phase])
  return (
    <UndoToastProvider>
      {phase !== 'idle' && (
        <Link to="/record" className="island" aria-label="녹음 중 — 녹음 화면으로">
          <span className="island-dot" />녹음 중 · {formatTimestamp(elapsedSec)}
        </Link>
      )}
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
        </aside>
        <main className="content">
          <Outlet />
        </main>
        <nav className="tabbar" aria-label="주 메뉴">
          {NAV.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              <span className="glyph">{n.glyph}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </UndoToastProvider>
  )
}
