import { summarizeWithGemini } from './gemini'

function ok(text: string) {
  return new Response(JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: '## 요약\n' }, { text }] }, finishReason: 'STOP' }],
  }), { status: 200 })
}

test('요청 형식과 다중 parts 결합', async () => {
  const fetchFn = vi.fn(async () => ok('본문'))
  const out = await summarizeWithGemini('프롬프트', 'AIza_1', { fetchFn: fetchFn as unknown as typeof fetch })
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent')
  const headers = init.headers as Record<string, string>
  expect(headers['x-goog-api-key']).toBe('AIza_1')
  expect(headers['Content-Type']).toBe('application/json')
  const body = JSON.parse(init.body as string)
  expect(body.contents[0].parts[0].text).toBe('프롬프트')
  expect(out).toBe('## 요약\n본문')
})

test('400 API_KEY_INVALID는 키 오류로', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({
    error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
  }), { status: 400 }))
  await expect(summarizeWithGemini('p', 'bad', { fetchFn: fetchFn as unknown as typeof fetch }))
    .rejects.toThrow(/API 키/)
})

test('429는 retryDelay만큼 대기 후 1회 재시도', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' }] },
    }), { status: 429 }))
    .mockResolvedValueOnce(ok('성공'))
  const sleeps: number[] = []
  const out = await summarizeWithGemini('p', 'k', {
    fetchFn: fetchFn as unknown as typeof fetch, sleep: async ms => { sleeps.push(ms) },
  })
  expect(sleeps).toEqual([3000])
  expect(out).toBe('## 요약\n성공')
})

test('candidates가 없으면 안전 필터 안내', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }))
  await expect(summarizeWithGemini('p', 'k', { fetchFn: fetchFn as unknown as typeof fetch }))
    .rejects.toThrow(/안전 필터/)
})
