import { useSyncExternalStore, useEffect, useState, useRef } from 'react'
import { NavLink, Link, Outlet } from 'react-router-dom'
import { UndoToastProvider } from './UndoToast'
import { subscribeRecording, getRecordingState } from '../core/recorder/session'
import { formatTimestamp } from '../core/format'
import { reloadPage } from '../core/reload'

// 새 서비스 워커가 제어권을 잡으면(배포 반영) 화면은 아직 이전 버전 — 새로고침 유도
function useUpdateReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const sw = navigator.serviceWorker
    if (!sw) return
    // 첫 설치(제어 SW 없음 → 생김)는 새 버전이 아니므로 제외
    const hadController = !!sw.controller
    const onChange = () => { if (hadController) setReady(true) }
    sw.addEventListener('controllerchange', onChange)
    return () => sw.removeEventListener('controllerchange', onChange)
  }, [])
  return ready
}

const NAV = [
  { to: '/', label: '홈', glyph: '🏠' },
  { to: '/record', label: '녹음', glyph: '🎙️' },
  { to: '/upload', label: '업로드', glyph: '📁' },
  { to: '/settings', label: '설정', glyph: '⚙️' },
]

export default function AppShell() {
  const { phase, elapsedSec } = useSyncExternalStore(subscribeRecording, getRecordingState)
  const updateReady = useUpdateReady()
  const reloadedRef = useRef(false)
  // 새 버전이 준비되면(새 SW가 제어권 확보) 자동으로 새로고침해 최신 코드를 적용한다.
  // 단, 녹음/종료 중에는 절대 새로고침하지 않는다(녹음 유실 방지) — 끝나서 idle이 되면 그때 적용된다.
  useEffect(() => {
    if (updateReady && phase === 'idle' && !reloadedRef.current) {
      reloadedRef.current = true
      reloadPage()
    }
  }, [updateReady, phase])
  const [pipelineMsg, setPipelineMsg] = useState<string | null>(null)
  useEffect(() => {
    document.body.classList.toggle('is-recording', phase !== 'idle')
    return () => document.body.classList.remove('is-recording')
  }, [phase])
  // 자동 정리(파이프라인) 완료·실패를 어느 화면에서든 토스트로 알린다.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onDone = (e: Event) => {
      const msg = (e as CustomEvent<{ message?: string }>).detail?.message
      if (!msg) return
      setPipelineMsg(msg)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setPipelineMsg(null), 6000)
    }
    window.addEventListener('minuteflow:pipeline-done', onDone)
    return () => { window.removeEventListener('minuteflow:pipeline-done', onDone); if (timer) clearTimeout(timer) }
  }, [])
  return (
    <UndoToastProvider>
      {phase !== 'idle' && (
        <Link to="/record" className="island" aria-label="녹음 중 — 녹음 화면으로">
          <span className="island-dot" />녹음 중 · {formatTimestamp(elapsedSec)}
        </Link>
      )}
      {pipelineMsg && (
        <div className="toast" role="status" onClick={() => setPipelineMsg(null)}>{pipelineMsg}</div>
      )}
      {updateReady && phase !== 'idle' && (
        <button type="button" className="update-chip" onClick={() => reloadPage()}>
          새 버전 준비됨 — 녹음 끝나면 자동 적용돼요 (탭해서 지금 적용)
        </button>
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
