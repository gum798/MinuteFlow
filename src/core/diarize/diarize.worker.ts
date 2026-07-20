import { AutoProcessor, AutoModelForAudioFrameClassification, AutoModel } from '@huggingface/transformers'
import { buildEmbeddingLoadPlan } from '../stt/loadPlan'
import { sliceWindows, offsetRegions, filterEmbeddable, clampRegions, type RawRegion } from './windows'
import { clusterEmbeddings, labelClusters } from './cluster'
import type { SpeakerRegion } from './assign'

const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0'
const EMB_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM'
const SAMPLE_RATE = 16_000

type ProgressEvent = { status: string; file?: string; progress?: number }
type DiarSegment = { start: number; end: number; id: number; confidence: number }

// transformers.js의 from_pretrained는 모든 모델의 유니온 타입을 반환해 strict TS에서 직접 호출 불가.
// diarize 파이프라인이 실제로 쓰는 호출 시그니처만 최소 캐스트로 명시한다.
type SegProcessor = ((audio: Float32Array) => Promise<unknown>) & {
  post_process_speaker_diarization(logits: unknown, numSamples: number): DiarSegment[][]
}
type SegModel = (inputs: unknown) => Promise<{ logits: unknown }>
type EmbProcessor = (audio: Float32Array) => Promise<unknown>
type EmbModel = (inputs: unknown) => Promise<Record<string, { data: Float32Array }>>

let models: { segModel: SegModel; segProc: SegProcessor; embModel: EmbModel; embProc: EmbProcessor } | null = null

async function ensureModels(progress: (x: ProgressEvent) => void) {
  if (models) return models
  self.postMessage({ status: 'info', message: '화자 분석 모델 준비 중…' })
  const segModel = (await AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, { dtype: 'q8', progress_callback: progress })) as unknown as SegModel
  const segProc = (await AutoProcessor.from_pretrained(SEG_MODEL)) as unknown as SegProcessor
  const embPlan = buildEmbeddingLoadPlan()
  let embModel: EmbModel | null = null
  let lastEmbError: unknown = null
  for (let i = 0; i < embPlan.length; i++) {
    try {
      embModel = (await AutoModel.from_pretrained(EMB_MODEL, {
        dtype: embPlan[i].dtype, progress_callback: progress,
      } as unknown as Parameters<typeof AutoModel.from_pretrained>[1])) as unknown as EmbModel
      break
    } catch (e) {
      lastEmbError = e
      if (i < embPlan.length - 1) self.postMessage({ status: 'info', message: '호환 모드로 재시도 중…' })
    }
  }
  if (!embModel) throw lastEmbError instanceof Error ? lastEmbError : new Error(String(lastEmbError))
  const embProc = (await AutoProcessor.from_pretrained(EMB_MODEL)) as unknown as EmbProcessor
  models = { segModel, segProc, embModel, embProc }
  return models
}

// 세그멘테이션 + 임베딩만 — 클러스터링 없음. targets(발화 구간)와 그 임베딩을 반환.
async function extractRegionsAndEmbeddings(audio: Float32Array, progress: (x: ProgressEvent) => void):
  Promise<{ targets: { start: number; end: number }[]; embeddings: Float32Array[] }> {
  const { segModel, segProc, embModel, embProc } = await ensureModels(progress)
  self.postMessage({ status: 'info', message: '발화 구간 분석 중…' })
  const windows = sliceWindows(audio)
  const regions: RawRegion[] = []
  for (let i = 0; i < windows.length; i++) {
    const { window, offsetSec } = windows[i]
    const inputs = await segProc(window)
    const { logits } = await segModel(inputs)
    const local = segProc.post_process_speaker_diarization(logits, window.length)[0]
    regions.push(...offsetRegions(local.filter(r => r.id !== 0), offsetSec))
    if (i % 5 === 4) self.postMessage({ status: 'info', message: `발화 구간 분석 중… (${i + 1}/${windows.length})` })
  }
  // 마지막 창의 0 패딩 구간에 걸친 구간을 실제 길이로 잘라낸다(임베딩 파형 슬라이스가 빈 배열이 되지 않게).
  const targets = filterEmbeddable(clampRegions(regions, audio.length / SAMPLE_RATE))
  const embeddings: Float32Array[] = []
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i]
    const wave = audio.subarray(Math.floor(r.start * SAMPLE_RATE), Math.floor(r.end * SAMPLE_RATE))
    const inputs = await embProc(wave)
    const out = await embModel(inputs)
    const vec = (out.embeddings ?? out.embs ?? Object.values(out)[0]).data
    embeddings.push(new Float32Array(vec))
    if (i % 10 === 9) self.postMessage({ status: 'info', message: `화자 특징 추출 중… (${i + 1}/${targets.length})` })
  }
  return { targets: targets.map(t => ({ start: t.start, end: t.end })), embeddings }
}

self.onmessage = async (ev: MessageEvent<{ type: 'diarize' | 'extract'; audio: Float32Array; numSpeakers?: number }>) => {
  try {
    const { type, audio, numSpeakers } = ev.data
    const progress = (x: ProgressEvent) => {
      if (x.status === 'progress') self.postMessage({ status: 'progress', file: x.file ?? '', progress: x.progress ?? 0 })
    }
    const { targets, embeddings } = await extractRegionsAndEmbeddings(audio, progress)
    if (type === 'extract') {
      self.postMessage({ status: 'extracted', targets, embeddings })
      return
    }
    // type === 'diarize' — 단일 회의 전체 파이프라인(기존 동작)
    if (targets.length === 0) { self.postMessage({ status: 'done', regions: [] }); return }
    self.postMessage({ status: 'info', message: '화자 묶는 중…' })
    const idx = clusterEmbeddings(embeddings, { numSpeakers, durations: targets.map(t => t.end - t.start) })
    const labels = labelClusters(idx, targets.map(t => t.start))
    const result: SpeakerRegion[] = targets
      .map((r, i) => ({ start: r.start, end: r.end, speaker: labels[i] }))
      .sort((a, b) => a.start - b.start)
    self.postMessage({ status: 'done', regions: result })
  } catch (e) {
    self.postMessage({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
