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
}

const KEY = 'minuteflow.settings'

const DEFAULTS: AppSettings = {
  groqApiKey: '',
  geminiApiKey: '',
  whisperModel: 'onnx-community/whisper-large-v3-turbo',
  language: 'ko',
  autoPipeline: true,
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
