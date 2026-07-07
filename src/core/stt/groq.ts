import type { DraftSegment } from './types'
import { encodeWav16k, splitForGroq } from '../audio/wav'

export const GROQ_FILE_LIMIT = 25 * 1024 * 1024
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'

interface GroqOpts {
  apiKey: string
  language: string
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function requestOnce(blob: Blob, filename: string, opts: GroqOpts): Promise<Response> {
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('model', 'whisper-large-v3-turbo')
  form.append('language', opts.language)
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0')
  const fetchFn = opts.fetchFn ?? fetch
  return fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}` }, // Content-Type 지정 금지 (boundary 자동)
    body: form,
  })
}

export async function transcribeBlobWithGroq(
  blob: Blob, filename: string, opts: GroqOpts,
): Promise<DraftSegment[]> {
  let res = await requestOnce(blob, filename, opts)
  if (res.status === 429) {
    const waitSec = Number(res.headers.get('retry-after') ?? '10')
    await (opts.sleep ?? defaultSleep)(waitSec * 1000)
    res = await requestOnce(blob, filename, opts)
  }
  if (res.status === 401) throw new Error('Groq API 키를 확인해주세요. (설정에서 재등록)')
  if (res.status === 429) throw new Error('Groq 무료 한도를 초과했습니다. 잠시 후 다시 시도하거나 로컬 전사를 사용해주세요.')
  if (!res.ok) throw new Error(`Groq 오류 (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { segments?: { start: number; end: number; text: string }[] }
  return (data.segments ?? []).map(s => ({ startSec: s.start, endSec: s.end, text: s.text.trim() }))
}

export async function transcribeSamplesWithGroq(
  samples: Float32Array,
  opts: GroqOpts & { maxSec?: number; onPart?: (done: number, total: number) => void },
): Promise<DraftSegment[]> {
  const parts = splitForGroq(samples, opts.maxSec ?? 750)
  const all: DraftSegment[] = []
  for (let i = 0; i < parts.length; i++) {
    const segs = await transcribeBlobWithGroq(encodeWav16k(parts[i].samples), `part-${i}.wav`, opts)
    all.push(...segs.map(s => ({
      ...s,
      startSec: s.startSec + parts[i].offsetSec,
      endSec: s.endSec + parts[i].offsetSec,
    })))
    opts.onPart?.(i + 1, parts.length)
  }
  return all
}
