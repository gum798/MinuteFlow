import { useEffect, useState } from 'react'
import { loadSettings, saveSettings, type WhisperModelId } from '../../core/settings'
import { detectWebGPU } from '../../core/stt/whisperLocal'
import { GROQ_ENABLED } from '../../core/features'
import { getStorageBreakdown, clearModelCaches, type StorageBreakdown } from '../../core/store/storage'

const MODELS: { id: WhisperModelId; label: string; desc: string }[] = [
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'whisper-large-v3-turbo', desc: '고품질 · 다운로드 약 560MB · WebGPU 권장' },
  { id: 'onnx-community/whisper-base', label: 'whisper-base', desc: '경량 · 약 200MB · 저사양/WASM용' },
]

// 1GB 이상은 GB 1자리, 그 미만은 MB 정수.
function fmtBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)}GB` : `${(bytes / 1e6).toFixed(0)}MB`
}

export default function Settings() {
  const [form, setForm] = useState(loadSettings)
  const [webgpu, setWebgpu] = useState<boolean | null>(null)
  const [toast, setToast] = useState(false)
  const [storage, setStorage] = useState<StorageBreakdown | null>(null)
  const [cacheToast, setCacheToast] = useState(false)

  useEffect(() => { void detectWebGPU().then(setWebgpu) }, [])
  useEffect(() => { void getStorageBreakdown().then(setStorage) }, [])

  function save() {
    saveSettings(form)
    setToast(true)
    setTimeout(() => setToast(false), 2000)
  }

  async function clearCaches() {
    if (!window.confirm('AI 모델 캐시를 비울까요? 회의록은 지워지지 않으며, 다음 전사 때 모델을 다시 내려받습니다.')) return
    await clearModelCaches()
    setStorage(await getStorageBreakdown())
    setCacheToast(true)
    setTimeout(() => setCacheToast(false), 2000)
  }

  return (
    <div>
      <h1>설정</h1>
      <p className="sub">모든 설정과 키는 이 브라우저에만 저장되며 어떤 서버로도 전송되지 않습니다.</p>

      <section className="card" style={{ marginTop: 22 }}>
        <h2>AI 요약 키 (Gemini)</h2>
        <p className="hint">
          무료로 발급받아 넣으면 회의록 AI 요약을 쓸 수 있어요.{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio에서 발급</a>
        </p>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="gemini-key">Gemini API 키</label>
          <input id="gemini-key" type="password" className="input" placeholder="AIza..."
            value={form.geminiApiKey}
            onChange={e => setForm({ ...form, geminiApiKey: e.target.value })} />
        </div>
      </section>

      {GROQ_ENABLED && (
        <section className="card" style={{ marginTop: 22 }}>
          <h2>Groq API 키 (파일 전사 고속 처리)</h2>
          <p className="hint">
            무료로 발급받아 넣으면 파일 전사가 훨씬 빨라져요.{' '}
            <a href="https://console.groq.com" target="_blank" rel="noreferrer">console.groq.com에서 발급</a>
            {' '}(무료 한도: 하루 오디오 8시간)
          </p>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="groq-key">Groq API 키</label>
            <input id="groq-key" type="password" className="input" placeholder="gsk_..."
              value={form.groqApiKey}
              onChange={e => setForm({ ...form, groqApiKey: e.target.value })} />
          </div>
        </section>
      )}

      <section className="card" style={{ marginTop: 22 }}>
        <h2>저장 공간</h2>
        {storage && (
          <>
            {storage.quota > 0 && (
              <div className="progress" style={{ marginBottom: 6 }}>
                <i style={{ width: `${Math.min(100, (storage.totalUsage / storage.quota) * 100)}%` }} />
              </div>
            )}
            <p className="muted">
              회의 데이터 {fmtBytes(storage.meetingBytes)} · AI 모델 캐시 {fmtBytes(storage.cacheBytes)}
            </p>
          </>
        )}
        <p style={{ marginTop: 10 }}>
          <button className="btn btn-outline" onClick={() => void clearCaches()}>AI 모델 캐시 비우기</button>
        </p>
        <p className="hint">회의 데이터는 홈에서 회의록을 삭제하면 줄어들어요.</p>
      </section>

      <section className="card" style={{ marginTop: 22 }}>
        <h2>자동 처리</h2>
        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" id="auto-pipeline" checked={form.autoPipeline}
            onChange={e => setForm({ ...form, autoPipeline: e.target.checked })} />
          <label htmlFor="auto-pipeline">회의 종료 후 자동으로 재전사·화자 구분·AI 요약 실행</label>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>AI 요약은 Gemini 키가 등록된 경우에만 실행돼요.</p>
      </section>

      <details className="advanced" style={{ marginTop: 16 }}>
        <summary>고급 설정 (전사 모델·언어)</summary>

        <section className="card">
          <h2>브라우저 Whisper 모델</h2>
          <p className="hint" style={{ marginBottom: 10 }}>
            {webgpu === null ? '' : webgpu
              ? <span className="badge badge-ok">WebGPU 지원 — 고품질 모델 사용 가능</span>
              : <span className="badge badge-warn">{GROQ_ENABLED
                ? 'WebGPU 미지원 — 경량 모델 권장, Groq 키 사용을 추천합니다'
                : 'WebGPU 미지원 — 경량 모델을 사용합니다'}</span>}
          </p>
          {MODELS.map(m => (
            <div key={m.id} className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="radio" id={m.id} name="model" checked={form.whisperModel === m.id}
                onChange={() => setForm({ ...form, whisperModel: m.id })} />
              <label htmlFor={m.id}>{m.label} <span className="hint">— {m.desc}</span></label>
            </div>
          ))}
        </section>

        <section className="card" style={{ marginTop: 16 }}>
          <h2>언어</h2>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="lang">전사 언어</label>
            <select id="lang" className="input" value={form.language}
              onChange={e => setForm({ ...form, language: e.target.value })}>
              <option value="ko">한국어</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="zh">中文</option>
            </select>
          </div>
        </section>
      </details>

      <p style={{ marginTop: 18 }}>
        <button className="btn btn-primary" onClick={save}>저장</button>
      </p>
      {toast && <div className="toast">저장되었습니다</div>}
      {cacheToast && <div className="toast">캐시를 비웠어요</div>}
    </div>
  )
}
