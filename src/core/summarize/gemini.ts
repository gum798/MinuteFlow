const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface GeminiError {
  error?: { code?: number; status?: string; details?: { reason?: string; retryDelay?: string }[] }
}

function parseRetryMs(body: GeminiError): number {
  const raw = body.error?.details?.find(d => d.retryDelay)?.retryDelay
  const sec = raw ? Number.parseFloat(raw) : NaN
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 15_000
}

async function requestOnce(prompt: string, apiKey: string, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 },
    }),
  })
}

export async function summarizeWithGemini(
  prompt: string, apiKey: string,
  opts: { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch
  let res = await requestOnce(prompt, apiKey, fetchFn)
  if (res.status === 429) {
    const body = (await res.json()) as GeminiError
    await (opts.sleep ?? defaultSleep)(parseRetryMs(body))
    res = await requestOnce(prompt, apiKey, fetchFn)
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
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const parts = data.candidates?.[0]?.content?.parts
  if (!parts || parts.length === 0) throw new Error('안전 필터로 요약이 차단되었습니다. 내용을 확인해주세요.')
  return parts.map(p => p.text ?? '').join('')
}
