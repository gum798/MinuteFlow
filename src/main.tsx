import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { loadSettings } from './core/settings'
import { enqueue, runPartPipeline } from './core/pipeline'
import './ui/theme.css'

// 녹음 중 부(part)가 완성될 때마다 백그라운드 후처리(재전사→화자 구분)를 순차 큐에 넣는다.
// 세션 종료 시의 최종 요약(Record.onStop)과 같은 큐를 공유하므로 자연히 직렬화된다.
window.addEventListener('minuteflow:part-complete', e => {
  if (loadSettings().autoPipeline) {
    void enqueue(async () => { await runPartPipeline((e as CustomEvent).detail.meetingId) })
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
