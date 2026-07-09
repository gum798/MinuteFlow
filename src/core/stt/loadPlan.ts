// 모델 로딩 호환 사다리(compatibility ladder).
// 특정 GPU/실행기 조합에서 fp16 인코더 세션 생성이 실패하는 문제(ERROR_CODE:1, tensor(float16)
// 타입 불일치)에 대응해, 실패 시 점진적으로 더 안전한 조합으로 내려가는 순서를 만든다.
// 순수 함수 — 워커/파이프라인 의존 없이 유닛 테스트 대상.

export interface LoadStep {
  model: string
  device: 'webgpu' | 'wasm'
  dtype: unknown
}

const BASE_MODEL = 'onnx-community/whisper-base'

// (model, device, dtype) 조합이 동일한 스텝은 앞의 것만 남기고 제거한다.
// dtype이 객체일 수 있어 전체 스텝을 직렬화해 유니크 판별.
function dedupe(steps: LoadStep[]): LoadStep[] {
  const seen = new Set<string>()
  const out: LoadStep[] = []
  for (const s of steps) {
    const key = JSON.stringify([s.model, s.device, s.dtype])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

// webgpu: fp16 인코더 → q4 인코더 → base 모델 WASM q8 (최후의 안전망)
// wasm:   요청 모델 q8 → base 모델 q8
// 요청 모델이 이미 base면 중복 스텝을 제거해 유니크한 사다리를 반환.
export function buildWhisperLoadPlan(model: string, device: 'webgpu' | 'wasm'): LoadStep[] {
  const steps: LoadStep[] =
    device === 'webgpu'
      ? [
          { model, device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } },
          { model, device: 'webgpu', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } },
          { model: BASE_MODEL, device: 'wasm', dtype: 'q8' },
        ]
      : [
          { model, device: 'wasm', dtype: 'q8' },
          { model: BASE_MODEL, device: 'wasm', dtype: 'q8' },
        ]
  return dedupe(steps)
}

// WeSpeaker 임베딩 모델: int8 → fp32 순으로 내려간다.
// fp16은 wasm에서 fp16 Cast가 불가해 세션 생성이 실패하므로(실측) 제거하고,
// wasm에서 검증된 int8을 1순위로, 최후 안전망으로 fp32를 둔다.
export function buildEmbeddingLoadPlan(): { dtype: string }[] {
  return [{ dtype: 'int8' }, { dtype: 'fp32' }]
}
