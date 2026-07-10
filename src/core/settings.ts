import type { Correction } from './corrections'

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
  /** 내부 처리 구간(분). 이 값마다 새 부로 분할해 디코딩 가능 크기를 유지한다. 화면엔 하나의 연속 회의로 보인다. 0이면 분할 끄기(기본 30) */
  splitMinutes: number
  /** 전사 후처리 보정 사전. 전사 출력에 자동 적용해 반복되는 오전사를 교정한다. (기본 []) */
  corrections: Correction[]
}

const KEY = 'minuteflow.settings'

const DEFAULTS: AppSettings = {
  groqApiKey: '',
  geminiApiKey: '',
  whisperModel: 'onnx-community/whisper-large-v3-turbo',
  language: 'ko',
  autoPipeline: true,
  splitMinutes: 30,
  corrections: [],
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
