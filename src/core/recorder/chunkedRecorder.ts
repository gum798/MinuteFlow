export interface ChunkedRecorderEvents {
  onChunk(blob: Blob, seq: number): void
  onStallRestart(): void
  onError(err: Error): void
}

export interface ChunkedRecorderOptions {
  mimeType?: string
  timesliceMs?: number
  stallMs?: number
  createRecorder?: (s: MediaStream, o?: MediaRecorderOptions) => MediaRecorder
}

const WATCHDOG_INTERVAL_MS = 5_000

export class ChunkedRecorder {
  readonly mimeType: string
  private readonly timesliceMs: number
  private readonly stallMs: number
  private readonly createRecorder: NonNullable<ChunkedRecorderOptions['createRecorder']>
  private recorder: MediaRecorder | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private seq = 0
  private lastChunkAt = 0
  private stopping = false

  constructor(
    private stream: MediaStream,
    private events: ChunkedRecorderEvents,
    opts: ChunkedRecorderOptions = {},
  ) {
    this.mimeType = opts.mimeType ?? 'audio/webm'
    this.timesliceMs = opts.timesliceMs ?? 10_000
    this.stallMs = opts.stallMs ?? 25_000
    this.createRecorder = opts.createRecorder ?? ((s, o) => new MediaRecorder(s, o))
  }

  start(): void {
    this.spawn()
    this.lastChunkAt = Date.now()
    this.watchdog = setInterval(() => this.checkStall(), WATCHDOG_INTERVAL_MS)
  }

  private spawn(): void {
    const rec = this.createRecorder(this.stream, { mimeType: this.mimeType })
    rec.ondataavailable = ev => {
      if (ev.data.size === 0) return
      this.lastChunkAt = Date.now()
      this.events.onChunk(ev.data, this.seq++)
    }
    rec.onerror = () => this.events.onError(new Error('MediaRecorder error'))
    rec.start(this.timesliceMs)
    this.recorder = rec
  }

  private checkStall(): void {
    if (this.stopping || Date.now() - this.lastChunkAt < this.stallMs) return
    this.events.onStallRestart()
    try { this.recorder?.stop() } catch { /* 이미 죽은 recorder */ }
    this.spawn()
    this.lastChunkAt = Date.now()
  }

  stop(): Promise<void> {
    this.stopping = true
    if (this.watchdog) clearInterval(this.watchdog)
    const rec = this.recorder
    if (!rec || rec.state === 'inactive') return Promise.resolve()
    return new Promise(resolve => {
      rec.onstop = () => resolve()
      try { rec.requestData() } catch { /* flush 불가 시 무시 */ }
      rec.stop()
    })
  }
}
