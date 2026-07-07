import { useEffect, useState } from 'react'
import { loadSettings, saveSettings, type WhisperModelId } from '../../core/settings'
import { detectWebGPU } from '../../core/stt/whisperLocal'

const MODELS: { id: WhisperModelId; label: string; desc: string }[] = [
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'whisper-large-v3-turbo', desc: '고품질 · 다운로드 약 560MB · WebGPU 권장' },
  { id: 'onnx-community/whisper-base', label: 'whisper-base', desc: '경량 · 약 200MB · 저사양/WASM용' },
]

export default function Settings() {
  const [form, setForm] = useState(loadSettings)
  const [webgpu, setWebgpu] = useState<boolean | null>(null)
  const [toast, setToast] = useState(false)

  useEffect(() => { void detectWebGPU().then(setWebgpu) }, [])

  function save() {
    saveSettings(form)
    setToast(true)
    setTimeout(() => setToast(false), 2000)
  }

  return (
    <div>
      <h1>설정</h1>
      <p className="sub">모든 설정과 키는 이 브라우저에만 저장되며 어떤 서버로도 전송되지 않습니다.</p>

      <section className="card" style={{ marginTop: 22 }}>
        <h2>Groq API 키 (파일 전사 고속 처리)</h2>
        <p className="hint">
          <a href="https://console.groq.com" target="_blank" rel="noreferrer">console.groq.com</a>에서
          무료로 발급받을 수 있습니다. 무료 한도: 하루 오디오 8시간.
        </p>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="groq-key">Groq API 키</label>
          <input id="groq-key" type="password" className="input" placeholder="gsk_..."
            value={form.groqApiKey}
            onChange={e => setForm({ ...form, groqApiKey: e.target.value })} />
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>브라우저 Whisper 모델</h2>
        <p className="hint" style={{ marginBottom: 10 }}>
          {webgpu === null ? '' : webgpu
            ? <span className="badge badge-ok">WebGPU 지원 — 고품질 모델 사용 가능</span>
            : <span className="badge badge-warn">WebGPU 미지원 — 경량 모델 권장, Groq 키 사용을 추천합니다</span>}
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

      <p style={{ marginTop: 18 }}>
        <button className="btn btn-primary" onClick={save}>저장</button>
      </p>
      {toast && <div className="toast">저장되었습니다</div>}
    </div>
  )
}
