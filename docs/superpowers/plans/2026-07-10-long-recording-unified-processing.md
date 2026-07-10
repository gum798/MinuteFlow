# 긴 녹음 통합 처리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 길이와 무관하게 재전사·화자 구분·요약이 동작하도록, 녹음-시점 분할(기본 30분)을 화면엔 하나의 연속 회의로 통합 처리하고 부 경계를 넘어 전역 화자 라벨을 부여한다.

**Architecture:** 기존 "그룹(부들의 묶음)" 모델을 재사용한다. 처리 시 **한 번에 한 부만 디코딩**하고, Whisper·화자 엔진은 **부 전체에 1회만 로드**한다. 화자 구분은 부별로 임베딩만 추출한 뒤 **전 부의 임베딩을 모아 한 번에 클러스터링**해 전역 라벨을 만든다. 단일 회의 경로(diarizeMeeting/retranscribeMeeting)는 그대로 두고 그룹 경로(diarizeGroup/retranscribeGroup)를 추가한다.

**Tech Stack:** React 19 + TypeScript(strict) + Vite + Dexie(IndexedDB) + Web Worker + @huggingface/transformers 3.8.1 + vitest.

## Global Constraints

- transformers.js는 **정확히 `3.8.1`** 유지(업그레이드 금지).
- 화자 클러스터링/라벨링/assign은 **기존 순수 모듈 재사용**: `clusterEmbeddings(embeddings, threshold=0.75)`, `labelClusters(clusterIdx, regionStarts)`, `assignSpeakers(segments, regions)`, `SpeakerRegion = { start:number; end:number; speaker:string }`. 새로 구현하지 말 것.
- 처리 중 **한 번에 한 부만** 디코딩(끝나면 참조 해제) — 총 길이 무관 메모리 상한 유지.
- Whisper·화자 엔진은 그룹 처리에서 **1회만 로드**(부 수만큼 재로딩 금지).
- 진행 상태(runJob)와 `minuteflow:pipeline-done` 이벤트의 meetingId는 **마지막 부 id**(`partIds[partIds.length-1]`)에 싣는다(기존 `summarizeGroup`·pipeline과 일관).
- 내부 구간 기본값 **30분**(`splitMinutes` 기본 30). `0`이면 분할 끄기(긴 녹음은 요약만).
- 디버그 로그는 **기본 켜짐**, `localStorage['mf-debug']==='0'`일 때만 끔. 프리픽스 `[MF:<scope>]`, `console.debug` 사용.
- 한 부 디코딩/전사/추출 실패는 **그 부만 건너뛰고** 나머지 부는 계속(부분 결과 보존).
- 기존 단일 회의 경로(diarizeMeeting/retranscribeMeeting)와 그 테스트는 **동작 불변**.
- 커밋 메시지 말미: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_016d6we1tezveWyYJTRMbc3g`.

---

## File Structure

- `src/core/debug.ts` (신규) — `dlog(scope, ...args)` + `dtimer(scope, label)` + 플래그. 순수·의존성 없음.
- `src/core/diarize/diarize.worker.ts` (수정) — `extractRegionsAndEmbeddings(audio)` 헬퍼로 리팩터; `'extract'` 메시지 추가(클러스터링 없이 `{targets, embeddings}` 반환). 기존 `'diarize'`는 그대로 동작.
- `src/core/diarize/diarizeLocal.ts` (수정) — `DiarizeEngine.extract(audio)` 추가(worker `'extract'` 왕복). 기존 `diarize()` 불변.
- `src/core/diarize/globalSpeakers.ts` (신규) — 순수 함수 `globalSpeakerRegions(parts)` : 부별 targets+embeddings를 받아 전역 클러스터링 후 **부별 SpeakerRegion[]** 반환. 크럭스 로직, 단위 테스트.
- `src/core/meetingActions.ts` (수정) — `diarizeGroup(partIds)`, `retranscribeGroup(partIds)` 추가; 재전사 부별 코어를 `transcribeOnePart(...)` 헬퍼로 추출해 단일/그룹이 공유.
- `src/core/pipeline.ts` (수정) — `runFinalPipeline`이 그룹 전체를 `retranscribeGroup → diarizeGroup → summarize`로 처리.
- `src/ui/pages/Meeting.tsx` (수정) — 그룹 모든 부 세그먼트를 누적 offset으로 이어 하나의 연속 전사로 렌더; 부 탭 제거; 그룹 job 표시; 이름 변경·병합 그룹 전체 적용.
- `src/core/settings.ts` (수정) — `splitMinutes` 기본 60→30 + 주석 갱신.
- 각 파일의 `*.test.ts(x)` — 아래 태스크별 명시.

---

## Task 1: 디버그 로거 (`core/debug.ts`)

**Files:**
- Create: `src/core/debug.ts`
- Test: `src/core/debug.test.ts`

**Interfaces:**
- Produces:
  - `dlog(scope: string, ...args: unknown[]): void` — `mf-debug`가 꺼져있지 않으면 `console.debug('[MF:'+scope+']', ...args)`.
  - `isDebugEnabled(): boolean` — `localStorage['mf-debug'] !== '0'` (기본 true, 접근 실패 시 false).
  - `dtimer(scope: string, label: string): () => void` — 호출 시점을 기록하고, 반환된 함수를 호출하면 `dlog(scope, label+' ('+ms+'ms)')`를 남긴다. 시간 계산은 `performance.now()`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/debug.test.ts
import { dlog, isDebugEnabled, dtimer } from './debug'

beforeEach(() => localStorage.clear())

test('mf-debug=0이면 로그를 찍지 않는다', () => {
  localStorage.setItem('mf-debug', '0')
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  dlog('test', 'hello')
  expect(spy).not.toHaveBeenCalled()
  expect(isDebugEnabled()).toBe(false)
  spy.mockRestore()
})

test('기본(플래그 없음)은 켜져 있고 [MF:scope] 프리픽스로 찍는다', () => {
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  dlog('decode', 'x', 1)
  expect(isDebugEnabled()).toBe(true)
  expect(spy).toHaveBeenCalledWith('[MF:decode]', 'x', 1)
  spy.mockRestore()
})

test('dtimer는 종료 시 경과(ms)를 포함해 로그한다', () => {
  const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  const end = dtimer('diarize', '클러스터링')
  end()
  expect(spy).toHaveBeenCalledTimes(1)
  const [prefix, msg] = spy.mock.calls[0]
  expect(prefix).toBe('[MF:diarize]')
  expect(String(msg)).toMatch(/클러스터링 \(\d+(\.\d+)?ms\)/)
  spy.mockRestore()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/debug.test.ts`
Expected: FAIL (`./debug`에서 import 실패 — 파일 없음).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/debug.ts
// 개발자용 디버그 로거. 기본 켜짐 — localStorage['mf-debug']='0'으로 끈다.
// 긴 녹음 처리(디코딩·전사·화자)의 단계·소요시간을 콘솔에서 추적하기 위한 최소 도구.

export function isDebugEnabled(): boolean {
  try {
    return localStorage.getItem('mf-debug') !== '0'
  } catch {
    return false
  }
}

export function dlog(scope: string, ...args: unknown[]): void {
  if (!isDebugEnabled()) return
  console.debug(`[MF:${scope}]`, ...args)
}

/** 시작~end() 사이 경과(ms)를 dlog로 남기는 타이머. */
export function dtimer(scope: string, label: string): () => void {
  const started = performance.now()
  return () => dlog(scope, `${label} (${Math.round((performance.now() - started) * 10) / 10}ms)`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/debug.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/debug.ts src/core/debug.test.ts
git commit -m "feat: 디버그 로거(dlog/dtimer) — mf-debug 플래그, [MF:scope] 프리픽스"
```

---

## Task 2: 화자 워커 `extract` 모드 + `DiarizeEngine.extract()`

**Files:**
- Modify: `src/core/diarize/diarize.worker.ts`
- Modify: `src/core/diarize/diarizeLocal.ts`
- Test: `src/core/diarize/diarizeLocal.test.ts` (기존 파일에 extract 테스트 추가)

**Interfaces:**
- Consumes: `sliceWindows`, `offsetRegions`, `filterEmbeddable`(from `./windows`), `clusterEmbeddings`, `labelClusters`(from `./cluster`), `SpeakerRegion`(from `./assign`).
- Produces:
  - Worker 메시지 `{ type: 'extract'; audio: Float32Array }` → `{ status: 'extracted'; targets: {start:number;end:number}[]; embeddings: Float32Array[] }` (또는 `status:'error'`).
  - `DiarizeEngine.extract(audio: Float32Array, onProgress?): Promise<{ targets: {start:number;end:number}[]; embeddings: Float32Array[] }>`.
  - 기존 `DiarizeEngine.diarize(audio)` 시그니처·동작 불변.

**배경(구현자 필독):** 현재 워커의 `self.onmessage`는 `{type:'diarize', audio}`만 처리하며 내부에서 (1)세그멘테이션 (2)임베딩 (3)클러스터링을 순차 수행해 `SpeakerRegion[]`을 반환한다. 이 태스크는 (1)+(2)를 `extractRegionsAndEmbeddings(audio)` 헬퍼로 뽑아, `'diarize'`는 그 헬퍼 + (3)클러스터링으로 재구성하고, `'extract'`는 그 헬퍼 결과(`{targets, embeddings}`)만 반환한다. 동작(단일 diarize 결과)은 불변.

- [ ] **Step 1: Write the failing test** (extract 왕복을 가짜 워커로 검증)

`diarizeLocal.test.ts`에 추가. 기존 파일 상단의 가짜 워커 패턴을 따른다(없으면 아래처럼 작성):

```ts
// src/core/diarize/diarizeLocal.test.ts 에 추가
import { DiarizeEngine } from './diarizeLocal'

// 워커를 가짜로: 'extract' 메시지에 고정 targets/embeddings로 응답
class FakeExtractWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  postMessage(msg: { type: string }) {
    if (msg.type === 'extract') {
      queueMicrotask(() => this.onmessage?.({ data: {
        status: 'extracted',
        targets: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
        embeddings: [new Float32Array([1, 0]), new Float32Array([0, 1])],
      } } as MessageEvent))
    }
  }
  terminate() {}
}

test('DiarizeEngine.extract는 워커의 targets/embeddings를 그대로 돌려준다', async () => {
  const eng = new DiarizeEngine(() => new FakeExtractWorker() as unknown as Worker)
  const out = await eng.extract(new Float32Array(16000))
  expect(out.targets).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }])
  expect(out.embeddings).toHaveLength(2)
  expect(Array.from(out.embeddings[0])).toEqual([1, 0])
  eng.dispose()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/diarize/diarizeLocal.test.ts`
Expected: FAIL (`eng.extract` is not a function).

- [ ] **Step 3a: Refactor the worker** (`diarize.worker.ts`)

`self.onmessage` 내부의 세그멘테이션+임베딩 블록을 헬퍼로 추출하고, 메시지 타입 분기를 추가한다. 모델 로딩 블록(`if (!models) {...}`)은 헬퍼 안으로 옮긴다. 최종 형태:

```ts
// (import·상수·타입·models 캐시는 기존 유지)

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
  const targets = filterEmbeddable(regions)
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

self.onmessage = async (ev: MessageEvent<{ type: 'diarize' | 'extract'; audio: Float32Array }>) => {
  try {
    const { type, audio } = ev.data
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
```

- [ ] **Step 3b: Add `extract()` to `DiarizeEngine`** (`diarizeLocal.ts`)

기존 `diarize()`와 대칭으로 `extract()`를 추가한다. `WorkerOut` 유니온에 `extracted` 케이스를 더한다:

```ts
type WorkerOut =
  | { status: 'progress'; file: string; progress: number }
  | { status: 'info'; message: string }
  | { status: 'done'; regions: SpeakerRegion[] }
  | { status: 'extracted'; targets: { start: number; end: number }[]; embeddings: Float32Array[] }
  | { status: 'error'; message: string }
```

클래스에 메서드 추가(기존 `diarize`와 같은 busy/worker/settle 패턴):

```ts
  extract(
    audio: Float32Array,
    onProgress?: (p: WhisperProgress) => void,
  ): Promise<{ targets: { start: number; end: number }[]; embeddings: Float32Array[] }> {
    if (this.busy) return Promise.reject(new Error('이미 화자 분석이 진행 중입니다.'))
    this.busy = true
    this.worker ??= this.createWorker()
    const worker = this.worker
    return new Promise((resolve, reject) => {
      this.activeReject = reject
      const settle = () => { this.busy = false; this.activeReject = null; worker.onmessage = null }
      worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
        const msg = ev.data
        if (msg.status === 'progress') onProgress?.({ kind: 'download', file: msg.file, progress: msg.progress })
        else if (msg.status === 'info') onProgress?.({ kind: 'status', message: msg.message })
        else if (msg.status === 'extracted') { settle(); resolve({ targets: msg.targets, embeddings: msg.embeddings }) }
        else if (msg.status === 'error') { settle(); reject(new Error(msg.message)) }
      }
      worker.postMessage({ type: 'extract', audio })
    })
  }
```

기존 `diarize()`의 `worker.postMessage({ type: 'diarize', audio })`는 그대로(현재는 `{ audio }`만 보낼 수 있으니 `{ type: 'diarize', audio }`로 맞춘다).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/diarize/diarizeLocal.test.ts`
Expected: PASS (기존 + 새 extract 테스트).
Run: `npx tsc --noEmit`
Expected: 오류 없음.

- [ ] **Step 5: Commit**

```bash
git add src/core/diarize/diarize.worker.ts src/core/diarize/diarizeLocal.ts src/core/diarize/diarizeLocal.test.ts
git commit -m "feat: 화자 워커 extract 모드 + DiarizeEngine.extract — 클러스터링 분리(그룹 전역 화자 준비)"
```

---

## Task 3: 전역 화자 순수 함수 + `diarizeGroup(partIds)`

**Files:**
- Create: `src/core/diarize/globalSpeakers.ts`
- Test: `src/core/diarize/globalSpeakers.test.ts`
- Modify: `src/core/meetingActions.ts` (add `diarizeGroup`)
- Test: `src/core/meetingActions.test.ts` (add diarizeGroup 통합 테스트)

**Interfaces:**
- Consumes: `clusterEmbeddings`, `labelClusters` (`./cluster`), `SpeakerRegion` (`./assign`), `DiarizeEngine.extract` (Task 2), `applySpeakers`(store), `decodeMeetingAudioWithRepair`(meetingActions 내부), `getMeeting`, `getMeetingAudio`, `runJob`, `isTooLongToProcess`.
- Produces:
  - `globalSpeakerRegions(parts: { targets: {start:number;end:number}[]; embeddings: Float32Array[]; offsetSec: number }[]): SpeakerRegion[][]` — 각 부의 부-상대 `SpeakerRegion[]`, 라벨은 전역 일관.
  - `diarizeGroup(partIds: string[]): Promise<'done' | 'empty' | 'no-audio' | 'too-long'>`.

### 3a. 순수 함수 `globalSpeakerRegions`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/diarize/globalSpeakers.test.ts
import { globalSpeakerRegions } from './globalSpeakers'

test('부 경계를 넘어 같은 화자는 같은 라벨을 받는다', () => {
  // 부0: 화자A(0..1), 화자B(1..2). 부1: 화자A(0..1) — 임베딩이 부0 화자A와 동일.
  const A = new Float32Array([1, 0]); const B = new Float32Array([0, 1])
  const parts = [
    { targets: [{ start: 0, end: 1 }, { start: 1, end: 2 }], embeddings: [A, B], offsetSec: 0 },
    { targets: [{ start: 0, end: 1 }], embeddings: [new Float32Array([1, 0])], offsetSec: 100 },
  ]
  const out = globalSpeakerRegions(parts)
  expect(out).toHaveLength(2)
  // 부-상대 시각 보존
  expect(out[0].map(r => [r.start, r.end])).toEqual([[0, 1], [1, 2]])
  expect(out[1].map(r => [r.start, r.end])).toEqual([[0, 1]])
  // 전역 라벨: 부0 첫 화자 = SPK1, 부0 둘째 화자 = SPK2, 부1 화자 = 부0 첫 화자와 동일 → SPK1
  expect(out[0][0].speaker).toBe('SPK1')
  expect(out[0][1].speaker).toBe('SPK2')
  expect(out[1][0].speaker).toBe('SPK1')
})

test('임베딩이 하나도 없으면 각 부 빈 배열', () => {
  const out = globalSpeakerRegions([{ targets: [], embeddings: [], offsetSec: 0 }])
  expect(out).toEqual([[]])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/diarize/globalSpeakers.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: Implement**

```ts
// src/core/diarize/globalSpeakers.ts
// 여러 부(part)의 발화 구간·임베딩을 모아 전역으로 클러스터링해 부 경계를 넘어 일관된 화자 라벨을 부여한다.
// 라벨 순서(SPK1..)는 전체 회의에서 처음 등장한 화자 기준(부 offset을 더한 전역 시각으로 정렬).
// 반환은 각 부의 '부-상대' SpeakerRegion[] — 그대로 assignSpeakers(부, regions)에 넣을 수 있다.
import { clusterEmbeddings, labelClusters } from './cluster'
import type { SpeakerRegion } from './assign'

export interface PartExtract {
  targets: { start: number; end: number }[]
  embeddings: Float32Array[]
  offsetSec: number
}

export function globalSpeakerRegions(parts: PartExtract[]): SpeakerRegion[][] {
  const allEmb: Float32Array[] = []
  const globalStarts: number[] = []
  for (const p of parts) {
    for (let i = 0; i < p.embeddings.length; i++) {
      allEmb.push(p.embeddings[i])
      globalStarts.push(p.targets[i].start + p.offsetSec)
    }
  }
  if (allEmb.length === 0) return parts.map(() => [])
  const idx = clusterEmbeddings(allEmb)
  const labels = labelClusters(idx, globalStarts) // 전역 시각 기준 SPK 라벨
  // 라벨을 다시 부별로 분배(추출 순서와 동일)하고, 부-상대 시각으로 SpeakerRegion을 만든다.
  const out: SpeakerRegion[][] = []
  let k = 0
  for (const p of parts) {
    const regions = p.targets.map((t, i) => ({ start: t.start, end: t.end, speaker: labels[k + i] }))
      .sort((a, b) => a.start - b.start)
    out.push(regions)
    k += p.targets.length
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/diarize/globalSpeakers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/diarize/globalSpeakers.ts src/core/diarize/globalSpeakers.test.ts
git commit -m "feat: globalSpeakerRegions — 부 임베딩 전역 클러스터링으로 부 경계 넘는 일관 화자 라벨"
```

### 3b. `diarizeGroup(partIds)` in `meetingActions.ts`

구현자 참고 — 기존 `diarizeMeeting`(약 158행)의 decode/엔진/`applySpeakers` 패턴을 따른다. `decodeMeetingAudioWithRepair`는 `meetingActions.ts` 내부 함수(파일 상단), `applySpeakers`는 store에서 import 됨(이미 있음). `dlog`/`dtimer`를 `../debug`… 아니라 `./debug`에서 import.

- [ ] **Step 6: Write the failing test** (`meetingActions.test.ts`에 추가)

기존 파일은 이미 `./audio/decode`, `./diarize/diarizeLocal`, `./stt/whisperLocal`, `./summarize/gemini`를 목으로 대체한다. `DiarizeEngine` 목을 `extract`도 갖도록 확장하고, 두 부의 세그먼트를 심어 그룹 화자 구분을 검증한다. 기존 `vi.mock('./diarize/diarizeLocal', ...)`를 다음으로 교체:

```ts
// meetingActions.test.ts 상단 목 교체
let extractCalls = 0
vi.mock('./diarize/diarizeLocal', () => ({
  DiarizeEngine: class {
    diarize() { return [] }
    extract() {
      // 부0: 2발화(서로 다른 화자), 부1: 1발화(부0 첫 화자와 동일 임베딩)
      extractCalls++
      if (extractCalls === 1) return Promise.resolve({
        targets: [{ start: 0, end: 4 }, { start: 5, end: 9 }],
        embeddings: [new Float32Array([1, 0]), new Float32Array([0, 1])],
      })
      return Promise.resolve({
        targets: [{ start: 0, end: 4 }],
        embeddings: [new Float32Array([1, 0])],
      })
    }
    dispose() {}
  },
}))
```

그리고 `beforeEach`에 `extractCalls = 0` 추가. 테스트:

```ts
import { diarizeGroup } from './meetingActions'

test('diarizeGroup: 부 경계를 넘어 같은 화자에 같은 라벨을 부여한다', async () => {
  const m1 = await createMeeting()
  const m2 = await createMeeting()
  // 각 부에 발화 세그먼트 심기(부-상대 시각) + 오디오
  await appendSegment({ meetingId: m1.id, startSec: 0, endSec: 4, text: '첫 부 발언 A', source: 'whisper', isFinal: true })
  await appendSegment({ meetingId: m1.id, startSec: 5, endSec: 9, text: '첫 부 발언 B', source: 'whisper', isFinal: true })
  await appendSegment({ meetingId: m2.id, startSec: 0, endSec: 4, text: '둘째 부 발언 A', source: 'whisper', isFinal: true })
  await appendAudioChunk(m1.id, 0, new Blob(['a']), 'audio/webm')
  await appendAudioChunk(m2.id, 0, new Blob(['a']), 'audio/webm')
  await finishMeeting(m1.id, 60)
  await finishMeeting(m2.id, 60)

  const result = await diarizeGroup([m1.id, m2.id])
  expect(result).toBe('done')

  const s1 = await getSegments(m1.id)
  const s2 = await getSegments(m2.id)
  // 부0 첫 발화 = SPK1, 부0 둘째 = SPK2, 부1 발화(= 부0 첫 화자) = SPK1
  expect(s1.find(s => s.startSec === 0)?.speaker).toBe('SPK1')
  expect(s1.find(s => s.startSec === 5)?.speaker).toBe('SPK2')
  expect(s2.find(s => s.startSec === 0)?.speaker).toBe('SPK1')
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/core/meetingActions.test.ts`
Expected: FAIL (`diarizeGroup` 미정의).

- [ ] **Step 8: Implement `diarizeGroup`** (add to `meetingActions.ts`)

`import { DiarizeEngine }` 는 이미 있음. 추가 import: `import { globalSpeakerRegions } from './diarize/globalSpeakers'`, `import { dlog, dtimer } from './debug'`. 함수:

```ts
/**
 * 그룹(여러 부) 통합 화자 구분. 각 부에서 임베딩만 추출하고, 전 부의 임베딩을 모아
 * 한 번에 클러스터링해 부 경계를 넘어 일관된 화자 라벨을 각 부 세그먼트에 부여한다.
 * 엔진은 1회만 로드. 한 부 디코딩/추출 실패는 그 부만 건너뛴다.
 * 반환: 'done' | 'empty'(임베딩 없음) | 'no-audio'(오디오 있는 부가 없음).
 */
export async function diarizeGroup(partIds: string[]): Promise<'done' | 'empty' | 'no-audio'> {
  const lastId = partIds[partIds.length - 1]
  let result: 'done' | 'empty' | 'no-audio' = 'no-audio'
  await runJob(lastId, 'diarize', async setStatus => {
    const engine = new DiarizeEngine()
    try {
      const parts: { partId: string; targets: { start: number; end: number }[]; embeddings: Float32Array[]; offsetSec: number }[] = []
      let offsetSec = 0
      let anyAudio = false
      for (let i = 0; i < partIds.length; i++) {
        const id = partIds[i]
        const meeting = await getMeeting(id)
        const partDur = meeting?.durationSec ?? 0
        setStatus(`화자 구분 중… (${i + 1}/${partIds.length})`)
        const blob = await getMeetingAudio(id)
        if (!blob) { offsetSec += partDur; continue }
        anyAudio = true
        try {
          const endDecode = dtimer('diarizeGroup', `부 ${i + 1} 디코딩`)
          const samples = await decodeMeetingAudioWithRepair(id, blob)
          endDecode()
          dlog('diarizeGroup', `부 ${i + 1}/${partIds.length} 디코딩 완료`, { sec: (samples.length / 16000).toFixed(1), mb: (samples.length * 4 / 1048576).toFixed(1) })
          const { targets, embeddings } = await engine.extract(samples, p => { if (p.kind === 'status') setStatus(p.message) })
          dlog('diarizeGroup', `부 ${i + 1} 발화 ${targets.length}개, 임베딩 ${embeddings.length}개`)
          parts.push({ partId: id, targets, embeddings, offsetSec })
        } catch (e) {
          dlog('diarizeGroup', `부 ${i + 1} 건너뜀(실패)`, e instanceof Error ? e.message : e)
        }
        offsetSec += partDur
      }
      if (!anyAudio) { result = 'no-audio'; return }
      const total = parts.reduce((n, p) => n + p.embeddings.length, 0)
      if (total === 0) { result = 'empty'; return }
      setStatus('화자 묶는 중…')
      const endCluster = dtimer('diarizeGroup', '전역 클러스터링')
      const perPartRegions = globalSpeakerRegions(parts.map(p => ({ targets: p.targets, embeddings: p.embeddings, offsetSec: p.offsetSec })))
      endCluster()
      const speakerCount = new Set(perPartRegions.flat().map(r => r.speaker)).size
      dlog('diarizeGroup', `전역 화자 ${speakerCount}명 (임베딩 ${total}개)`)
      for (let i = 0; i < parts.length; i++) {
        await applySpeakers(parts[i].partId, perPartRegions[i])
      }
      result = 'done'
    } finally {
      engine.dispose()
    }
  })
  return result
}
```

- [ ] **Step 9: Run tests**

Run: `npx vitest run src/core/meetingActions.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: 오류 없음.

- [ ] **Step 10: Commit**

```bash
git add src/core/meetingActions.ts src/core/meetingActions.test.ts
git commit -m "feat: diarizeGroup — 부별 임베딩 추출 후 전역 클러스터링(엔진 1회 로드, 부 실패 격리)"
```

---

## Task 4: `retranscribeGroup(partIds)` (엔진 1회 로드)

**Files:**
- Modify: `src/core/meetingActions.ts` (재전사 코어를 `transcribeOnePart` 헬퍼로 추출 + `retranscribeGroup` 추가)
- Test: `src/core/meetingActions.test.ts`

**Interfaces:**
- Produces: `retranscribeGroup(partIds: string[]): Promise<'done' | 'empty' | 'no-audio'>` — 각 부를 순차 재전사(엔진 1회), 한 부 실패는 격리.

**배경:** 현재 `retranscribeMeeting`(약 108행)은 내부에서 `WhisperLocalEngine`을 만들고 디코딩·전사·후처리·`replaceSegments`·`updateSpeakerNames({})`를 수행한 뒤 dispose한다. 이 태스크는 **엔진과 부 id를 받아 한 부를 재전사하는 코어**를 뽑아 그룹에서 엔진을 공유한다. Groq 경로(`GROQ_ENABLED && settings.groqApiKey`)는 기존대로 유지하되, 그룹에서도 같은 코어를 쓴다.

- [ ] **Step 1: Write the failing test** (`meetingActions.test.ts`)

```ts
import { retranscribeGroup } from './meetingActions'

test('retranscribeGroup: 모든 부를 재전사하고 각 부 세그먼트를 교체한다', async () => {
  const m1 = await createMeeting(); const m2 = await createMeeting()
  await appendAudioChunk(m1.id, 0, new Blob(['a']), 'audio/webm')
  await appendAudioChunk(m2.id, 0, new Blob(['a']), 'audio/webm')
  await finishMeeting(m1.id, 60); await finishMeeting(m2.id, 60)
  transcribeMock.mockResolvedValue([{ startSec: 0, endSec: 1, text: '재전사된 발언입니다' }])

  const result = await retranscribeGroup([m1.id, m2.id])
  expect(result).toBe('done')
  expect((await getSegments(m1.id)).map(s => s.text)).toEqual(['재전사된 발언입니다'])
  expect((await getSegments(m2.id)).map(s => s.text)).toEqual(['재전사된 발언입니다'])
})

test('retranscribeGroup: 오디오 없는 부는 건너뛰고 나머지는 재전사한다', async () => {
  const m1 = await createMeeting(); const m2 = await createMeeting()
  await appendAudioChunk(m2.id, 0, new Blob(['a']), 'audio/webm') // m1엔 오디오 없음
  await finishMeeting(m1.id, 60); await finishMeeting(m2.id, 60)
  transcribeMock.mockResolvedValue([{ startSec: 0, endSec: 1, text: '둘째 부 재전사' }])
  const result = await retranscribeGroup([m1.id, m2.id])
  expect(result).toBe('done')
  expect((await getSegments(m2.id)).map(s => s.text)).toEqual(['둘째 부 재전사'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/meetingActions.test.ts`
Expected: FAIL (`retranscribeGroup` 미정의).

- [ ] **Step 3: Refactor `retranscribeMeeting` to share `transcribeOnePart`**

`retranscribeMeeting`의 runJob 콜백 본문(엔진 생성 이후 부분)을 다음 헬퍼로 추출한다. 헬퍼는 **엔진을 받아** 한 부를 처리하고 결과를 반환한다. `WhisperLocalEngine`을 만들지 않는다(호출부가 소유). import에 `dlog, dtimer` 추가.

```ts
/**
 * 한 부를 주어진 Whisper 엔진으로 재전사해 세그먼트를 교체한다(엔진 소유는 호출부).
 * 오디오 없으면 'no-audio', 결과가 무의미하면 'empty'(기존 유지), 그 외 'done'.
 */
async function transcribeOnePart(
  engine: WhisperLocalEngine, meetingId: string, settings: ReturnType<typeof loadSettings>,
  webgpu: boolean, setStatus: (s: string) => void,
): Promise<'done' | 'empty' | 'no-audio'> {
  const blob = await getMeetingAudio(meetingId)
  if (!blob) return 'no-audio'
  const endDecode = dtimer('retranscribe', '디코딩')
  const samples = await decodeMeetingAudioWithRepair(meetingId, blob)
  endDecode()
  dlog('retranscribe', `디코딩 완료`, { sec: (samples.length / 16000).toFixed(1), mb: (samples.length * 4 / 1048576).toFixed(1) })
  let segs
  let source: 'whisper' | 'groq'
  if (GROQ_ENABLED && settings.groqApiKey) {
    source = 'groq'
    setStatus('Groq로 전사 중…')
    segs = await transcribeSamplesWithGroq(samples, {
      apiKey: settings.groqApiKey, language: settings.language,
      onPart: (d, t) => setStatus(`Groq 분할 전사 중 (${d}/${t})`),
    })
  } else {
    source = 'whisper'
    setStatus('브라우저 Whisper로 전사 중… (모델 다운로드가 필요할 수 있어요)')
    segs = await engine.transcribe(samples, {
      model: webgpu ? settings.whisperModel : 'onnx-community/whisper-base',
      device: webgpu ? 'webgpu' : 'wasm',
      language: settings.language,
    }, p => { if (p.kind === 'status') setStatus(p.message) })
  }
  const collapsed = segs.map(s => ({ ...s, text: collapseRepeatedPhrases(s.text) }))
  const meaningful = dropHallucinatedRepeats(collapsed.filter(s => isMeaningfulText(s.text)))
  dlog('retranscribe', `세그먼트 ${meaningful.length}개(원본 ${segs.length})`)
  if (meaningful.length === 0) return 'empty'
  await replaceSegments(meetingId, meaningful.map(s => ({
    ...s, text: applyCorrections(s.text, settings.corrections), source, isFinal: true,
  })))
  await updateSpeakerNames(meetingId, {})
  return 'done'
}
```

그리고 `retranscribeMeeting`을 이 헬퍼로 재구성(엔진 1개 생성/파기, 동작 불변):

```ts
export async function retranscribeMeeting(meetingId: string): Promise<'done' | 'empty' | 'no-audio' | 'too-long'> {
  const meeting = await getMeeting(meetingId)
  if (meeting && isTooLongToProcess(meeting.durationSec)) return 'too-long'
  const settings = loadSettings()
  let result: 'done' | 'empty' | 'no-audio' = 'no-audio'
  await runJob(meetingId, 'retranscribe', async setStatus => {
    setStatus('오디오 준비 중…')
    const webgpu = (GROQ_ENABLED && settings.groqApiKey) ? false : await detectWebGPU()
    const eng = new WhisperLocalEngine()
    try {
      result = await transcribeOnePart(eng, meetingId, settings, webgpu, setStatus)
    } finally { eng.dispose() }
  })
  return result
}
```

- [ ] **Step 4: Implement `retranscribeGroup`**

```ts
/**
 * 그룹(여러 부) 통합 재전사. Whisper 엔진 1개로 각 부를 순차 재전사한다(부마다 모델 재로딩 방지).
 * 한 부 디코딩/전사 실패는 그 부만 건너뛴다. 반환: 오디오 있는 부가 하나도 없으면 'no-audio',
 * 하나라도 재전사에 성공하면 'done', 오디오는 있었으나 전부 무의미/실패면 'empty'.
 */
export async function retranscribeGroup(partIds: string[]): Promise<'done' | 'empty' | 'no-audio'> {
  const lastId = partIds[partIds.length - 1]
  const settings = loadSettings()
  let anyAudio = false
  let anyDone = false
  await runJob(lastId, 'retranscribe', async setStatus => {
    setStatus('오디오 준비 중…')
    const webgpu = (GROQ_ENABLED && settings.groqApiKey) ? false : await detectWebGPU()
    const eng = new WhisperLocalEngine()
    try {
      for (let i = 0; i < partIds.length; i++) {
        setStatus(`재전사 중… (${i + 1}/${partIds.length})`)
        try {
          const r = await transcribeOnePart(eng, partIds[i], settings, webgpu, setStatus)
          if (r !== 'no-audio') anyAudio = true
          if (r === 'done') anyDone = true
        } catch (e) {
          anyAudio = true
          dlog('retranscribeGroup', `부 ${i + 1} 건너뜀(실패)`, e instanceof Error ? e.message : e)
        }
      }
    } finally { eng.dispose() }
  })
  return anyDone ? 'done' : anyAudio ? 'empty' : 'no-audio'
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/core/meetingActions.test.ts`
Expected: PASS (기존 retranscribeMeeting 테스트 + 새 group 테스트).
Run: `npx tsc --noEmit`
Expected: 오류 없음.

- [ ] **Step 6: Commit**

```bash
git add src/core/meetingActions.ts src/core/meetingActions.test.ts
git commit -m "feat: retranscribeGroup — Whisper 엔진 1회 로드로 전 부 순차 재전사(부 실패 격리)"
```

---

## Task 5: 자동 정리 파이프라인 그룹화 (`pipeline.ts`)

**Files:**
- Modify: `src/core/pipeline.ts`
- Test: `src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `retranscribeGroup`, `diarizeGroup`, `summarizeMeeting`, `summarizeGroup` (`./meetingActions`), `dlog` (`./debug`).
- 변경: `runFinalPipeline(partIds, template)`이 **그룹 전체**를 처리 — `retranscribeGroup(partIds) → diarizeGroup(partIds) → summarize`. `runPartPipeline`(녹음 중 부별)은 불변.

**배경:** 현재 `runFinalPipeline`은 마지막 부만 `runPartPipeline(lastId)`로 후처리한 뒤 요약한다. 이제 **모든 부**를 통합 재전사·화자 구분한다. `runPartPipeline`(녹음 중 완성된 부 백그라운드 후처리)은 그대로 둔다. too-long 처리: `retranscribeGroup`엔 too-long이 없다(부는 30분이라 상한 미만). 단, **단일 부(파트 없는 기존 긴 회의)**는 `retranscribeMeeting` too-long 가드가 필요하므로, `partIds.length === 1`이면 기존 `runPartPipeline`(too-long 반환) 경로를 유지한다.

- [ ] **Step 1: Update the tests** (`pipeline.test.ts`)

`vi.mock('./meetingActions', ...)`에 `retranscribeGroup`, `diarizeGroup` 목 추가:

```ts
const retranscribeGroupMock = vi.fn(async (_ids: string[]) => 'done')
const diarizeGroupMock = vi.fn(async (_ids: string[]) => 'done')
vi.mock('./meetingActions', () => ({
  retranscribeMeeting: (id: string) => retranscribeMock(id),
  diarizeMeeting: (id: string) => diarizeMock(id),
  retranscribeGroup: (ids: string[]) => retranscribeGroupMock(ids),
  diarizeGroup: (ids: string[]) => diarizeGroupMock(ids),
  summarizeMeeting: (id: string, t: string) => summarizeMock(id, t),
  summarizeGroup: (ids: string[], t: string) => summarizeGroupMock(ids, t),
}))
```

`beforeEach`에 리셋 추가: `retranscribeGroupMock.mockReset().mockResolvedValue('done')`, `diarizeGroupMock.mockReset().mockResolvedValue('done')`.

기존 "여러 부면 마지막 부 후처리 후 summarizeGroup" 테스트를 그룹 처리로 갱신:

```ts
test('여러 부면 전 부를 통합 재전사·화자 구분 후 summarizeGroup을 호출한다', async () => {
  await runFinalPipeline(['m1', 'm2', 'm3'])
  expect(retranscribeGroupMock).toHaveBeenCalledWith(['m1', 'm2', 'm3'])
  expect(diarizeGroupMock).toHaveBeenCalledWith(['m1', 'm2', 'm3'])
  expect(summarizeGroupMock).toHaveBeenCalledWith(['m1', 'm2', 'm3'], 'minutes')
  expect(summarizeMock).not.toHaveBeenCalled()
})

test('단일 부는 기존 per-part 후처리(too-long 가드 유지) 후 summarizeMeeting', async () => {
  await runFinalPipeline(['m1'])
  expect(retranscribeMock).toHaveBeenCalledWith('m1')   // per-part
  expect(retranscribeGroupMock).not.toHaveBeenCalled()
  expect(summarizeMock).toHaveBeenCalledWith('m1', 'minutes')
})
```

기존 화자구분-실패-에도-요약 테스트들은 단일 부(`['m1']`) 기준이므로 그대로 통과(단일 경로 불변). 그룹 too-long 안내 테스트(`retranscribe too-long`)도 단일 부 기준이라 유지.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/pipeline.test.ts`
Expected: FAIL (그룹이 아직 retranscribeGroup을 호출하지 않음).

- [ ] **Step 3: Implement group processing in `runFinalPipeline`**

`import`에 추가: `retranscribeGroup, diarizeGroup` (from `./meetingActions`), `dlog` (from `./debug`). `runFinalPipeline` 본문에서 `runPartPipeline(lastId)` 호출부를 분기로 교체:

```ts
export async function runFinalPipeline(partIds: string[], template: SummaryTemplate = 'minutes'): Promise<void> {
  if (partIds.length === 0) return
  const lastId = partIds[partIds.length - 1]
  let skipped = false
  if (partIds.length > 1) {
    // 그룹: 전 부를 통합 재전사·화자 구분(엔진 1회 로드, 한 번에 한 부 디코딩).
    dlog('pipeline', `그룹 통합 처리 시작 (${partIds.length}부)`)
    try { await retranscribeGroup(partIds) } catch (e) { dlog('pipeline', '그룹 재전사 실패', e) }
    try { await diarizeGroup(partIds) } catch (e) { dlog('pipeline', '그룹 화자 구분 실패', e) }
  } else {
    // 단일 부: 기존 경로(too-long 가드 포함).
    skipped = await runPartPipeline(lastId)
  }
  let outcome: 'done' | 'no-key' | 'no-segments' | 'no-content' | 'error' = 'error'
  try {
    outcome = partIds.length > 1
      ? await summarizeGroup(partIds, template)
      : await summarizeMeeting(lastId, template)
  } catch {
    outcome = 'error'
  }
  dlog('pipeline', `완료 outcome=${outcome} skipped=${skipped}`)
  // (이하 skip 안내 메시지 구성 + pipeline-done dispatch 는 기존 코드 그대로 유지)
  ...
}
```

`skipped`는 단일 부 too-long일 때만 true가 되며(그룹은 false), 기존 메시지 분기(`skipNote`)를 그대로 사용한다.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/pipeline.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: 오류 없음.

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "feat: 자동 정리 그룹화 — 여러 부는 retranscribeGroup+diarizeGroup 통합 처리"
```

---

## Task 6: 통합 전사 뷰 + 그룹 이름/병합 (`Meeting.tsx`)

**Files:**
- Modify: `src/ui/pages/Meeting.tsx`
- Test: `src/ui/pages/Meeting.test.tsx`

**Interfaces:**
- Consumes: `getMeetingGroup`, `getSegments`, `updateSpeakerNames`, `replaceSegments`, `groupConsecutiveBySpeaker`, `speakerColor`, `canonicalSpeakerLabel`, `relabelSpeaker`.
- 변경 요지:
  1. 그룹의 **모든 부** 세그먼트를 누적 offset으로 이어 하나의 연속 리스트로 렌더.
  2. **부 탭(group.map 버튼) 제거.**
  3. job 탐지를 그룹 전체로: `const job = jobs.find(j => group.some(p => p.id === j.meetingId)) ?? null`.
  4. 이름 변경/병합을 **그룹 전체 부**에 적용.

**배경:** 현재 `Meeting.tsx`는 `segments`(현재 부만)와 `group`(전 부)을 state로 갖는다. `useEffect`에서 `setSegments((await getSegments(id)).filter(s => s.isFinal))`로 **현재 부만** 로드한다. 이를 **그룹 전 부**를 로드해 누적 offset을 붙인 통합 세그먼트로 바꾼다.

핵심 데이터 구조 — 통합 세그먼트는 표시용으로 부-offset이 적용된 복사본:

```ts
// 부 오름차순으로 각 부의 확정 세그먼트를 로드해 누적 durationSec offset을 startSec/endSec에 더한다.
// 반환 세그먼트는 표시·복사용 — DB 저장은 각 부의 원본(부-상대)로 이뤄진다.
async function loadUnifiedSegments(parts: Meeting[]): Promise<TranscriptSegment[]> {
  const out: TranscriptSegment[] = []
  let offset = 0
  for (const p of parts) {
    const segs = (await getSegments(p.id)).filter(s => s.isFinal)
    for (const s of segs) out.push({ ...s, startSec: s.startSec + offset, endSec: s.endSec + offset })
    offset += p.durationSec
  }
  return out
}
```

- [ ] **Step 1: Write the failing test** (`Meeting.test.tsx`)

두 부 그룹을 만들어 통합 전사가 **한 화면**에 이어 보이고, 부 탭이 없음을 검증:

```ts
import { markGroupFirstPart } from '../../core/store/meetings'

test('그룹 회의는 모든 부의 전사가 하나의 연속 화면에 이어 보이고 부 탭이 없다', async () => {
  const g = await createMeeting()
  const p2 = await createMeeting()
  await markGroupFirstPart(g.id, g.id, g.title, ' (1부)')
  // p2를 같은 그룹의 2부로
  await db.meetings.update(p2.id, { groupId: g.id, partIndex: 2 })
  await appendSegment({ meetingId: g.id, startSec: 0, endSec: 5, text: '첫 부 발언', source: 'whisper', isFinal: true })
  await appendSegment({ meetingId: p2.id, startSec: 0, endSec: 5, text: '둘째 부 발언', source: 'whisper', isFinal: true })
  await finishMeeting(g.id, 3600)
  await finishMeeting(p2.id, 60)
  renderPage(g.id)
  await waitFor(() => expect(screen.getByText('첫 부 발언')).toBeInTheDocument())
  // 두 부가 한 화면에 함께 보인다
  expect(screen.getByText('둘째 부 발언')).toBeInTheDocument()
  // '2부' 같은 부 탭 버튼이 없다
  expect(screen.queryByRole('button', { name: /^\d+부$/ })).not.toBeInTheDocument()
  // 둘째 부 세그먼트는 누적 offset(3600s=1:00:00) 이후 시각으로 표시된다
  expect(screen.getByText(/1:00:00/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/pages/Meeting.test.tsx`
Expected: FAIL(둘째 부 발언이 안 보이거나 부 탭이 존재).

- [ ] **Step 3: Implement unified load + remove 부 tabs**

`Meeting.tsx`의 로딩 `useEffect`에서 `setSegments`를 통합 로드로 교체하고, `group` 로드 후 통합 세그먼트를 만든다:

```ts
// 로딩 useEffect 내부: group을 먼저 구한 뒤 통합 세그먼트를 만든다.
const g = await getMeetingGroup(m)
setGroup(g)
setSegments(await loadUnifiedSegments(g))
```

job-done 리스너의 재로딩도 통합 로드로 교체:

```ts
// onDone 내부
const m2 = await getMeeting(id)
if (m2) {
  const g = await getMeetingGroup(m2)
  setGroup(g)
  setSegments(await loadUnifiedSegments(g))
  setSummaries(await getSummaries(id))
  setMeeting(m2); setTitle(m2.title)
}
```

부 탭 블록(`{group.length > 1 && (<div ...>{group.map(p => <button ...>{p.partIndex}부</button>)}</div>)}`)을 **삭제**한다. "통합 요약은 마지막 부에 있어요" 안내 블록도 삭제(통합 뷰이므로 무의미).

job 탐지 교체:

```ts
const job = jobs.find(j => group.some(p => p.id === j.meetingId)) ?? null
```

- [ ] **Step 4: Group-wide 이름 변경/병합**

`applyRename`, `mergeSpeakerInto`, `correctSelected`가 **모든 부**에 적용되도록 `meeting.id` 단일 대신 `group`을 순회한다. `applyRename`:

```ts
async function applyRename(name: string) {
  if (!meeting || !renamingSpeaker) return
  const value = name.trim()
  if (!value) { closeRename(); return }
  const names = { ...meeting.speakerNames, [renamingSpeaker]: value }
  setMeeting({ ...meeting, speakerNames: names })
  // 전역 라벨이므로 그룹 모든 부의 이름맵을 동일하게 갱신
  for (const p of group) await updateSpeakerNames(p.id, { ...p.speakerNames, [renamingSpeaker]: value })
  closeRename()
}
```

`mergeSpeakerInto`: 대상 라벨 계산은 `meeting.speakerNames` 기준으로 하되, **모든 부**의 세그먼트를 relabel하고 이름맵을 갱신:

```ts
async function mergeSpeakerInto(name: string) {
  if (!meeting || !renamingSpeaker) return
  const from = renamingSpeaker
  const target = canonicalSpeakerLabel(meeting.speakerNames ?? {}, name, from)
  if (!target) { await applyRename(name); return }
  for (const p of group) {
    const cur = await getSegments(p.id)
    await replaceSegments(p.id, relabelSpeaker(cur, from, target))
    const names = { ...(p.speakerNames ?? {}) }
    delete names[from]; names[target] = name.trim()
    await updateSpeakerNames(p.id, names)
  }
  const gm = await getMeeting(meeting.id)
  const g = gm ? await getMeetingGroup(gm) : group
  setGroup(g)
  setSegments(await loadUnifiedSegments(g))
  if (gm) setMeeting(gm)
  closeRename()
}
```

`correctSelected`도 그룹 전 부에 보정 적용(각 부 getSegments→applyCorrections→replaceSegments), 이후 `setSegments(await loadUnifiedSegments(g))`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/ui/pages/Meeting.test.tsx`
Expected: PASS(신규 통합 뷰 테스트 + 기존 병합/이름 테스트 — 기존 단일 회의 테스트는 group.length===1이라 동작 불변).
Run: `npx tsc --noEmit`
Expected: 오류 없음.

- [ ] **Step 6: Commit**

```bash
git add src/ui/pages/Meeting.tsx src/ui/pages/Meeting.test.tsx
git commit -m "feat: 통합 전사 뷰 — 그룹 전 부를 누적 offset으로 이어 렌더, 부 탭 제거, 이름/병합 그룹 전체 적용"
```

---

## Task 7: 내부 구간 기본 30분

**Files:**
- Modify: `src/core/settings.ts`
- Test: `src/core/settings.test.ts` (있으면; 없으면 아래 최소 테스트 파일 생성)

**Interfaces:**
- 변경: `DEFAULTS.splitMinutes` 60 → 30. 주석을 "내부 처리 구간(분). 이 값마다 새 부로 분할해 디코딩 가능 크기를 유지한다. 화면엔 하나의 연속 회의로 보인다. 0이면 분할 끄기(기본 30)"로 갱신.

- [ ] **Step 1: Write/adjust the failing test**

`settings.test.ts`가 있으면 기본값 단언을 30으로 갱신. 없으면 생성:

```ts
// src/core/settings.test.ts
import { loadSettings } from './settings'
beforeEach(() => localStorage.clear())
test('splitMinutes 기본값은 30(내부 처리 구간)', () => {
  expect(loadSettings().splitMinutes).toBe(30)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/settings.test.ts`
Expected: FAIL(현재 60).

- [ ] **Step 3: Change default**

`settings.ts`의 `DEFAULTS.splitMinutes: 60` → `30`, 주석 갱신(위 Interfaces).

- [ ] **Step 4: Run tests + 전체 회귀**

Run: `npx vitest run src/core/settings.test.ts`
Expected: PASS.
Run: `npm test`
Expected: 전체 통과. (splitMinutes 기본 60을 단언하던 다른 테스트가 있으면 30으로 갱신.)

- [ ] **Step 5: Commit**

```bash
git add src/core/settings.ts src/core/settings.test.ts
git commit -m "feat: 내부 처리 구간 기본 30분(디코딩 안전 + 통합 뷰)"
```

---

## Task 8: 전체 회귀 + 빌드 검증

**Files:** 없음(검증 태스크).

- [ ] **Step 1: 전체 테스트**

Run: `npm test`
Expected: 전부 통과.

- [ ] **Step 2: 타입 + 빌드**

Run: `npx tsc --noEmit && npm run build`
Expected: 오류 없음, `dist` 생성.

- [ ] **Step 3: 디버그 로그 지점 점검**

`diarizeGroup`·`retranscribeGroup`·`runFinalPipeline`·`transcribeOnePart`에 `dlog`(부별 디코딩 sec/MB, 세그먼트 수, 전역 화자 수, outcome)가 들어있는지 grep으로 확인:
Run: `grep -rn "dlog(\|dtimer(" src/core/meetingActions.ts src/core/pipeline.ts src/core/diarize`
Expected: 각 주요 단계에 로그 존재.

- [ ] **Step 4: Commit(변경 있으면)** — 없으면 생략.

---

## Self-Review (작성자 체크)

- **스펙 커버리지**: 녹음-시점 30분(T7) / 통합 처리·엔진 1회(T3,T4) / 전역 화자(T3) / 자동 정리 그룹화(T5) / 통합 뷰·부 탭 제거·그룹 이름·병합(T6) / 디버그 로그(T1 + 각 태스크) / 기존 16h 단일 회의 요약만(T5 단일 경로 too-long 유지) — 모두 태스크 존재. ✅
- **타입 일관성**: `globalSpeakerRegions`의 `PartExtract`(targets/embeddings/offsetSec)와 `diarizeGroup`이 넘기는 객체 필드 일치. `DiarizeEngine.extract` 반환 `{targets, embeddings}`가 워커 `extracted` 메시지와 일치. `retranscribeGroup`/`diarizeGroup` 반환 유니온이 pipeline 목과 일치. ✅
- **플레이스홀더**: 각 스텝에 실제 코드/명령/기대값 포함. 통합 뷰의 "이하 기존 코드 유지"는 pipeline-done dispatch 블록(이미 존재)을 가리키며 새 코드가 아님(명시). ✅
