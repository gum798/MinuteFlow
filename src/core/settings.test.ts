import { loadSettings, saveSettings } from './settings'

beforeEach(() => localStorage.clear())

test('저장된 값이 없으면 기본값', () => {
  expect(loadSettings()).toEqual({
    groqApiKey: '', whisperModel: 'onnx-community/whisper-large-v3-turbo', language: 'ko',
    geminiApiKey: '', autoPipeline: true, splitMinutes: 60, corrections: [],
  })
})

test('corrections 기본값은 []이고 저장·복원된다', () => {
  expect(loadSettings().corrections).toEqual([])
  saveSettings({ corrections: [{ from: '머신런닝', to: '머신러닝' }] })
  expect(loadSettings().corrections).toEqual([{ from: '머신런닝', to: '머신러닝' }])
})

test('splitMinutes 기본값은 60이고 0(끄기)으로 저장된다', () => {
  expect(loadSettings().splitMinutes).toBe(60)
  saveSettings({ splitMinutes: 0 })
  expect(loadSettings().splitMinutes).toBe(0)
})

test('autoPipeline 기본값은 true이고 끄면 저장된다', () => {
  expect(loadSettings().autoPipeline).toBe(true)
  saveSettings({ autoPipeline: false })
  expect(loadSettings().autoPipeline).toBe(false)
})

test('geminiApiKey 기본값과 저장', () => {
  expect(loadSettings().geminiApiKey).toBe('')
  saveSettings({ geminiApiKey: 'AIza_test' })
  expect(loadSettings().geminiApiKey).toBe('AIza_test')
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
