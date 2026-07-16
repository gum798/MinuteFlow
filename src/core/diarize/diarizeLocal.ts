import type { WhisperProgress } from '../stt/whisperLocal'
import type { SpeakerRegion } from './assign'

type WorkerOut =
  | { status: 'progress'; file: string; progress: number }
  | { status: 'info'; message: string }
  | { status: 'done'; regions: SpeakerRegion[] }
  | { status: 'extracted'; targets: { start: number; end: number }[]; embeddings: Float32Array[] }
  | { status: 'error'; message: string }

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./diarize.worker.ts', import.meta.url), { type: 'module' })
}

export class DiarizeEngine {
  private worker: Worker | null = null
  private busy = false
  private activeReject: ((e: Error) => void) | null = null

  constructor(private createWorker: () => Worker = defaultCreateWorker) {}

  diarize(audio: Float32Array, onProgress?: (p: WhisperProgress) => void, numSpeakers?: number): Promise<SpeakerRegion[]> {
    if (this.busy) return Promise.reject(new Error('이미 화자 분리가 진행 중입니다.'))
    this.busy = true
    this.worker ??= this.createWorker()
    const worker = this.worker
    return new Promise<SpeakerRegion[]>((resolve, reject) => {
      this.activeReject = reject
      const settle = () => {
        this.busy = false
        this.activeReject = null
        worker.onmessage = null
      }
      worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
        const msg = ev.data
        if (msg.status === 'progress') onProgress?.({ kind: 'download', file: msg.file, progress: msg.progress })
        else if (msg.status === 'info') onProgress?.({ kind: 'status', message: msg.message })
        else if (msg.status === 'done') {
          settle()
          resolve(msg.regions)
        } else if (msg.status === 'error') {
          settle()
          reject(new Error(msg.message))
        }
      }
      worker.postMessage({ type: 'diarize', audio, numSpeakers })
    })
  }

  extract(
    audio: Float32Array,
    onProgress?: (p: WhisperProgress) => void,
  ): Promise<{ targets: { start: number; end: number }[]; embeddings: Float32Array[] }> {
    if (this.busy) return Promise.reject(new Error('이미 화자 분석이 진행 중입니다.'))
    this.busy = true
    this.worker ??= this.createWorker()
    const worker = this.worker
    return new Promise((resolve, reject) => {
      this.activeReject = reject
      const settle = () => { this.busy = false; this.activeReject = null; worker.onmessage = null }
      worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
        const msg = ev.data
        if (msg.status === 'progress') onProgress?.({ kind: 'download', file: msg.file, progress: msg.progress })
        else if (msg.status === 'info') onProgress?.({ kind: 'status', message: msg.message })
        else if (msg.status === 'extracted') { settle(); resolve({ targets: msg.targets, embeddings: msg.embeddings }) }
        else if (msg.status === 'error') { settle(); reject(new Error(msg.message)) }
      }
      worker.postMessage({ type: 'extract', audio })
    })
  }

  dispose(): void {
    const reject = this.activeReject
    this.activeReject = null
    this.busy = false
    reject?.(new Error('화자 분리가 취소되었습니다.'))
    this.worker?.terminate()
    this.worker = null
  }
}
