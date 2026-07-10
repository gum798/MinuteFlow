import { summarizeWithGemini } from './gemini'

// SSE 스트림 응답을 흉내낸다 — 각 chunk를 순서대로 흘려보내고 닫는다.
function sseResponse(chunks: string[], status = 200) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close() },
  })
  return new Response(stream, { status })
}

// candidates 텍스트 하나를 담은 SSE data 이벤트를 만든다.
function dataEvent(text: string) {
  return `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] })}\n\n`
}

test('요청은 SSE 스트리밍 엔드포인트로, 여러 이벤트를 누적 결합하고 onDelta를 갱신마다 호출', async () => {
  const fetchFn = vi.fn(async () => sseResponse([dataEvent('## 요약\n'), dataEvent('본문')]))
  const deltas: string[] = []
  const out = await summarizeWithGemini('프롬프트', 'AIza_1', {
    fetchFn: fetchFn as unknown as typeof fetch,
    onDelta: acc => deltas.push(acc),
  })
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse')
  const headers = init.headers as Record<string, string>
  expect(headers['x-goog-api-key']).toBe('AIza_1')
  expect(headers['Content-Type']).toBe('application/json')
  const body = JSON.parse(init.body as string)
  expect(body.contents[0].parts[0].text).toBe('프롬프트')
  expect(body.generationConfig.temperature).toBe(0.3)
  expect(out).toBe('## 요약\n본문')
  // onDelta는 텍스트가 붙을 때마다 누적본으로 호출된다.
  expect(deltas).toEqual(['## 요약\n', '## 요약\n본문'])
})

test('라인이 청크 경계에 걸쳐 쪼개져도 정확히 파싱', async () => {
  const full = dataEvent('나뉜 본문') // 하나의 data 이벤트
  const cut = Math.floor(full.length / 2)
  const fetchFn = vi.fn(async () => sseResponse([full.slice(0, cut), full.slice(cut)]))
  const out = await summarizeWithGemini('p', 'k', { fetchFn: fetchFn as unknown as typeof fetch })
  expect(out).toBe('나뉜 본문')
})

test('fetch가 계속 throw(연결 실패)하면 재시도 소진 후 친화적 네트워크 안내로 감싼다', async () => {
  const fetchFn = vi.fn(async () => { throw new TypeError('Load failed') })
  await expect(summarizeWithGemini('p', 'k', { fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }))
    .rejects.toThrow(/분할 녹음|다시 시도/)
  expect(fetchFn).toHaveBeenCalledTimes(4) // 첫 요청 + 재시도 3회
  // 원시 'Load failed'가 그대로 새어나오지 않아야 한다.
  await expect(summarizeWithGemini('p', 'k', { fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {} }))
    .rejects.not.toThrow(/Load failed/)
})

test('연결이 한 번 끊겼다 회복되면 재시도로 요약을 반환한다', async () => {
  const fetchFn = vi.fn()
    .mockRejectedValueOnce(new TypeError('네트워크 연결이 유실되었습니다'))
    .mockResolvedValueOnce(sseResponse([dataEvent('회복됨')]))
  const sleeps: number[] = []
  const out = await summarizeWithGemini('p', 'k', {
    fetchFn: fetchFn as unknown as typeof fetch, sleep: async ms => { sleeps.push(ms) },
  })
  expect(out).toBe('회복됨')
  expect(fetchFn).toHaveBeenCalledTimes(2)
  expect(sleeps).toEqual([1000])
})

test('400 API_KEY_INVALID는 스트림 열기 전 상태로 판정해 키 오류로', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({
    error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
  }), { status: 400 }))
  await expect(summarizeWithGemini('p', 'bad', { fetchFn: fetchFn as unknown as typeof fetch }))
    .rejects.toThrow(/API 키/)
})

test('429는 retryDelay만큼 대기 후 1회 재시도(스트리밍)', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' }] },
    }), { status: 429 }))
    .mockResolvedValueOnce(sseResponse([dataEvent('## 요약\n'), dataEvent('성공')]))
  const sleeps: number[] = []
  const out = await summarizeWithGemini('p', 'k', {
    fetchFn: fetchFn as unknown as typeof fetch, sleep: async ms => { sleeps.push(ms) },
  })
  expect(sleeps).toEqual([3000])
  expect(out).toBe('## 요약\n성공')
})

test('503(과부하)은 지수 백오프로 재시도하고 회복되면 요약을 반환한다', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }), { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }), { status: 503 }))
    .mockResolvedValueOnce(sseResponse([dataEvent('회복됨')]))
  const sleeps: number[] = []
  const out = await summarizeWithGemini('p', 'k', {
    fetchFn: fetchFn as unknown as typeof fetch, sleep: async ms => { sleeps.push(ms) },
  })
  expect(fetchFn).toHaveBeenCalledTimes(3)
  expect(sleeps).toEqual([1000, 2000]) // 첫 재시도 1s, 둘째 2s (지수 백오프)
  expect(out).toBe('회복됨')
})

test('503이 재시도를 소진할 때까지 계속되면 503 안내로 실패한다', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { code: 503 } }), { status: 503 }))
  await expect(summarizeWithGemini('p', 'k', {
    fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {},
  })).rejects.toThrow(/503/)
  expect(fetchFn).toHaveBeenCalledTimes(4) // 첫 요청 + 재시도 3회
})

test('candidates 없는 빈 스트림은 안전 필터 안내', async () => {
  const blocked = `data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\n\n`
  const fetchFn = vi.fn(async () => sseResponse([blocked]))
  await expect(summarizeWithGemini('p', 'k', { fetchFn: fetchFn as unknown as typeof fetch }))
    .rejects.toThrow(/안전 필터/)
})
