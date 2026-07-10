// Safari fetch의 ~60초 타임아웃 회피를 위해 비스트리밍 generateContent 대신 SSE 스트리밍을 쓴다.
// 첫 청크가 수 초 내 도착해 커넥션이 끊기지 않으므로 2시간+ 회의도 'Load failed' 없이 요약된다.
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse'
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

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

function requestOnce(prompt: string, apiKey: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<Response> {
  return fetchFn(ENDPOINT, {
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

export async function summarizeWithGemini(
  prompt: string, apiKey: string,
  opts: { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; onDelta?: (accumulated: string) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch
  const send = async (): Promise<Response> => {
    try {
      return await requestOnce(prompt, apiKey, fetchFn, opts.signal)
    } catch {
      // Safari 60초 타임아웃 등 fetch 자체 실패(TypeError 'Load failed')를 친화적 안내로 감싼다.
      throw new Error(NETWORK_MSG)
    }
  }
  // 상태 판정은 body 스트림을 열기 전 res.status로 한다(429 재시도·HTTP 에러 구분).
  let res = await send()
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as GeminiError
    await (opts.sleep ?? defaultSleep)(parseRetryMs(body))
    res = await send()
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as GeminiError
    const reason = body.error?.details?.find(d => d.reason)?.reason
    if (res.status === 400 && reason === 'API_KEY_INVALID')
      throw new Error('Gemini API 키를 확인해주세요. (설정에서 재등록)')
    if (res.status === 403) throw new Error('API 키 권한을 확인해주세요.')
    if (res.status === 429) throw new Error('무료 사용량을 잠시 초과했습니다. 잠시 후 다시 시도해주세요.')
    throw new Error(`요약 요청 실패 (${res.status})`)
  }
  return readSseStream(res, opts.onDelta)
}
