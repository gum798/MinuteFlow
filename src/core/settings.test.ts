import { loadSettings, saveSettings } from './settings'

beforeEach(() => localStorage.clear())

test('저장된 값이 없으면 기본값', () => {
  expect(loadSettings()).toEqual({
    groqApiKey: '', whisperModel: 'onnx-community/whisper-large-v3-turbo', language: 'ko',
  })
})

test('부분 저장이 병합된다', () => {
  saveSettings({ groqApiKey: 'gsk_test' })
  saveSettings({ language: 'en' })
  expect(loadSettings()).toMatchObject({ groqApiKey: 'gsk_test', language: 'en' })
})

test('손상된 JSON이면 기본값으로 복구', () => {
  localStorage.setItem('minuteflow.settings', '{{{')
  expect(loadSettings().language).toBe('ko')
})
