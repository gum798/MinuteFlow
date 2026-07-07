import { pipeline } from '@huggingface/transformers'

const PER_DEVICE_CONFIG = {
  webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, device: 'webgpu' },
  wasm: { dtype: 'q8', device: 'wasm' },
} as const

type InMsg = { type: 'transcribe'; audio: Float32Array; model: string; device: 'webgpu' | 'wasm'; language: string }

// transformers.js의 pipeline()은 모든 파이프라인의 유니온 타입을 반환해 strict TS에서 호출 불가.
// ASR 파이프라인의 실제 호출 시그니처/출력만 최소 캐스트로 명시한다.
type ASROutput = { text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }
type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<ASROutput | ASROutput[]>

let transcriber: Transcriber | null = null
let loadedKey = ''

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const { audio, model, device, language } = ev.data
  try {
    const key = `${model}|${device}`
    if (!transcriber || loadedKey !== key) {
      transcriber = (await pipeline('automatic-speech-recognition', model, {
        ...PER_DEVICE_CONFIG[device],
        progress_callback: (x: { status: string; file?: string; progress?: number }) => {
          if (x.status === 'progress') {
            self.postMessage({ status: 'progress', file: x.file ?? '', progress: x.progress ?? 0 })
          }
        },
      })) as unknown as Transcriber
      loadedKey = key
      if (device === 'webgpu') {
        self.postMessage({ status: 'info', message: '셰이더 컴파일 및 워밍업 중…' })
        await transcriber(new Float32Array(16_000), { language })
      }
    }
    self.postMessage({ status: 'info', message: '전사 중…' })
    const output = await transcriber(audio, {
      language,
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    })
    const chunks = (Array.isArray(output) ? output[0] : output).chunks ?? []
    self.postMessage({ status: 'done', chunks })
  } catch (e) {
    self.postMessage({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
