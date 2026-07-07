import type { DraftSegment } from './types'

export type WhisperProgress =
  | { kind: 'download'; file: string; progress: number }
  | { kind: 'status'; message: string }

export async function detectWebGPU(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

type WorkerOut =
  | { status: 'progress'; file: string; progress: number }
  | { status: 'info'; message: string }
  | { status: 'done'; chunks: { text: string; timestamp: [number, number | null] }[] }
  | { status: 'error'; message: string }

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
}

export class WhisperLocalEngine {
  private worker: Worker | null = null

  constructor(private createWorker: () => Worker = defaultCreateWorker) {}

  transcribe(
    audio: Float32Array,
    opts: { model: string; device: 'webgpu' | 'wasm'; language: string },
    onProgress?: (p: WhisperProgress) => void,
  ): Promise<DraftSegment[]> {
    this.worker ??= this.createWorker()
    const worker = this.worker
    return new Promise((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
        const msg = ev.data
        if (msg.status === 'progress') onProgress?.({ kind: 'download', file: msg.file, progress: msg.progress })
        else if (msg.status === 'info') onProgress?.({ kind: 'status', message: msg.message })
        else if (msg.status === 'done') {
          resolve(msg.chunks.map(c => ({
            startSec: c.timestamp[0],
            endSec: c.timestamp[1] ?? c.timestamp[0],
            text: c.text.trim(),
          })))
        } else if (msg.status === 'error') reject(new Error(msg.message))
      }
      worker.postMessage({ type: 'transcribe', audio, ...opts })
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
