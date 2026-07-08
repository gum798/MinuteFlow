import { pipeline } from '@huggingface/transformers'
import { buildWhisperLoadPlan } from './loadPlan'

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
    // 캐시는 요청 (model,device)로 키를 잡는다 — 폴백으로 실제 로딩된 조합이 달라도,
    // 동일 요청 재전사 시 실패하는 사다리를 다시 타지 않고 로딩된 transcriber를 재사용한다.
    const key = `${model}|${device}`
    if (!transcriber || loadedKey !== key) {
      // fp16 인코더 세션 생성이 특정 GPU/실행기에서 실패하는 문제에 대응해,
      // 실패 시 더 안전한 조합으로 순차 폴백한다(호환 사다리).
      const plan = buildWhisperLoadPlan(model, device)
      let loaded: Transcriber | null = null
      let lastError: unknown = null
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i]
        try {
          const t = (await pipeline('automatic-speech-recognition', step.model, {
            device: step.device,
            dtype: step.dtype,
            progress_callback: (x: { status: string; file?: string; progress?: number }) => {
              if (x.status === 'progress') {
                self.postMessage({ status: 'progress', file: x.file ?? '', progress: x.progress ?? 0 })
              }
            },
          } as unknown as Parameters<typeof pipeline>[2])) as unknown as Transcriber
          // webgpu는 셰이더 컴파일이 지연될 수 있어 워밍업으로 세션 생성을 강제 검증한다.
          // 여기서 fp16 세션 실패가 드러나면 다음(더 안전한) 스텝으로 폴백된다.
          if (step.device === 'webgpu') {
            self.postMessage({ status: 'info', message: '셰이더 컴파일 및 워밍업 중…' })
            await t(new Float32Array(16_000), { language })
          }
          loaded = t
          break
        } catch (e) {
          lastError = e
          if (i < plan.length - 1) {
            self.postMessage({ status: 'info', message: '호환 모드로 재시도 중…' })
          }
        }
      }
      if (!loaded) throw lastError instanceof Error ? lastError : new Error(String(lastError))
      transcriber = loaded
      loadedKey = key
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
