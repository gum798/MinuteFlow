import { AutoProcessor, AutoModelForAudioFrameClassification, AutoModel } from '@huggingface/transformers'
import { sliceWindows, offsetRegions, filterEmbeddable, type RawRegion } from './windows'
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

self.onmessage = async (ev: MessageEvent<{ type: 'diarize'; audio: Float32Array }>) => {
  try {
    const { audio } = ev.data
    const progress = (x: ProgressEvent) => {
      if (x.status === 'progress') self.postMessage({ status: 'progress', file: x.file ?? '', progress: x.progress ?? 0 })
    }
    if (!models) {
      self.postMessage({ status: 'info', message: '화자 분석 모델 준비 중…' })
      const segModel = (await AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, { dtype: 'q8', progress_callback: progress })) as unknown as SegModel
      const segProc = (await AutoProcessor.from_pretrained(SEG_MODEL)) as unknown as SegProcessor
      const embModel = (await AutoModel.from_pretrained(EMB_MODEL, { dtype: 'fp16', progress_callback: progress })) as unknown as EmbModel
      const embProc = (await AutoProcessor.from_pretrained(EMB_MODEL)) as unknown as EmbProcessor
      models = { segModel, segProc, embModel, embProc }
    }
    const { segModel, segProc, embModel, embProc } = models

    // 1) 10초 윈도우 세그멘테이션
    self.postMessage({ status: 'info', message: '발화 구간 분석 중…' })
    const windows = sliceWindows(audio)
    const regions: RawRegion[] = []
    for (let i = 0; i < windows.length; i++) {
      const { window, offsetSec } = windows[i]
      const inputs = await segProc(window)
      const { logits } = await segModel(inputs)
      const local = segProc.post_process_speaker_diarization(logits, window.length)[0]
      // id 0 = 무음(non-speech) 클래스로 추정 — 화자 id별 구간 출력에서 무음 제외.
      // TODO(실측): post_process_speaker_diarization 출력의 id 의미(무음 클래스 포함 여부)는
      //   jsdom에서 검증 불가. 브라우저 콘솔로 1회 확인 후 필요 시 필터 조건 조정.
      regions.push(...offsetRegions(local.filter(r => r.id !== 0), offsetSec))
      if (i % 5 === 4) self.postMessage({ status: 'info', message: `발화 구간 분석 중… (${i + 1}/${windows.length})` })
    }

    // 2) 화자 임베딩
    const targets = filterEmbeddable(regions)
    if (targets.length === 0) { self.postMessage({ status: 'done', regions: [] }); return }
    const embeddings: Float32Array[] = []
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i]
      const wave = audio.subarray(Math.floor(r.start * SAMPLE_RATE), Math.floor(r.end * SAMPLE_RATE))
      const inputs = await embProc(wave)
      const out = await embModel(inputs)
      // TODO(실측): WeSpeaker 실모델의 출력 키를 브라우저 콘솔에서 1회 확인 (embeddings/embs/기타)
      const vec = (out.embeddings ?? out.embs ?? Object.values(out)[0]).data
      embeddings.push(new Float32Array(vec))
      if (i % 10 === 9) self.postMessage({ status: 'info', message: `화자 특징 추출 중… (${i + 1}/${targets.length})` })
    }

    // 3) 클러스터링 + 라벨
    self.postMessage({ status: 'info', message: '화자 묶는 중…' })
    const idx = clusterEmbeddings(embeddings)
    const labels = labelClusters(idx, targets.map(t => t.start))
    const result: SpeakerRegion[] = targets
      .map((r, i) => ({ start: r.start, end: r.end, speaker: labels[i] }))
      .sort((a, b) => a.start - b.start)
    self.postMessage({ status: 'done', regions: result })
  } catch (e) {
    self.postMessage({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
