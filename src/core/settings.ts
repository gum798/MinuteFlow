export type WhisperModelId =
  | 'onnx-community/whisper-large-v3-turbo'
  | 'onnx-community/whisper-base'

export interface AppSettings {
  groqApiKey: string
  geminiApiKey: string
  whisperModel: WhisperModelId
  language: string
  /** 녹음 종료 후 자동으로 재전사·화자 구분·AI 요약을 실행할지 (기본 켜짐). */
  autoPipeline: boolean
  /** 녹음이 이 분(minute)을 넘으면 무음 시점에 새 부(part)로 분할한다. 0이면 분할 끄기. (기본 60) */
  splitMinutes: number
}

const KEY = 'minuteflow.settings'

const DEFAULTS: AppSettings = {
  groqApiKey: '',
  geminiApiKey: '',
  whisperModel: 'onnx-community/whisper-large-v3-turbo',
  language: 'ko',
  autoPipeline: true,
  splitMinutes: 60,
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}
