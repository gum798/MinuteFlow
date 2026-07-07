import { transcribeBlobWithGroq, transcribeSamplesWithGroq } from './groq'

function okResponse(segments: { start: number; end: number; text: string }[]) {
  return new Response(JSON.stringify({ text: 'x', segments }), { status: 200 })
}

test('FormData 필드와 인증 헤더가 규격대로 전송된다', async () => {
  const fetchFn = vi.fn(async () => okResponse([{ start: 0, end: 2, text: ' 안녕' }]))
  const segs = await transcribeBlobWithGroq(new Blob(['x'], { type: 'audio/webm' }), 'rec.webm', {
    apiKey: 'gsk_1', language: 'ko', fetchFn: fetchFn as unknown as typeof fetch,
  })
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_1')
  expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined() // boundary 자동
  const form = init.body as FormData
  expect((form.get('file') as File).name).toBe('rec.webm')
  expect(form.get('model')).toBe('whisper-large-v3-turbo')
  expect(form.get('language')).toBe('ko')
  expect(form.get('response_format')).toBe('verbose_json')
  expect(segs).toEqual([{ startSec: 0, endSec: 2, text: '안녕' }])
})

test('429는 retry-after 후 1회 재시도한다', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3' } }))
    .mockResolvedValueOnce(okResponse([{ start: 0, end: 1, text: 'ok' }]))
  const sleeps: number[] = []
  const segs = await transcribeBlobWithGroq(new Blob(['x']), 'a.wav', {
    apiKey: 'k', language: 'ko', fetchFn: fetchFn as unknown as typeof fetch,
    sleep: async ms => { sleeps.push(ms) },
  })
  expect(sleeps).toEqual([3000])
  expect(segs).toHaveLength(1)
})

test('401은 키 확인 에러', async () => {
  const fetchFn = vi.fn(async () => new Response('', { status: 401 }))
  await expect(transcribeBlobWithGroq(new Blob(['x']), 'a.wav', {
    apiKey: 'bad', language: 'ko', fetchFn: fetchFn as unknown as typeof fetch,
  })).rejects.toThrow(/API 키/)
})

test('대용량 샘플은 분할 전사 후 오프셋 보정 병합된다', async () => {
  const fetchFn = vi.fn(async () => okResponse([{ start: 0, end: 1, text: '부분' }]))
  const parts: [number, number][] = []
  const samples = new Float32Array(16000 * 3) // 3초
  const segs = await transcribeSamplesWithGroq(samples, {
    apiKey: 'k', language: 'ko', fetchFn: fetchFn as unknown as typeof fetch,
    maxSec: 1, onPart: (d, t) => parts.push([d, t]),
  })
  expect(fetchFn).toHaveBeenCalledTimes(3)
  expect(segs.map(s => s.startSec)).toEqual([0, 1, 2]) // 각 조각 start 0 + 오프셋 0,1,2
  expect(parts).toEqual([[1, 3], [2, 3], [3, 3]])
})
