import { NavLink, Outlet } from 'react-router-dom'

const NAV = [
  { to: '/', label: '홈' },
  { to: '/record', label: '녹음' },
  { to: '/upload', label: '업로드' },
  { to: '/settings', label: '설정' },
]

export default function AppShell() {
  return (
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
    </div>
  )
}
