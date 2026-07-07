# MinuteFlow Plan 3 — 화자 분리 (브라우저 로컬) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의록 뷰에서 [화자 구분] 버튼 하나로, 저장된 오디오를 브라우저 안에서 화자 분리해 각 발언에 화자 배지(8색)를 붙이고 이름을 편집·내보내기까지 한다.

**Architecture:** `core/diarize/*` 신설 — 순수 함수 3개(윈도우 분할·클러스터링·화자 배정)와 Web Worker(모델 추론). 파이프라인: 10초 윈도우 pyannote 세그멘테이션 → 구간별 WeSpeaker 임베딩 → agglomerative 클러스터링 → 화자 타임라인 → WhisperX 방식으로 전사 세그먼트에 배정. 모델은 HF CDN 런타임 로드(Cache API 자동 캐시) — Pages 25MiB 한도 무관.

**Tech Stack:** 기존 + `@huggingface/transformers`(이미 설치, 4.2.0 핀). 신규 의존성 없음.

**참조**: 스펙 §13 (확정 경로), 리서치 원문은 세션 정찰 결과 (핵심 API는 이 플랜에 verbatim 반영됨)

## Global Constraints

- **세그멘테이션 모델**: `onnx-community/pyannote-segmentation-3.0`, dtype `'q8'`. **10초(160,000 샘플) 윈도우로 직접 슬라이딩** — 통짜 투입 금지
- **임베딩 모델**: `onnx-community/wespeaker-voxceleb-resnet34-LM`, dtype `'fp16'`. 출력 키 방어: `out.embeddings ?? out.embs ?? Object.values(out)[0]` 후 L2 정규화
- **클러스터링**: average-linkage cosine agglomerative, 유사도 임계 `0.75` 이상이면 병합(자동 화자 수). 신규 npm 의존성 금지 (순수 JS)
- **배정(WhisperX 이식)**: 전사 세그먼트별로 각 화자 구간과의 교집합 `min(dEnd,sEnd)-max(dStart,sStart)`을 **화자별 합산**, 최대 화자 배정. 교집합>0 없으면 **최근접**(화자 구간 midpoint와 세그먼트 midpoint 거리 최소)
- **임베딩 대상**: 0.4초 미만 구간은 제외
- **화자 라벨**: 첫 등장 시각 순으로 `'SPK1'`, `'SPK2'`, …
- 데이터: `TranscriptSegment.speaker?: string`, `Meeting.speakerNames?: Record<string,string>` — 비인덱스 필드라 Dexie 버전 범프 불필요
- UI 한국어, theme 클래스, 화자 색은 design-tokens.md의 SPEAKER_COLORS 8색, TDD, conventional commits
- 로직 배치: 순수 계산은 `core/diarize/`의 테스트 가능한 모듈로, 추론만 워커에

## File Structure

```
src/core/types.ts                    수정: speaker?/speakerNames? 필드
src/core/diarize/windows.ts          신규: 윈도우 분할 + 세그먼트 오프셋 (순수)
src/core/diarize/cluster.ts          신규: cosine agglomerative (순수)
src/core/diarize/assign.ts           신규: WhisperX 배정 (순수)
src/core/diarize/speakerColors.ts    신규: 8색 팔레트 + 라벨→색 매핑 (순수)
src/core/diarize/diarize.worker.ts   신규: 모델 추론 워커
src/core/diarize/diarizeLocal.ts     신규: 워커 클라이언트 (whisperLocal 패턴)
src/core/store/meetings.ts           수정: applySpeakers, updateSpeakerNames
src/core/export/exporters.ts         수정: 화자 표시
src/ui/pages/Meeting.tsx             수정: [화자 구분] 버튼 + 배지 + 이름 편집
(각 모듈 옆 *.test.ts[x])
```

---

### Task 1: 타입 확장 + 윈도우 분할 순수 함수

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/diarize/windows.ts`
- Test: `src/core/diarize/windows.test.ts`

**Interfaces:**
- `types.ts`: `TranscriptSegment`에 `speaker?: string` 추가, `Meeting`에 `speakerNames?: Record<string, string>` 추가
- `windows.ts`:
  - `WINDOW_SAMPLES = 160_000` (10초 @16kHz)
  - `sliceWindows(samples: Float32Array): { window: Float32Array; offsetSec: number }[]` — 마지막 잔여도 포함(빈 배열 입력이면 빈 결과)
  - `interface RawRegion { start: number; end: number }` (초 단위, 전역 시각)
  - `offsetRegions(regions: { start: number; end: number }[], offsetSec: number): RawRegion[]`
  - `filterEmbeddable(regions: RawRegion[], minSec?: number): RawRegion[]` — 기본 0.4초 미만 제외

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/diarize/windows.test.ts`:
```ts
import { sliceWindows, offsetRegions, filterEmbeddable, WINDOW_SAMPLES } from './windows'

test('10초 윈도우로 분할하고 잔여를 포함한다', () => {
  const samples = new Float32Array(WINDOW_SAMPLES * 2 + 16000) // 25초
  const ws = sliceWindows(samples)
  expect(ws.map(w => w.offsetSec)).toEqual([0, 10, 20])
  expect(ws[2].window.length).toBe(16000)
})

test('빈 입력은 빈 결과', () => {
  expect(sliceWindows(new Float32Array(0))).toEqual([])
})

test('offsetRegions는 전역 시각으로 이동한다', () => {
  expect(offsetRegions([{ start: 1.5, end: 3 }], 20)).toEqual([{ start: 21.5, end: 23 }])
})

test('filterEmbeddable은 0.4초 미만을 제외한다', () => {
  const out = filterEmbeddable([
    { start: 0, end: 0.3 }, { start: 1, end: 1.5 }, { start: 2, end: 2.39 },
  ])
  expect(out).toEqual([{ start: 1, end: 1.5 }])
})
```

- [ ] **Step 2: 실패 확인** — `npm test -- windows` → FAIL

- [ ] **Step 3: 구현**

`src/core/types.ts` 수정 (두 인터페이스에 필드 추가):
```ts
export interface Meeting {
  // ...기존 필드 유지
  speakerNames?: Record<string, string>
}
export interface TranscriptSegment {
  // ...기존 필드 유지
  speaker?: string
}
```

`src/core/diarize/windows.ts`:
```ts
export const WINDOW_SAMPLES = 160_000 // 10초 @16kHz — pyannote segmentation-3.0 설계 창
const SAMPLE_RATE = 16_000

export interface RawRegion { start: number; end: number }

export function sliceWindows(samples: Float32Array): { window: Float32Array; offsetSec: number }[] {
  const out: { window: Float32Array; offsetSec: number }[] = []
  for (let i = 0; i < samples.length; i += WINDOW_SAMPLES) {
    out.push({
      window: samples.subarray(i, Math.min(i + WINDOW_SAMPLES, samples.length)),
      offsetSec: i / SAMPLE_RATE,
    })
  }
  return out
}

export function offsetRegions(
  regions: { start: number; end: number }[], offsetSec: number,
): RawRegion[] {
  return regions.map(r => ({ start: r.start + offsetSec, end: r.end + offsetSec }))
}

export function filterEmbeddable(regions: RawRegion[], minSec = 0.4): RawRegion[] {
  return regions.filter(r => r.end - r.start >= minSec)
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- windows` → 4 passed
- [ ] **Step 5: Commit** — `git add src/core/types.ts src/core/diarize/ && git commit -m "feat: 화자분리 타입 및 윈도우 분할 유틸"`

---

### Task 2: 클러스터링 (순수 JS agglomerative)

**Files:**
- Create: `src/core/diarize/cluster.ts`
- Test: `src/core/diarize/cluster.test.ts`

**Interfaces:**
- `cosineSim(a: Float32Array | number[], b: Float32Array | number[]): number`
- `clusterEmbeddings(embeddings: Float32Array[], threshold?: number): number[]` — 기본 임계 0.75. 반환: 각 임베딩의 클러스터 인덱스(0부터). average-linkage: 두 클러스터 간 유사도 = 멤버 쌍 유사도 평균. 가장 유사한 쌍이 임계 이상인 동안 병합
- `labelClusters(clusterIdx: number[], regionStarts: number[]): string[]` — 클러스터를 첫 등장(해당 클러스터 최소 start) 순으로 'SPK1'…로 명명, 각 임베딩의 라벨 배열 반환

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/diarize/cluster.test.ts`:
```ts
import { cosineSim, clusterEmbeddings, labelClusters } from './cluster'

const A = new Float32Array([1, 0, 0])
const A2 = new Float32Array([0.98, 0.02, 0])
const B = new Float32Array([0, 1, 0])
const B2 = new Float32Array([0.05, 0.99, 0])

test('cosineSim 기본 성질', () => {
  expect(cosineSim(A, A)).toBeCloseTo(1, 5)
  expect(cosineSim(A, B)).toBeCloseTo(0, 5)
})

test('유사한 임베딩끼리 묶인다 (2화자)', () => {
  const idx = clusterEmbeddings([A, B, A2, B2], 0.75)
  expect(idx[0]).toBe(idx[2]) // A들
  expect(idx[1]).toBe(idx[3]) // B들
  expect(idx[0]).not.toBe(idx[1])
  expect(new Set(idx).size).toBe(2)
})

test('임계 1.0이면 아무것도 병합 안 됨', () => {
  const idx = clusterEmbeddings([A, B, A2], 1.0)
  expect(new Set(idx).size).toBe(3)
})

test('단일 임베딩', () => {
  expect(clusterEmbeddings([A])).toEqual([0])
})

test('labelClusters는 첫 등장 순으로 SPK 번호를 준다', () => {
  // 임베딩 0,1,2 / 클러스터 [1,0,1] / start [5, 0, 7] → 클러스터0 첫등장 0초=SPK1, 클러스터1 첫등장 5초=SPK2
  expect(labelClusters([1, 0, 1], [5, 0, 7])).toEqual(['SPK2', 'SPK1', 'SPK2'])
})
```

- [ ] **Step 2: 실패 확인** — `npm test -- cluster` → FAIL

- [ ] **Step 3: 구현**

`src/core/diarize/cluster.ts`:
```ts
export function cosineSim(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

// average-linkage agglomerative: 쌍별 유사도 평균이 threshold 이상인 동안 병합
export function clusterEmbeddings(embeddings: Float32Array[], threshold = 0.75): number[] {
  const n = embeddings.length
  if (n === 0) return []
  // 쌍별 유사도 사전 계산
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      sim[i][j] = sim[j][i] = cosineSim(embeddings[i], embeddings[j])

  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i])
  const avgSim = (a: number[], b: number[]) => {
    let s = 0
    for (const i of a) for (const j of b) s += sim[i][j]
    return s / (a.length * b.length)
  }

  for (;;) {
    let best = -Infinity, bi = -1, bj = -1
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const s = avgSim(clusters[i], clusters[j])
        if (s > best) { best = s; bi = i; bj = j }
      }
    if (bi < 0 || best < threshold) break
    clusters[bi] = clusters[bi].concat(clusters[bj])
    clusters.splice(bj, 1)
    if (clusters.length === 1) break
  }

  const out = new Array<number>(n).fill(0)
  clusters.forEach((members, c) => members.forEach(m => { out[m] = c }))
  return out
}

export function labelClusters(clusterIdx: number[], regionStarts: number[]): string[] {
  const firstSeen = new Map<number, number>()
  clusterIdx.forEach((c, i) => {
    const cur = firstSeen.get(c)
    if (cur === undefined || regionStarts[i] < cur) firstSeen.set(c, regionStarts[i])
  })
  const ordered = [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c)
  const nameOf = new Map(ordered.map((c, rank) => [c, `SPK${rank + 1}`]))
  return clusterIdx.map(c => nameOf.get(c)!)
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- cluster` → 5 passed
- [ ] **Step 5: Commit** — `git commit -m "feat: 화자 임베딩 클러스터링 (agglomerative cosine)"`

---

### Task 3: 화자 배정 (WhisperX 이식)

**Files:**
- Create: `src/core/diarize/assign.ts`
- Test: `src/core/diarize/assign.test.ts`

**Interfaces:**
- `interface SpeakerRegion { start: number; end: number; speaker: string }`
- `assignSpeakers<T extends { startSec: number; endSec: number }>(segments: T[], regions: SpeakerRegion[]): (T & { speaker?: string })[]` — 화자별 교집합 합산 최대 배정, 무교집합 시 최근접(midpoint), regions 비면 speaker 미부여

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/diarize/assign.test.ts`:
```ts
import { assignSpeakers, type SpeakerRegion } from './assign'

const regions: SpeakerRegion[] = [
  { start: 0, end: 5, speaker: 'SPK1' },
  { start: 5, end: 8, speaker: 'SPK2' },
  { start: 8, end: 10, speaker: 'SPK1' },
]

test('최대 교집합 화자를 배정한다', () => {
  const out = assignSpeakers([{ startSec: 1, endSec: 4 }], regions)
  expect(out[0].speaker).toBe('SPK1')
})

test('여러 구간과 겹치면 화자별 합산으로 결정한다', () => {
  // 4~9초: SPK1과 교집합 (4~5)+(8~9)=2, SPK2와 (5~8)=3 → SPK2
  const out = assignSpeakers([{ startSec: 4, endSec: 9 }], regions)
  expect(out[0].speaker).toBe('SPK2')
})

test('교집합이 없으면 최근접 화자', () => {
  // 20~22초: 모든 구간과 무교집합 → midpoint 21에 가장 가까운 구간은 8~10(mid 9, SPK1)
  const out = assignSpeakers([{ startSec: 20, endSec: 22 }], regions)
  expect(out[0].speaker).toBe('SPK1')
})

test('regions가 비면 speaker 미부여', () => {
  const out = assignSpeakers([{ startSec: 0, endSec: 1 }], [])
  expect(out[0].speaker).toBeUndefined()
})

test('원본 세그먼트 필드를 보존한다', () => {
  const out = assignSpeakers([{ startSec: 1, endSec: 2, text: '안녕' } as never], regions)
  expect((out[0] as { text: string }).text).toBe('안녕')
})
```

- [ ] **Step 2: 실패 확인** — `npm test -- assign` → FAIL

- [ ] **Step 3: 구현**

`src/core/diarize/assign.ts`:
```ts
export interface SpeakerRegion { start: number; end: number; speaker: string }

// WhisperX assign_word_speakers 이식: 화자별 교집합 합산 최대 → 배정, 무교집합 시 최근접
export function assignSpeakers<T extends { startSec: number; endSec: number }>(
  segments: T[], regions: SpeakerRegion[],
): (T & { speaker?: string })[] {
  return segments.map(seg => {
    if (regions.length === 0) return { ...seg }
    const bySpeaker = new Map<string, number>()
    for (const r of regions) {
      const inter = Math.min(r.end, seg.endSec) - Math.max(r.start, seg.startSec)
      if (inter > 0) bySpeaker.set(r.speaker, (bySpeaker.get(r.speaker) ?? 0) + inter)
    }
    if (bySpeaker.size > 0) {
      const speaker = [...bySpeaker.entries()].sort((a, b) => b[1] - a[1])[0][0]
      return { ...seg, speaker }
    }
    // 최근접: 세그먼트 midpoint와 구간 midpoint 거리 최소
    const mid = (seg.startSec + seg.endSec) / 2
    let best = regions[0], bestDist = Infinity
    for (const r of regions) {
      const d = Math.abs((r.start + r.end) / 2 - mid)
      if (d < bestDist) { bestDist = d; best = r }
    }
    return { ...seg, speaker: best.speaker }
  })
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- assign` → 5 passed
- [ ] **Step 5: Commit** — `git commit -m "feat: 전사-화자 배정 (WhisperX 로직 이식)"`

---

### Task 4: 화자 색 팔레트

**Files:**
- Create: `src/core/diarize/speakerColors.ts`
- Test: `src/core/diarize/speakerColors.test.ts`

**Interfaces:**
- `SPEAKER_COLORS: { fg: string; bg: string }[]` — design-tokens.md의 8색 verbatim
- `speakerColor(label: string): { fg: string; bg: string }` — 'SPK<n>'의 n-1을 8로 모듈러; 파싱 실패 시 0번

- [ ] **Step 1: 테스트**

```ts
import { SPEAKER_COLORS, speakerColor } from './speakerColors'

test('8색 팔레트', () => {
  expect(SPEAKER_COLORS).toHaveLength(8)
  expect(SPEAKER_COLORS[0]).toEqual({ fg: '#0E7490', bg: '#E5F3F6' })
})

test('라벨 → 색 (모듈러)', () => {
  expect(speakerColor('SPK1')).toEqual(SPEAKER_COLORS[0])
  expect(speakerColor('SPK9')).toEqual(SPEAKER_COLORS[0])
  expect(speakerColor('unknown')).toEqual(SPEAKER_COLORS[0])
})
```

- [ ] **Step 2-3: RED → 구현**

`src/core/diarize/speakerColors.ts`:
```ts
// docs/design/design-tokens.md 화자 팔레트 verbatim
export const SPEAKER_COLORS = [
  { fg: '#0E7490', bg: '#E5F3F6' }, { fg: '#7C3AED', bg: '#F1ECFC' },
  { fg: '#B45309', bg: '#FAF0E1' }, { fg: '#BE185D', bg: '#FAE8F0' },
  { fg: '#15803D', bg: '#E7F5EC' }, { fg: '#4F46E5', bg: '#EEF0FD' },
  { fg: '#0369A1', bg: '#E3F1FA' }, { fg: '#A21CAF', bg: '#F8EAFA' },
]

export function speakerColor(label: string): { fg: string; bg: string } {
  const n = Number(/^SPK(\d+)$/.exec(label)?.[1] ?? '1')
  return SPEAKER_COLORS[(Math.max(1, n) - 1) % SPEAKER_COLORS.length]
}
```

- [ ] **Step 4: GREEN → Commit** — `git commit -m "feat: 화자 색 팔레트"`

---

### Task 5: 디아라이즈 워커 + 클라이언트

**Files:**
- Create: `src/core/diarize/diarize.worker.ts`, `src/core/diarize/diarizeLocal.ts`
- Test: `src/core/diarize/diarizeLocal.test.ts`

**Interfaces:**
- 워커 in: `{ type: 'diarize', audio: Float32Array }` / out: `{ status: 'progress', file, progress }` | `{ status: 'info', message }` | `{ status: 'done', regions: SpeakerRegion[] }` | `{ status: 'error', message }`
- `diarizeLocal.ts`: `class DiarizeEngine { constructor(createWorker?); diarize(audio: Float32Array, onProgress?: (p: WhisperProgress) => void): Promise<SpeakerRegion[]>; dispose(): void }` — whisperLocal의 busy·activeReject 하드닝 패턴 동일 적용 (`WhisperProgress` 타입 재사용: `import type { WhisperProgress } from '../stt/whisperLocal'`)

**워커 파이프라인 (정찰 검증 API):**
```ts
import { AutoProcessor, AutoModelForAudioFrameClassification, AutoModel } from '@huggingface/transformers'
import { sliceWindows, offsetRegions, filterEmbeddable, type RawRegion } from './windows'
import { clusterEmbeddings, labelClusters } from './cluster'

const SEG_MODEL = 'onnx-community/pyannote-segmentation-3.0'
const EMB_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM'
const SAMPLE_RATE = 16_000

let segModel: unknown = null, segProc: unknown = null, embModel: unknown = null, embProc: unknown = null

self.onmessage = async (ev: MessageEvent<{ type: 'diarize'; audio: Float32Array }>) => {
  try {
    const { audio } = ev.data
    const progress = (x: { status: string; file?: string; progress?: number }) => {
      if (x.status === 'progress') self.postMessage({ status: 'progress', file: x.file ?? '', progress: x.progress ?? 0 })
    }
    if (!segModel) {
      self.postMessage({ status: 'info', message: '화자 분석 모델 준비 중…' })
      segModel = await AutoModelForAudioFrameClassification.from_pretrained(SEG_MODEL, { dtype: 'q8', progress_callback: progress })
      segProc = await AutoProcessor.from_pretrained(SEG_MODEL)
      embModel = await AutoModel.from_pretrained(EMB_MODEL, { dtype: 'fp16', progress_callback: progress })
      embProc = await AutoProcessor.from_pretrained(EMB_MODEL)
    }
    // 1) 10초 윈도우 세그멘테이션
    self.postMessage({ status: 'info', message: '발화 구간 분석 중…' })
    const windows = sliceWindows(audio)
    const regions: RawRegion[] = []
    for (let i = 0; i < windows.length; i++) {
      const { window, offsetSec } = windows[i]
      const inputs = await (segProc as (a: Float32Array) => Promise<never>)(window)
      const { logits } = await (segModel as (i: never) => Promise<{ logits: never }>)(inputs)
      const local = (segProc as { post_process_speaker_diarization(l: never, n: number): { start: number; end: number; id: number; confidence: number }[][] })
        .post_process_speaker_diarization(logits, window.length)[0]
      regions.push(...offsetRegions(local.filter(r => r.id !== 0), offsetSec))
      // id 0 = 무음(non-speech). post_process 출력이 화자 id별 구간 — 무음 클래스 제외
      if (i % 5 === 4) self.postMessage({ status: 'info', message: `발화 구간 분석 중… (${i + 1}/${windows.length})` })
    }
    // 2) 임베딩
    const targets = filterEmbeddable(regions)
    if (targets.length === 0) { self.postMessage({ status: 'done', regions: [] }); return }
    const embeddings: Float32Array[] = []
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i]
      const wave = audio.subarray(Math.floor(r.start * SAMPLE_RATE), Math.floor(r.end * SAMPLE_RATE))
      const inputs = await (embProc as (a: Float32Array) => Promise<never>)(wave)
      const out = await (embModel as (i: never) => Promise<Record<string, { data: Float32Array }>>)(inputs)
      const vec = (out.embeddings ?? out.embs ?? Object.values(out)[0]).data
      embeddings.push(new Float32Array(vec))
      if (i % 10 === 9) self.postMessage({ status: 'info', message: `화자 특징 추출 중… (${i + 1}/${targets.length})` })
    }
    // 3) 클러스터링 + 라벨
    self.postMessage({ status: 'info', message: '화자 묶는 중…' })
    const idx = clusterEmbeddings(embeddings)
    const labels = labelClusters(idx, targets.map(t => t.start))
    const result = targets.map((r, i) => ({ start: r.start, end: r.end, speaker: labels[i] }))
      .sort((a, b) => a.start - b.start)
    self.postMessage({ status: 'done', regions: result })
  } catch (e) {
    self.postMessage({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
```
(참고: `post_process_speaker_diarization` 반환 구조 `[{id,start,end,confidence}...]`는 배열의 배열(배치) — `[0]`으로 첫 배치. `id !== 0` 필터가 무음 제외인지 vs 별도 필드인지는 **구현 시 콘솔 1회 확인** 후 필요 시 조정 — 리포트에 기록할 것. 타입 캐스트는 transformers.js 유니온 타입 회피용 최소한으로)

**클라이언트** `diarizeLocal.ts`는 `whisperLocal.ts`의 구조(busy, activeReject, settle, dispose) 그대로, 메시지 타입만 diarize용.

**테스트** (`diarizeLocal.test.ts`): whisperLocal.test 패턴 — FakeWorker 주입, (1) diarize가 done regions resolve, (2) progress/info → onProgress 매핑, (3) error reject, (4) 동시 호출 즉시 reject, (5) dispose 시 in-flight '취소' reject. 5개.

- [ ] Step 1: 테스트 RED → Step 2: 구현 → Step 3: GREEN + `npm run build` (워커 번들 확인)
- [ ] Step 4: Commit — `feat: 브라우저 화자 분리 워커 및 엔진`

---

### Task 6: 스토어 — 화자 적용·이름 저장

**Files:**
- Modify: `src/core/store/meetings.ts`
- Test: `src/core/store/meetings.test.ts` (테스트 추가)

**Interfaces:**
- `applySpeakers(meetingId: string, regions: SpeakerRegion[]): Promise<void>` — 세그먼트 로드 → `assignSpeakers` → 각 세그먼트 `speaker` 필드 업데이트(트랜잭션, bulkPut)
- `updateSpeakerNames(meetingId: string, names: Record<string, string>): Promise<void>` — `meetings.update(id, { speakerNames: names })`

**테스트 2개:**
```ts
test('applySpeakers는 세그먼트에 화자를 기록한다', async () => {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 4, text: 'a', source: 'whisper', isFinal: true })
  await appendSegment({ meetingId: m.id, startSec: 5, endSec: 7, text: 'b', source: 'whisper', isFinal: true })
  await applySpeakers(m.id, [
    { start: 0, end: 4.5, speaker: 'SPK1' }, { start: 4.5, end: 8, speaker: 'SPK2' },
  ])
  const segs = await getSegments(m.id)
  expect(segs.map(s => s.speaker)).toEqual(['SPK1', 'SPK2'])
})

test('updateSpeakerNames는 회의에 이름 맵을 저장한다', async () => {
  const m = await createMeeting()
  await updateSpeakerNames(m.id, { SPK1: '김팀장' })
  expect((await getMeeting(m.id))?.speakerNames).toEqual({ SPK1: '김팀장' })
})
```

**구현** (meetings.ts에 추가):
```ts
import { assignSpeakers, type SpeakerRegion } from '../diarize/assign'

export async function applySpeakers(meetingId: string, regions: SpeakerRegion[]): Promise<void> {
  await db.transaction('rw', [db.transcriptSegments], async () => {
    const segs = await db.transcriptSegments.where('meetingId').equals(meetingId).toArray()
    const assigned = assignSpeakers(segs, regions)
    await db.transcriptSegments.bulkPut(assigned)
  })
}

export async function updateSpeakerNames(meetingId: string, names: Record<string, string>): Promise<void> {
  await db.meetings.update(meetingId, { speakerNames: names })
}
```

- [ ] Step 1-4: RED → 구현 → GREEN → Commit — `feat: 화자 배정 저장 및 이름 맵`

---

### Task 7: 내보내기에 화자 반영

**Files:**
- Modify: `src/core/export/exporters.ts`
- Test: `src/core/export/exporters.test.ts` (테스트 추가)

**규약:** 세그먼트에 `speaker`가 있으면 표시 이름(= `meeting.speakerNames?.[speaker] ?? speaker`)을 붙인다.
- md: `- **[MM:SS]** **김팀장** — 텍스트` (speaker 없으면 기존 형식)
- txt: `[MM:SS] 김팀장: 텍스트`
- 시그니처 변경: `toMarkdown(meeting, segments)` / `toPlainText(meeting, segments)` 그대로 — speakerNames는 meeting에서 읽음

**테스트 2개** (기존 파일에 추가):
```ts
test('화자가 있으면 이름과 함께 내보낸다', () => {
  const m2 = { ...meeting, speakerNames: { SPK1: '김팀장' } }
  const segs = [
    { meetingId: 'm1', startSec: 0, endSec: 5, text: '시작', source: 'whisper', isFinal: true, speaker: 'SPK1' },
    { meetingId: 'm1', startSec: 5, endSec: 9, text: '네', source: 'whisper', isFinal: true, speaker: 'SPK2' },
  ] as TranscriptSegment[]
  const md = toMarkdown(m2, segs)
  expect(md).toContain('**김팀장** — 시작')
  expect(md).toContain('**SPK2** — 네') // 이름 미지정은 라벨 그대로
  const txt = toPlainText(m2, segs)
  expect(txt).toContain('[00:00] 김팀장: 시작')
})

test('화자가 없으면 기존 형식 유지', () => {
  expect(toMarkdown(meeting, segments)).toContain('**[00:00]** 시작하겠습니다')
})
```

- [ ] Step 1-4: RED → 구현(displayName 헬퍼 + 두 포맷 조건 분기) → GREEN → Commit — `feat: 내보내기에 화자 표시`

---

### Task 8: Meeting UI — [화자 구분] 버튼·배지·이름 편집

**Files:**
- Modify: `src/ui/pages/Meeting.tsx`
- Test: `src/ui/pages/Meeting.test.tsx` (테스트 추가)

**동작 규약 (심플 원칙 유지):**
- 오디오 있고 세그먼트 있을 때 [화자 구분] `.btn-outline .btn-sm` 버튼 (재전사 옆). 진행 중 라벨이 상태 문구로 바뀌고 disabled
- 클릭 → `getMeetingAudio` → `decodeTo16kMono` → `DiarizeEngine.diarize` → `applySpeakers` → 세그먼트 재로드. 실패 시 alert + 상태 복원. 빈 regions면 alert('화자를 구분할 수 없었습니다') 후 기존 유지
- 세그먼트 렌더: `speaker` 있으면 타임스탬프 앞에 화자 배지 — `speakerColor(label)`의 bg/fg 인라인 스타일(동적 색이므로 허용), 표시 이름 = `meeting.speakerNames?.[label] ?? label`
- 배지 클릭 → `window.prompt('이 화자의 이름을 입력하세요', 현재이름)` → `updateSpeakerNames`(전체 맵 병합) + meeting 상태 갱신. 취소/빈 입력은 무시
- 재전사 시 speaker는 사라짐(세그먼트 교체) — 정상. 화자 구분을 다시 실행하면 됨

**테스트 3개** (vi.mock으로 DiarizeEngine·decodeTo16kMono 대체):
1. 화자 구분 실행 → 배지 텍스트 'SPK1'이 보이고 세그먼트에 speaker 저장됨
2. 배지 클릭 + prompt '김팀장' → 표시가 '김팀장'으로 바뀜 (prompt mock)
3. 오디오 없으면 [화자 구분] 버튼 없음

- [ ] Step 1-4: RED → 구현 → GREEN (기존 Meeting 테스트 7개 유지) → Commit — `feat: 회의록 화자 구분 UI — 배지·이름 편집`

---

### Task 9: 검증 + README

- [ ] `npm test` 전체, `npm run build`, `find dist -size +24M` (onnxruntime wasm 1개만 22.5MiB — 초과분 없음 확인)
- [ ] README 기능 목록에 화자 구분 추가, 로드맵에서 화자 분리 제거:
  - 기능: `- **화자 구분** — 브라우저 안에서 누가 말했는지 자동 분리 (음성이 밖으로 안 나감), 화자 이름 편집·색상 표시`
  - 로드맵: `AI 요약(Gemini BYOK)·PWA(Plan 4)`만 남김
- [ ] Commit — `docs: README 화자 구분 추가`

---

## Self-Review 결과 (작성자 체크)

1. **스펙 §13 커버리지**: 세그멘테이션 q8·슬라이딩(Task 1·5), WeSpeaker fp16·출력 방어(Task 5), 클러스터링 0.75(Task 2), WhisperX 병합+최근접(Task 3), speaker/speakerNames 비인덱스(Task 1·6), 8색 배지+이름 편집(Task 4·8), 내보내기 반영(Task 7), 겹침·한국어 정확도 고지는 README/추후 실측. 화자 수 수동 지정은 스펙대로 후순위(미구현).
2. **플레이스홀더**: 없음. Task 5 워커의 `post_process_speaker_diarization` 반환 세부(무음 클래스 처리)만 구현 시 콘솔 1회 확인 항목으로 명시 — 정찰에서 반환 형태 `[{id,start,end,confidence}]`는 확인됐으나 id 의미(무음 포함 여부)가 미확정이기 때문. 확인 결과를 리포트에 기록.
3. **타입 일관성**: `SpeakerRegion`(Task 3 정의 → 5·6 사용), `WhisperProgress` 재사용(5), `assignSpeakers` 제네릭이 TranscriptSegment에 적용(6), `speakerColor`(4→8). `sliceWindows`/`offsetRegions`/`filterEmbeddable`(1→5).
4. **리스크**: 실모델 추론은 jsdom 검증 불가(프로토콜 테스트만) — 배포 후 실측 필수. 1시간 오디오 = 360윈도우 × (세그+임베딩) 추론 시간 미지수 — 느리면 Plan 4에서 WebGPU dtype 조정·배치 최적화.
