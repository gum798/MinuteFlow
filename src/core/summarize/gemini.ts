// Safari fetch의 ~60초 타임아웃 회피를 위해 비스트리밍 generateContent 대신 SSE 스트리밍을 쓴다.
// 첫 청크가 수 초 내 도착해 커넥션이 끊기지 않으므로 2시간+ 회의도 'Load failed' 없이 요약된다.
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
// 일시적으로 재시도할 HTTP 상태(rate limit·서버 과부하).
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
// 요약에 쓸 모델. 앞에서부터 시도하고, 지속 과부하(503)·모델 없음(404)이면 다음으로 폴백한다.
// 최신 flash가 붐빌 때 구형 flash는 대개 여유가 있어 성공률이 높다. 각 모델당 시도 횟수.
const SUMMARY_MODELS = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash']
const ATTEMPTS_PER_MODEL = 2
function endpointFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`
}

// fetch 자체가 throw(Safari 타임아웃 시 TypeError 'Load failed')하거나 스트림이 도중에 끊겼을 때의 안내.
const NETWORK_MSG = '네트워크 응답이 지연됐어요. 요약할 내용이 매우 길 수 있어요 — 잠시 후 다시 시도하거나, 설정에서 분할 녹음을 켜서 회의를 나눠 요약해보세요.'
const SAFETY_MSG = '안전 필터로 요약이 차단되었습니다. 내용을 확인해주세요.'

interface GeminiError {
  error?: { code?: number; status?: string; details?: { reason?: string; retryDelay?: string }[] }
}

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

function parseRetryMs(body: GeminiError): number {
  const raw = body.error?.details?.find(d => d.retryDelay)?.retryDelay
  const sec = raw ? Number.parseFloat(raw) : NaN
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 15_000
}

function requestOnce(model: string, prompt: string, apiKey: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<Response> {
  return fetchFn(endpointFor(model), {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 },
    }),
    signal,
  })
}

// SSE data 라인이면 payload(JSON 문자열 또는 '[DONE]')를, 아니면 null을 돌려준다.
function dataPayload(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  return trimmed.slice(5).trim()
}

// 한 data 이벤트의 JSON에서 candidates[0].content.parts[].text를 이어붙인다(파싱 실패·빈 candidates는 '').
function textFromData(payload: string): string {
  try {
    const json = JSON.parse(payload) as GeminiChunk
    const parts = json.candidates?.[0]?.content?.parts
    return parts ? parts.map(p => p.text ?? '').join('') : ''
  } catch {
    return ''
  }
}

// 첫 응답이 정상(res.ok)일 때 body를 SSE로 읽어 누적 텍스트를 만든다.
// - 부분 라인 버퍼링: 청크 경계가 라인 중간일 수 있어 버퍼에 이어붙이고 \n 단위로 처리, 미완 라인은 남긴다.
// - 도중 read()가 throw(중간 끊김)하면 누적분이 있으면 반환, 없으면 네트워크 안내.
// - candidates 텍스트 없이 정상 종료되면(안전필터) 안전 필터 안내.
async function readSseStream(res: Response, onDelta?: (accumulated: string) => void): Promise<string> {
  const body = res.body
  if (!body) throw new Error(NETWORK_MSG)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let finished = false
  const consume = (line: string): boolean => {
    const payload = dataPayload(line)
    if (payload === null) return false
    if (payload === '[DONE]') return true
    const text = textFromData(payload)
    if (text) { accumulated += text; onDelta?.(accumulated) }
    return false
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (consume(line)) { finished = true; break }
      }
      if (finished) break
    }
    // 마지막 미완 라인(개행 없이 끝난 경우) 처리 — 정상 종료 시에만.
    if (!finished) { buffer += decoder.decode(); consume(buffer) }
  } catch {
    if (accumulated) return accumulated
    throw new Error(NETWORK_MSG)
  } finally {
    void reader.cancel().catch(() => {}) // 조기 종료·중단 시 커넥션 해제 (정상 종료면 no-op)
  }
  if (!accumulated) throw new Error(SAFETY_MSG)
  return accumulated
}

// 키 검증 결과. kind로 상태를 구분하고, 정상이면 접근 가능 모델·flash 한도(등급/상태 정보)를 함께 준다.
export interface GeminiKeyStatus {
  ok: boolean
  kind: 'valid' | 'invalid' | 'no-permission' | 'rate-limited' | 'server-error' | 'network-error' | 'empty'
  message: string
  modelCount?: number
  hasFlash?: boolean
  flashInputLimit?: number
}

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

interface ModelsList {
  models?: { name?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[]
}

/**
 * Gemini API 키가 실제로 동작하는지 검증한다. 요약 할당량을 쓰지 않는 models.list(GET)로 확인한다.
 * 정상이면 접근 가능 모델 수·앱이 쓰는 gemini-3.5-flash 접근 여부·입력 토큰 한도를 함께 돌려준다.
 */
export async function verifyGeminiKey(apiKey: string, fetchFn: typeof fetch = fetch): Promise<GeminiKeyStatus> {
  if (!apiKey.trim()) return { ok: false, kind: 'empty', message: '키가 비어 있어요. 먼저 키를 입력해주세요.' }
  let res: Response
  try {
    res = await fetchFn(`${MODELS_ENDPOINT}?pageSize=100`, { headers: { 'x-goog-api-key': apiKey } })
  } catch {
    return { ok: false, kind: 'network-error', message: '네트워크 오류로 확인하지 못했어요. 잠시 후 다시 시도해주세요.' }
  }
  if (res.status === 400 || res.status === 401)
    return { ok: false, kind: 'invalid', message: '키가 유효하지 않습니다. Google AI Studio에서 다시 확인해주세요.' }
  if (res.status === 403)
    return { ok: false, kind: 'no-permission', message: '이 키로 Generative Language API 권한이 없어요. (API 사용 설정 확인)' }
  if (res.status === 429)
    return { ok: false, kind: 'rate-limited', message: '사용량을 잠시 초과했어요. 키는 정상일 수 있으니 잠시 후 다시 시도해주세요.' }
  if (!res.ok)
    return { ok: false, kind: 'server-error', message: `구글 서버 일시 오류(${res.status}). 키 상태는 불명이에요. 잠시 후 다시 시도해주세요.` }
  const body = (await res.json().catch(() => ({}))) as ModelsList
  const models = body.models ?? []
  const flash = models.find(m => (m.name ?? '').includes('gemini-3.5-flash'))
  return {
    ok: true, kind: 'valid', message: '키가 정상 동작합니다.',
    modelCount: models.length, hasFlash: !!flash, flashInputLimit: flash?.inputTokenLimit,
  }
}

export async function summarizeWithGemini(
  prompt: string, apiKey: string,
  opts: { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; onDelta?: (accumulated: string) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const backoffMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 8000)
  // 모델별로 ATTEMPTS_PER_MODEL회 시도한다. 한 시도 = 요청 + (일시 오류면 재시도 신호) + 스트림 읽기.
  //  · fetch 실패(연결 유실)·일시 HTTP(429·5xx)·내용 없이 끊긴 스트림 → 같은 모델 재시도 후, 소진 시 다음 모델로 폴백.
  //  · 404(모델 없음) → 재시도 없이 다음 모델로.
  //  · 키/권한 영구 오류·안전필터·부분 성공 → 즉시 던진다(폴백 무의미).
  let lastError = new Error(NETWORK_MSG)
  for (const model of SUMMARY_MODELS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      let res: Response
      try {
        res = await requestOnce(model, prompt, apiKey, fetchFn, opts.signal)
      } catch {
        lastError = new Error(NETWORK_MSG)
        if (attempt < ATTEMPTS_PER_MODEL) { await sleep(backoffMs(attempt)); continue }
        break // 이 모델의 네트워크 시도 소진 → 다음 모델
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        const body = (await res.json().catch(() => ({}))) as GeminiError
        lastError = new Error(res.status === 503
          ? '요약 서버가 잠시 혼잡합니다(503). 잠시 후 다시 시도해주세요.'
          : res.status === 429 ? '무료 사용량을 잠시 초과했습니다. 잠시 후 다시 시도해주세요.' : `요약 요청 실패 (${res.status})`)
        if (attempt < ATTEMPTS_PER_MODEL) { await sleep(res.status === 429 ? parseRetryMs(body) : backoffMs(attempt)); continue }
        break // 재시도 소진 → 다음 모델로 폴백
      }
      if (res.status === 404) { lastError = new Error(`요약 요청 실패 (${res.status})`); break } // 모델 없음 → 다음 모델
      if (!res.ok) {
        // 키/권한 등 영구 오류 → 폴백해도 소용없으니 즉시 안내.
        const body = (await res.json().catch(() => ({}))) as GeminiError
        const reason = body.error?.details?.find(d => d.reason)?.reason
        if (res.status === 400 && reason === 'API_KEY_INVALID')
          throw new Error('Gemini API 키를 확인해주세요. (설정에서 재등록)')
        if (res.status === 403) throw new Error('API 키 권한을 확인해주세요.')
        throw new Error(`요약 요청 실패 (${res.status})`)
      }
      try {
        return await readSseStream(res, opts.onDelta)
      } catch (e) {
        // 내용 없이 끊긴 스트림(NETWORK_MSG)만 재시도/폴백. 안전필터·부분성공은 그대로 던진다.
        if (!(e instanceof Error) || e.message !== NETWORK_MSG) throw e
        lastError = e
        if (attempt < ATTEMPTS_PER_MODEL) { await sleep(backoffMs(attempt)); continue }
        break // → 다음 모델
      }
    }
  }
  throw lastError // 모든 모델 실패 → 마지막 오류 안내
}
