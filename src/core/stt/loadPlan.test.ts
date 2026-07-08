import { buildWhisperLoadPlan, buildEmbeddingLoadPlan } from './loadPlan'

const BASE = 'onnx-community/whisper-base'

test('webgpu 사다리: fp16 인코더 → q4 인코더 → base WASM q8', () => {
  const plan = buildWhisperLoadPlan('onnx-community/whisper-large-v3-turbo', 'webgpu')
  expect(plan).toEqual([
    { model: 'onnx-community/whisper-large-v3-turbo', device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } },
    { model: 'onnx-community/whisper-large-v3-turbo', device: 'webgpu', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } },
    { model: BASE, device: 'wasm', dtype: 'q8' },
  ])
})

test('wasm 사다리: 요청 모델 q8 → base q8', () => {
  const plan = buildWhisperLoadPlan('onnx-community/whisper-small', 'wasm')
  expect(plan).toEqual([
    { model: 'onnx-community/whisper-small', device: 'wasm', dtype: 'q8' },
    { model: BASE, device: 'wasm', dtype: 'q8' },
  ])
})

test('요청 모델이 base면 중복 WASM 스텝을 제거해 유니크한 사다리', () => {
  expect(buildWhisperLoadPlan(BASE, 'wasm')).toEqual([
    { model: BASE, device: 'wasm', dtype: 'q8' },
  ])
  // webgpu에서 base면 두 webgpu 스텝은 유지되고 마지막 WASM 안전망도 유지된다(모두 유니크).
  expect(buildWhisperLoadPlan(BASE, 'webgpu')).toEqual([
    { model: BASE, device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } },
    { model: BASE, device: 'webgpu', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } },
    { model: BASE, device: 'wasm', dtype: 'q8' },
  ])
})

test('임베딩 사다리: fp16 → q8', () => {
  expect(buildEmbeddingLoadPlan()).toEqual([{ dtype: 'fp16' }, { dtype: 'q8' }])
})
