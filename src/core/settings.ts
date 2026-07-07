export type WhisperModelId =
  | 'onnx-community/whisper-large-v3-turbo'
  | 'onnx-community/whisper-base'

export interface AppSettings {
  groqApiKey: string
  geminiApiKey: string
  whisperModel: WhisperModelId
  language: string
}

const KEY = 'minuteflow.settings'

const DEFAULTS: AppSettings = {
  groqApiKey: '',
  geminiApiKey: '',
  whisperModel: 'onnx-community/whisper-large-v3-turbo',
  language: 'ko',
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
