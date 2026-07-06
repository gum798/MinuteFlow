export interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: RecognitionResultEvent) => void) | null
  onend: (() => void) | null
  onerror: ((ev: unknown) => void) | null
  start(): void
  stop(): void
  abort(): void
}

export interface RecognitionResultEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

export type SpeechRecognitionCtor = new () => RecognitionLike

export function getSpeechRecognitionCtor(win: unknown = globalThis): SpeechRecognitionCtor | null {
  const w = win as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null
}

export type WebSpeechStatus = 'idle' | 'listening' | 'restarting' | 'stopped'

export interface WebSpeechEvents {
  onInterim(text: string): void
  onFinal(text: string): void
  onStatus(status: WebSpeechStatus): void
}

export class WebSpeechEngine {
  private recognition: RecognitionLike | null = null
  private userStopped = false

  constructor(
    private ctor: SpeechRecognitionCtor,
    private lang: string,
    private events: WebSpeechEvents,
  ) {}

  start(): void {
    this.userStopped = false
    const rec = new this.ctor()
    rec.lang = this.lang
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = ev => this.handleResult(ev)
    rec.onend = () => this.handleEnd()
    rec.onerror = () => { /* onend가 뒤따라 오므로 재시작은 handleEnd가 담당 */ }
    this.recognition = rec
    rec.start()
    this.events.onStatus('listening')
  }

  stop(): void {
    this.userStopped = true
    this.recognition?.stop()
  }

  private handleResult(ev: RecognitionResultEvent): void {
    let interim = ''
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i]
      const text = result[0].transcript.trim()
      if (!text) continue
      if (result.isFinal) this.events.onFinal(text)
      else interim += text
    }
    this.events.onInterim(interim)
  }

  private handleEnd(): void {
    if (this.userStopped) {
      this.events.onStatus('stopped')
      return
    }
    this.events.onStatus('restarting')
    try {
      this.recognition?.start()
      this.events.onStatus('listening')
    } catch {
      // InvalidStateError 등 — 잠시 후 재시도
      setTimeout(() => { if (!this.userStopped) this.start() }, 250)
    }
  }
}
