import { useEffect, useState } from 'react'
import { loadSettings, saveSettings, type WhisperModelId } from '../../core/settings'
import { verifyGeminiKey, type GeminiKeyStatus } from '../../core/summarize/gemini'
import { upsertCorrection, type Correction } from '../../core/corrections'
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
  const [newFrom, setNewFrom] = useState('')
  const [newTo, setNewTo] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [keyStatus, setKeyStatus] = useState<GeminiKeyStatus | null>(null)

  useEffect(() => { void detectWebGPU().then(setWebgpu) }, [])
  useEffect(() => { void getStorageBreakdown().then(setStorage) }, [])

  // 저장 전 현재 입력한 키가 실제로 동작하는지 확인한다(요약 할당량 미소모, models.list).
  async function checkKey() {
    setVerifying(true)
    setKeyStatus(null)
    try {
      setKeyStatus(await verifyGeminiKey(form.geminiApiKey))
    } finally {
      setVerifying(false)
    }
  }

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

  // 보정 사전은 즉시 저장한다(별도 저장 버튼 불필요). form도 함께 갱신해 메인 저장과 어긋나지 않게 한다.
  function commitCorrections(next: Correction[]) {
    setForm(f => ({ ...f, corrections: next }))
    saveSettings({ corrections: next })
  }

  function addCorrection() {
    commitCorrections(upsertCorrection(form.corrections, newFrom.trim(), newTo.trim()))
    setNewFrom(''); setNewTo('')
  }

  function removeCorrection(index: number) {
    commitCorrections(form.corrections.filter((_, i) => i !== index))
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
            onChange={e => { setForm({ ...form, geminiApiKey: e.target.value }); setKeyStatus(null) }} />
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: 'flex-start' }}>
          <button type="button" className="btn btn-outline btn-sm"
            disabled={verifying || !form.geminiApiKey.trim()} onClick={() => void checkKey()}>
            {verifying ? '확인 중…' : '키 검증'}
          </button>
        </div>
        {keyStatus && (
          <p className="hint" role="status" style={{ marginTop: 8, color: keyStatus.ok ? '#15803D' : 'var(--warn-fg)' }}>
            {keyStatus.ok ? '✅ ' : '⚠️ '}{keyStatus.message}
            {keyStatus.ok && (
              <>
                {' · '}모델 {keyStatus.modelCount}개
                {' · '}gemini-3.5-flash {keyStatus.hasFlash ? '사용 가능' : '목록에 없음'}
                {keyStatus.flashInputLimit ? ` · 입력 한도 ${keyStatus.flashInputLimit.toLocaleString()} 토큰` : ''}
              </>
            )}
          </p>
        )}
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

      <section className="card" style={{ marginTop: 22 }}>
        <h2>분할 녹음</h2>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="split-minutes">분할 간격</label>
          <select id="split-minutes" className="input" aria-label="분할 간격" value={form.splitMinutes}
            onChange={e => setForm({ ...form, splitMinutes: Number(e.target.value) })}>
            <option value={0}>끄기</option>
            <option value={30}>30분</option>
            <option value={60}>1시간</option>
            <option value={90}>1시간 30분</option>
            <option value={120}>2시간</option>
          </select>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>간격을 넘기면 대화가 없는 순간에 자동으로 나눠 저장하고, 모두 끝나면 통합 요약해요.</p>
      </section>

      <section className="card" style={{ marginTop: 22 }}>
        <h2>단어 보정</h2>
        <p className="hint">자주 틀리게 전사되는 단어를 등록하면 전사할 때 자동으로 바꿔줘요. 전사문에서 단어를 드래그해 바로 등록할 수도 있어요.</p>
        {form.corrections.length === 0 ? (
          <p className="muted" style={{ marginTop: 10 }}>등록된 보정이 없어요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
            {form.corrections.map((c, i) => (
              <li key={`${c.from}-${i}`} className="row" style={{ justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <span><code>{c.from}</code> → <code>{c.to}</code></span>
                <button type="button" className="btn btn-ghost btn-sm" aria-label={`${c.from} 보정 삭제`}
                  style={{ color: 'var(--warn-fg)' }} onClick={() => removeCorrection(i)}>삭제</button>
              </li>
            ))}
          </ul>
        )}
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <input className="input" aria-label="보정 전 단어" placeholder="틀린 단어"
            value={newFrom} onChange={e => setNewFrom(e.target.value)} />
          <span aria-hidden="true">→</span>
          <input className="input" aria-label="보정 후 단어" placeholder="올바른 단어"
            value={newTo} onChange={e => setNewTo(e.target.value)} />
          <button type="button" className="btn btn-outline btn-sm" onClick={addCorrection}>추가</button>
        </div>
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
