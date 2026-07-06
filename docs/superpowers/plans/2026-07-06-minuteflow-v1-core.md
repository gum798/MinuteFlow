# MinuteFlow Plan 1 — 코어 (녹음 + 실시간 전사 + 로컬 저장 + 내보내기) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome에서 접속 즉시 회의를 녹음하며 실시간 전사를 받고, 브라우저 로컬(IndexedDB)에 저장·복구하고, Markdown/TXT로 내보내는 배포 가능한 정적 웹앱 MVP.

**Architecture:** 순수 정적 React PWA(서버 없음). `core/*` 모듈(store/recorder/stt/export)은 UI 없이 단독 테스트 가능한 경계로 분리하고, UI 페이지는 이 모듈들을 조립만 한다. 녹음은 10초 청크를 IndexedDB에 즉시 append(크래시 복구 가능), 실시간 전사는 Web Speech API 재시작 루프로 유지한다.

**Tech Stack:** React 18 + TypeScript(strict) + Vite, Dexie(IndexedDB), react-router-dom(HashRouter), vitest + @testing-library/react + fake-indexeddb.

**스펙:** `docs/superpowers/specs/2026-07-06-minuteflow-design.md` (승인됨). 이 플랜은 스펙 §3(아키텍처)·§4-①(Web Speech)·§6(녹음 파이프라인)·§8(데이터 모델·UI 일부)·§10(테스트 일부)을 구현한다. 파일 업로드·Whisper·Groq·요약·PWA·e2e는 Plan 2/3.

## Global Constraints

- **순수 정적**: 서버 코드·Pages Functions·API 프록시 금지. 외부 네트워크 호출은 이 플랜 범위에서는 없음
- **배포 산출물 파일당 25MiB 미만** (Cloudflare Pages 제한)
- TypeScript `strict: true`, 모든 신규 로직은 테스트 선행(TDD)
- 기본 언어 `ko-KR`, UI 문구는 한국어
- 녹음 청크 timeslice **10초**, 워치독 임계 **25초** (스펙 §6)
- MediaRecorder 코덱 폴백 체인: `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` (스펙 §6)
- 오디오 청크는 IndexedDB에 **ArrayBuffer로 저장** (Blob 대신 — Node/jsdom 테스트의 structured-clone 및 구형 Safari Blob-in-IDB 호환. 스펙 §8 스키마의 `blob` 필드를 `data: ArrayBuffer` + `mimeType`으로 구체화)
- 커밋 메시지는 conventional commits(`feat:`/`test:`/`chore:`/`docs:`), 각 태스크 완료 시 커밋

## File Structure (이 플랜이 만드는 파일)

```
package.json / vite.config.ts / tsconfig.json / index.html / .gitignore
src/main.tsx                 앱 엔트리 (HashRouter)
src/App.tsx                  라우트 정의
src/test/setup.ts            vitest 셋업 (jest-dom)
src/core/types.ts            도메인 타입 (Meeting, AudioChunk, TranscriptSegment, Summary)
src/core/format.ts           시간 포맷 순수 함수
src/core/store/db.ts         Dexie 스키마
src/core/store/meetings.ts   회의 CRUD + 복구
src/core/store/storage.ts    persist()/estimate() 래퍼
src/core/recorder/mime.ts    코덱 폴백 선택
src/core/recorder/chunkedRecorder.ts  timeslice 녹음 + 워치독
src/core/recorder/wakeLock.ts
src/core/stt/webSpeech.ts    재시작 루프 엔진
src/core/export/exporters.ts md/txt 생성 + 다운로드
src/ui/pages/Home.tsx        목록 + 용량 + 복구 배너
src/ui/pages/Record.tsx      녹음 화면
src/ui/pages/Meeting.tsx     회의록 뷰
README.md                    배포 안내 포함
(각 모듈 옆 *.test.ts[x] — colocated)
```

---

### Task 1: 프로젝트 스캐폴드 + 테스트 러너

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`, `src/main.tsx`, `src/App.tsx`, `src/test/setup.ts`, `src/App.test.tsx`

**Interfaces:**
- Consumes: 없음 (최초 태스크)
- Produces: `npm test`(vitest, jsdom+fake-indexeddb), `npm run build`(tsc+vite). 이후 모든 태스크가 이 러너를 사용

- [ ] **Step 1: 기반 파일 작성**

`.gitignore`:
```
node_modules/
dist/
*.local
.DS_Store
```

`package.json`:
```json
{
  "name": "minuteflow",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

`vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['fake-indexeddb/auto', './src/test/setup.ts'],
  },
})
```

`index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MinuteFlow — 음성 회의록</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest'
```

`src/main.tsx`:
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
```

`src/App.tsx` (라우트는 Task 9에서 채움):
```tsx
export default function App() {
  return <h1>MinuteFlow</h1>
}
```

- [ ] **Step 2: 의존성 설치**

```bash
npm install react react-dom dexie react-router-dom
npm install -D typescript vite @vitejs/plugin-react vitest jsdom \
  @testing-library/react @testing-library/jest-dom fake-indexeddb \
  @types/react @types/react-dom
```

- [ ] **Step 3: 실패하는 스모크 테스트 작성**

`src/App.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'

test('앱 타이틀이 렌더링된다', () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  )
  expect(screen.getByText(/MinuteFlow/)).toBeInTheDocument()
})
```

- [ ] **Step 4: 테스트·빌드 통과 확인**

Run: `npm test` → Expected: 1 passed
Run: `npm run build` → Expected: `dist/` 생성, 에러 없음

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: Vite+React+TS 스캐폴드 및 vitest 셋업"
```

---

### Task 2: 도메인 타입 + 시간 포맷 유틸

**Files:**
- Create: `src/core/types.ts`, `src/core/format.ts`
- Test: `src/core/format.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `types.ts`: `Meeting {id: string; title: string; createdAt: number; durationSec: number; status: 'recording'|'done'; language: string}`, `AudioChunk {id?: number; meetingId: string; seq: number; data: ArrayBuffer; mimeType: string; startedAt: number}`, `TranscriptSegment {id?: number; meetingId: string; startSec: number; endSec: number; text: string; source: 'webspeech'|'whisper'|'groq'; isFinal: boolean}`, `Summary {id?: number; meetingId: string; template: 'minutes'|'brief'|'timeline'; markdown: string; provider: string; createdAt: number}`
  - `format.ts`: `formatTimestamp(totalSec: number): string` (1시간 미만 `MM:SS`, 이상 `H:MM:SS`)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/format.test.ts`:
```ts
import { formatTimestamp } from './format'

test('1시간 미만은 MM:SS', () => {
  expect(formatTimestamp(0)).toBe('00:00')
  expect(formatTimestamp(65)).toBe('01:05')
  expect(formatTimestamp(599.9)).toBe('09:59')
})

test('1시간 이상은 H:MM:SS', () => {
  expect(formatTimestamp(3600)).toBe('1:00:00')
  expect(formatTimestamp(3725)).toBe('1:02:05')
})

test('음수는 00:00으로 클램프', () => {
  expect(formatTimestamp(-5)).toBe('00:00')
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- format`
Expected: FAIL — `Cannot find module './format'`

- [ ] **Step 3: 구현**

`src/core/types.ts`:
```ts
export type SttSource = 'webspeech' | 'whisper' | 'groq'

export interface Meeting {
  id: string
  title: string
  createdAt: number
  durationSec: number
  status: 'recording' | 'done'
  language: string
}

export interface AudioChunk {
  id?: number
  meetingId: string
  seq: number
  data: ArrayBuffer
  mimeType: string
  startedAt: number
}

export interface TranscriptSegment {
  id?: number
  meetingId: string
  startSec: number
  endSec: number
  text: string
  source: SttSource
  isFinal: boolean
}

export interface Summary {
  id?: number
  meetingId: string
  template: 'minutes' | 'brief' | 'timeline'
  markdown: string
  provider: string
  createdAt: number
}
```

`src/core/format.ts`:
```ts
export function formatTimestamp(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- format` → Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/format.ts src/core/format.test.ts
git commit -m "feat: 도메인 타입 및 시간 포맷 유틸"
```

---

### Task 3: Dexie 스키마 + 회의 스토어 (CRUD·복구)

**Files:**
- Create: `src/core/store/db.ts`, `src/core/store/meetings.ts`
- Test: `src/core/store/meetings.test.ts`

**Interfaces:**
- Consumes: `src/core/types.ts`의 모든 타입
- Produces (`meetings.ts` — 이후 UI 태스크 전부가 사용):
  - `createMeeting(language?: string): Promise<Meeting>` — id는 `crypto.randomUUID()`, title 기본 `"회의 YYYY-MM-DD HH:mm"`, status `'recording'`
  - `appendAudioChunk(meetingId: string, seq: number, blob: Blob, mimeType: string): Promise<void>`
  - `appendSegment(seg: Omit<TranscriptSegment, 'id'>): Promise<void>`
  - `finishMeeting(id: string, durationSec: number): Promise<void>` — status `'done'`
  - `updateMeetingTitle(id: string, title: string): Promise<void>`
  - `listMeetings(): Promise<Meeting[]>` — createdAt 내림차순
  - `getMeeting(id: string): Promise<Meeting | undefined>`
  - `getSegments(meetingId: string): Promise<TranscriptSegment[]>` — startSec 오름차순
  - `getMeetingAudio(meetingId: string): Promise<Blob | null>` — 청크 seq순 연결, 없으면 null
  - `findInterruptedMeetings(): Promise<Meeting[]>` — status `'recording'`
  - `finalizeInterrupted(id: string): Promise<Meeting | undefined>` — 마지막 청크 시각 기반 duration 추정 후 `'done'` 전환
  - `deleteMeeting(id: string): Promise<void>` — 관련 청크·세그먼트·요약 캐스케이드 삭제

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/store/meetings.test.ts`:
```ts
import { db } from './db'
import {
  createMeeting, appendAudioChunk, appendSegment, finishMeeting,
  updateMeetingTitle, listMeetings, getMeeting, getSegments,
  getMeetingAudio, findInterruptedMeetings, finalizeInterrupted, deleteMeeting,
} from './meetings'

beforeEach(async () => {
  await Promise.all([
    db.meetings.clear(), db.audioChunks.clear(),
    db.transcriptSegments.clear(), db.summaries.clear(),
  ])
})

test('createMeeting은 recording 상태의 회의를 만든다', async () => {
  const m = await createMeeting()
  expect(m.status).toBe('recording')
  expect(m.language).toBe('ko-KR')
  expect(m.title).toMatch(/^회의 /)
  expect(await getMeeting(m.id)).toMatchObject({ id: m.id })
})

test('listMeetings는 createdAt 내림차순', async () => {
  const a = await createMeeting()
  await db.meetings.update(a.id, { createdAt: 1000 })
  const b = await createMeeting()
  await db.meetings.update(b.id, { createdAt: 2000 })
  const list = await listMeetings()
  expect(list.map(m => m.id)).toEqual([b.id, a.id])
})

test('오디오 청크는 seq순으로 연결되어 하나의 Blob이 된다', async () => {
  const m = await createMeeting()
  await appendAudioChunk(m.id, 1, new Blob(['BB']), 'audio/webm')
  await appendAudioChunk(m.id, 0, new Blob(['AA']), 'audio/webm')
  const blob = await getMeetingAudio(m.id)
  expect(blob).not.toBeNull()
  expect(await blob!.text()).toBe('AABB')
  expect(blob!.type).toBe('audio/webm')
})

test('청크가 없으면 getMeetingAudio는 null', async () => {
  const m = await createMeeting()
  expect(await getMeetingAudio(m.id)).toBeNull()
})

test('세그먼트는 startSec 오름차순으로 조회된다', async () => {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 10, endSec: 12, text: '둘', source: 'webspeech', isFinal: true })
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 3, text: '하나', source: 'webspeech', isFinal: true })
  const segs = await getSegments(m.id)
  expect(segs.map(s => s.text)).toEqual(['하나', '둘'])
})

test('finishMeeting과 updateMeetingTitle', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 123)
  await updateMeetingTitle(m.id, '주간회의')
  const got = await getMeeting(m.id)
  expect(got).toMatchObject({ status: 'done', durationSec: 123, title: '주간회의' })
})

test('중단된 회의를 찾아 마지막 청크 기준으로 복구한다', async () => {
  const m = await createMeeting()
  await db.meetings.update(m.id, { createdAt: 1000 })
  await appendAudioChunk(m.id, 0, new Blob(['x']), 'audio/webm')
  await db.audioChunks.where('meetingId').equals(m.id).modify({ startedAt: 31000 })
  expect((await findInterruptedMeetings()).map(x => x.id)).toEqual([m.id])
  const fixed = await finalizeInterrupted(m.id)
  // (31000 - 1000) / 1000 + 10초(청크 길이) = 40
  expect(fixed).toMatchObject({ status: 'done', durationSec: 40 })
  expect(await findInterruptedMeetings()).toEqual([])
})

test('청크가 없는 중단 회의는 duration 0으로 복구', async () => {
  const m = await createMeeting()
  const fixed = await finalizeInterrupted(m.id)
  expect(fixed).toMatchObject({ status: 'done', durationSec: 0 })
})

test('deleteMeeting은 하위 데이터까지 지운다', async () => {
  const m = await createMeeting()
  await appendAudioChunk(m.id, 0, new Blob(['x']), 'audio/webm')
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 1, text: 'a', source: 'webspeech', isFinal: true })
  await deleteMeeting(m.id)
  expect(await getMeeting(m.id)).toBeUndefined()
  expect(await db.audioChunks.where('meetingId').equals(m.id).count()).toBe(0)
  expect(await db.transcriptSegments.where('meetingId').equals(m.id).count()).toBe(0)
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- meetings`
Expected: FAIL — `Cannot find module './db'`

- [ ] **Step 3: 구현**

`src/core/store/db.ts`:
```ts
import Dexie, { type Table } from 'dexie'
import type { Meeting, AudioChunk, TranscriptSegment, Summary } from '../types'

export class MinuteFlowDB extends Dexie {
  meetings!: Table<Meeting, string>
  audioChunks!: Table<AudioChunk, number>
  transcriptSegments!: Table<TranscriptSegment, number>
  summaries!: Table<Summary, number>

  constructor() {
    super('minuteflow')
    this.version(1).stores({
      meetings: 'id, createdAt, status',
      audioChunks: '++id, meetingId, [meetingId+seq]',
      transcriptSegments: '++id, meetingId, [meetingId+startSec]',
      summaries: '++id, meetingId',
    })
  }
}

export const db = new MinuteFlowDB()
```

`src/core/store/meetings.ts`:
```ts
import { db } from './db'
import type { Meeting, TranscriptSegment } from '../types'

const CHUNK_SEC = 10 // MediaRecorder timeslice와 일치 (Global Constraints)

function defaultTitle(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `회의 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export async function createMeeting(language = 'ko-KR'): Promise<Meeting> {
  const now = new Date()
  const meeting: Meeting = {
    id: crypto.randomUUID(),
    title: defaultTitle(now),
    createdAt: now.getTime(),
    durationSec: 0,
    status: 'recording',
    language,
  }
  await db.meetings.add(meeting)
  return meeting
}

export async function appendAudioChunk(
  meetingId: string, seq: number, blob: Blob, mimeType: string,
): Promise<void> {
  const data = await blob.arrayBuffer()
  await db.audioChunks.add({ meetingId, seq, data, mimeType, startedAt: Date.now() })
}

export async function appendSegment(seg: Omit<TranscriptSegment, 'id'>): Promise<void> {
  await db.transcriptSegments.add(seg)
}

export async function finishMeeting(id: string, durationSec: number): Promise<void> {
  await db.meetings.update(id, { status: 'done', durationSec })
}

export async function updateMeetingTitle(id: string, title: string): Promise<void> {
  await db.meetings.update(id, { title })
}

export function listMeetings(): Promise<Meeting[]> {
  return db.meetings.orderBy('createdAt').reverse().toArray()
}

export function getMeeting(id: string): Promise<Meeting | undefined> {
  return db.meetings.get(id)
}

export function getSegments(meetingId: string): Promise<TranscriptSegment[]> {
  return db.transcriptSegments.where('[meetingId+startSec]')
    .between([meetingId, -Infinity], [meetingId, Infinity]).toArray()
}

export async function getMeetingAudio(meetingId: string): Promise<Blob | null> {
  const chunks = await db.audioChunks.where('meetingId').equals(meetingId).sortBy('seq')
  if (chunks.length === 0) return null
  return new Blob(chunks.map(c => c.data), { type: chunks[0].mimeType })
}

export function findInterruptedMeetings(): Promise<Meeting[]> {
  return db.meetings.where('status').equals('recording').toArray()
}

export async function finalizeInterrupted(id: string): Promise<Meeting | undefined> {
  const meeting = await db.meetings.get(id)
  if (!meeting) return undefined
  const chunks = await db.audioChunks.where('meetingId').equals(id).sortBy('seq')
  const last = chunks.at(-1)
  const durationSec = last
    ? Math.max(0, Math.round((last.startedAt - meeting.createdAt) / 1000) + CHUNK_SEC)
    : 0
  await finishMeeting(id, durationSec)
  return db.meetings.get(id)
}

export async function deleteMeeting(id: string): Promise<void> {
  await db.transaction('rw', [db.meetings, db.audioChunks, db.transcriptSegments, db.summaries], async () => {
    await db.audioChunks.where('meetingId').equals(id).delete()
    await db.transcriptSegments.where('meetingId').equals(id).delete()
    await db.summaries.where('meetingId').equals(id).delete()
    await db.meetings.delete(id)
  })
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- meetings` → Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/store/
git commit -m "feat: Dexie 스키마 및 회의 스토어(CRUD·크래시 복구)"
```

---

### Task 4: 저장소 persist/estimate 래퍼

**Files:**
- Create: `src/core/store/storage.ts`
- Test: `src/core/store/storage.test.ts`

**Interfaces:**
- Consumes: 없음 (navigator.storage만)
- Produces:
  - `ensurePersistentStorage(): Promise<boolean>` — 이미 persisted면 true, 아니면 persist() 요청. API 없으면 false
  - `getStorageUsage(): Promise<{ usage: number; quota: number } | null>` — estimate() 래핑, API 없으면 null

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/store/storage.test.ts`:
```ts
import { ensurePersistentStorage, getStorageUsage } from './storage'

afterEach(() => vi.unstubAllGlobals())

function stubStorage(overrides: Partial<StorageManager>) {
  vi.stubGlobal('navigator', { ...navigator, storage: overrides as StorageManager })
}

test('이미 persisted면 persist()를 다시 요청하지 않는다', async () => {
  const persist = vi.fn()
  stubStorage({ persisted: async () => true, persist })
  expect(await ensurePersistentStorage()).toBe(true)
  expect(persist).not.toHaveBeenCalled()
})

test('persisted가 아니면 persist()를 요청한다', async () => {
  stubStorage({ persisted: async () => false, persist: async () => true })
  expect(await ensurePersistentStorage()).toBe(true)
})

test('storage API가 없으면 false', async () => {
  vi.stubGlobal('navigator', { ...navigator, storage: undefined })
  expect(await ensurePersistentStorage()).toBe(false)
})

test('getStorageUsage는 estimate를 반환한다', async () => {
  stubStorage({ estimate: async () => ({ usage: 100, quota: 1000 }) })
  expect(await getStorageUsage()).toEqual({ usage: 100, quota: 1000 })
})

test('estimate 미지원이면 null', async () => {
  vi.stubGlobal('navigator', { ...navigator, storage: undefined })
  expect(await getStorageUsage()).toBeNull()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- storage`
Expected: FAIL — `Cannot find module './storage'`

- [ ] **Step 3: 구현**

`src/core/store/storage.ts`:
```ts
export async function ensurePersistentStorage(): Promise<boolean> {
  const storage = navigator.storage
  if (!storage?.persist || !storage.persisted) return false
  if (await storage.persisted()) return true
  return storage.persist()
}

export async function getStorageUsage(): Promise<{ usage: number; quota: number } | null> {
  const storage = navigator.storage
  if (!storage?.estimate) return null
  const { usage = 0, quota = 0 } = await storage.estimate()
  return { usage, quota }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- storage` → Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/store/storage.ts src/core/store/storage.test.ts
git commit -m "feat: 지속 저장 요청 및 용량 조회 래퍼"
```

---

### Task 5: 코덱 선택 + ChunkedRecorder (timeslice·워치독)

**Files:**
- Create: `src/core/recorder/mime.ts`, `src/core/recorder/chunkedRecorder.ts`
- Test: `src/core/recorder/mime.test.ts`, `src/core/recorder/chunkedRecorder.test.ts`

**Interfaces:**
- Consumes: 없음 (브라우저 MediaRecorder만; 테스트 주입용 팩토리 옵션 제공)
- Produces:
  - `pickMimeType(isSupported?: (t: string) => boolean): string | undefined` — 폴백 체인 첫 지원 타입
  - `ChunkedRecorderEvents { onChunk(blob: Blob, seq: number): void; onStallRestart(): void; onError(err: Error): void }`
  - `class ChunkedRecorder { constructor(stream: MediaStream, events: ChunkedRecorderEvents, opts?: { mimeType?: string; timesliceMs?: number; stallMs?: number; createRecorder?: (s: MediaStream, o?: MediaRecorderOptions) => MediaRecorder }); start(): void; stop(): Promise<void>; readonly mimeType: string }`
  - 동작 규약: `start()` 후 timeslice(기본 10000ms)마다 `onChunk(blob, seq)`(seq 0부터 증가). 마지막 청크 후 `stallMs`(기본 25000ms) 경과 시 `onStallRestart()` 호출 + MediaRecorder 재생성(seq 이어짐). `stop()`은 남은 데이터 flush 후 resolve

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/recorder/mime.test.ts`:
```ts
import { pickMimeType } from './mime'

test('첫 번째 지원 타입을 고른다', () => {
  expect(pickMimeType(t => t === 'audio/webm')).toBe('audio/webm')
  expect(pickMimeType(t => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus')
  expect(pickMimeType(t => t === 'audio/mp4')).toBe('audio/mp4')
})

test('지원 타입이 없으면 undefined', () => {
  expect(pickMimeType(() => false)).toBeUndefined()
})
```

`src/core/recorder/chunkedRecorder.test.ts`:
```ts
import { ChunkedRecorder, type ChunkedRecorderEvents } from './chunkedRecorder'

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  ondataavailable: ((ev: { data: Blob }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onstop: (() => void) | null = null
  state = 'inactive'
  constructor(public stream: MediaStream, public options?: MediaRecorderOptions) {
    FakeMediaRecorder.instances.push(this)
  }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.onstop?.() }
  requestData() {}
  emit(data = 'x') { this.ondataavailable?.({ data: new Blob([data]) }) }
}

function make(events: Partial<ChunkedRecorderEvents> = {}) {
  const ev: ChunkedRecorderEvents = {
    onChunk: vi.fn(), onStallRestart: vi.fn(), onError: vi.fn(), ...events,
  }
  const rec = new ChunkedRecorder({} as MediaStream, ev, {
    mimeType: 'audio/webm',
    createRecorder: (s, o) => new FakeMediaRecorder(s, o) as unknown as MediaRecorder,
  })
  return { rec, ev }
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

test('청크마다 onChunk가 증가하는 seq로 불린다', () => {
  const { rec, ev } = make()
  rec.start()
  const inner = FakeMediaRecorder.instances[0]
  inner.emit('a')
  inner.emit('b')
  expect(ev.onChunk).toHaveBeenNthCalledWith(1, expect.any(Blob), 0)
  expect(ev.onChunk).toHaveBeenNthCalledWith(2, expect.any(Blob), 1)
})

test('빈 blob은 무시한다', () => {
  const { rec, ev } = make()
  rec.start()
  FakeMediaRecorder.instances[0].ondataavailable?.({ data: new Blob([]) })
  expect(ev.onChunk).not.toHaveBeenCalled()
})

test('25초간 청크가 없으면 재시작하고 seq는 이어진다', () => {
  const { rec, ev } = make()
  rec.start()
  FakeMediaRecorder.instances[0].emit('a') // seq 0
  vi.advanceTimersByTime(26_000)
  expect(ev.onStallRestart).toHaveBeenCalledTimes(1)
  expect(FakeMediaRecorder.instances).toHaveLength(2) // 재생성됨
  FakeMediaRecorder.instances[1].emit('b')
  expect(ev.onChunk).toHaveBeenLastCalledWith(expect.any(Blob), 1)
})

test('정상 수신 중에는 재시작하지 않는다', () => {
  const { rec, ev } = make()
  rec.start()
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(10_000)
    FakeMediaRecorder.instances[0].emit(`c${i}`)
  }
  expect(ev.onStallRestart).not.toHaveBeenCalled()
})

test('stop()은 flush 후 resolve하고 워치독을 멈춘다', async () => {
  const { rec, ev } = make()
  rec.start()
  const p = rec.stop()
  await p
  vi.advanceTimersByTime(60_000)
  expect(ev.onStallRestart).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- recorder`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/core/recorder/mime.ts`:
```ts
const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

export function pickMimeType(
  isSupported: (t: string) => boolean = t => MediaRecorder.isTypeSupported(t),
): string | undefined {
  return CANDIDATES.find(isSupported)
}
```

`src/core/recorder/chunkedRecorder.ts`:
```ts
export interface ChunkedRecorderEvents {
  onChunk(blob: Blob, seq: number): void
  onStallRestart(): void
  onError(err: Error): void
}

export interface ChunkedRecorderOptions {
  mimeType?: string
  timesliceMs?: number
  stallMs?: number
  createRecorder?: (s: MediaStream, o?: MediaRecorderOptions) => MediaRecorder
}

const WATCHDOG_INTERVAL_MS = 5_000

export class ChunkedRecorder {
  readonly mimeType: string
  private readonly timesliceMs: number
  private readonly stallMs: number
  private readonly createRecorder: NonNullable<ChunkedRecorderOptions['createRecorder']>
  private recorder: MediaRecorder | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private seq = 0
  private lastChunkAt = 0
  private stopping = false

  constructor(
    private stream: MediaStream,
    private events: ChunkedRecorderEvents,
    opts: ChunkedRecorderOptions = {},
  ) {
    this.mimeType = opts.mimeType ?? 'audio/webm'
    this.timesliceMs = opts.timesliceMs ?? 10_000
    this.stallMs = opts.stallMs ?? 25_000
    this.createRecorder = opts.createRecorder ?? ((s, o) => new MediaRecorder(s, o))
  }

  start(): void {
    this.spawn()
    this.lastChunkAt = Date.now()
    this.watchdog = setInterval(() => this.checkStall(), WATCHDOG_INTERVAL_MS)
  }

  private spawn(): void {
    const rec = this.createRecorder(this.stream, { mimeType: this.mimeType })
    rec.ondataavailable = ev => {
      if (ev.data.size === 0) return
      this.lastChunkAt = Date.now()
      this.events.onChunk(ev.data, this.seq++)
    }
    rec.onerror = () => this.events.onError(new Error('MediaRecorder error'))
    rec.start(this.timesliceMs)
    this.recorder = rec
  }

  private checkStall(): void {
    if (this.stopping || Date.now() - this.lastChunkAt <= this.stallMs) return
    this.events.onStallRestart()
    try { this.recorder?.stop() } catch { /* 이미 죽은 recorder */ }
    this.spawn()
    this.lastChunkAt = Date.now()
  }

  stop(): Promise<void> {
    this.stopping = true
    if (this.watchdog) clearInterval(this.watchdog)
    const rec = this.recorder
    if (!rec || rec.state === 'inactive') return Promise.resolve()
    return new Promise(resolve => {
      rec.onstop = () => resolve()
      try { rec.requestData() } catch { /* flush 불가 시 무시 */ }
      rec.stop()
    })
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- recorder` → Expected: 7 passed (mime 2 + chunkedRecorder 5)

- [ ] **Step 5: Commit**

```bash
git add src/core/recorder/
git commit -m "feat: 코덱 폴백 선택 및 워치독 내장 청크 녹음기"
```

---

### Task 6: Wake Lock 매니저

**Files:**
- Create: `src/core/recorder/wakeLock.ts`
- Test: `src/core/recorder/wakeLock.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `createWakeLockManager(nav?: Navigator, doc?: Document): { enable(): Promise<void>; disable(): Promise<void> }`
  - 규약: `enable()`은 `screen` wake lock 획득 + `visibilitychange`에서 visible 복귀 시 재획득. `disable()`은 해제 + 리스너 제거. Wake Lock API 없으면 조용히 no-op

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/recorder/wakeLock.test.ts`:
```ts
import { createWakeLockManager } from './wakeLock'

function makeFakes() {
  const sentinel = { release: vi.fn(async () => {}) }
  const request = vi.fn(async () => sentinel)
  const listeners: Record<string, () => void> = {}
  const doc = {
    visibilityState: 'visible',
    addEventListener: vi.fn((t: string, fn: () => void) => { listeners[t] = fn }),
    removeEventListener: vi.fn((t: string) => { delete listeners[t] }),
  } as unknown as Document
  const nav = { wakeLock: { request } } as unknown as Navigator
  return { nav, doc, request, sentinel, listeners }
}

test('enable은 wake lock을 획득한다', async () => {
  const { nav, doc, request } = makeFakes()
  await createWakeLockManager(nav, doc).enable()
  expect(request).toHaveBeenCalledWith('screen')
})

test('visible 복귀 시 재획득한다', async () => {
  const { nav, doc, request, listeners } = makeFakes()
  await createWakeLockManager(nav, doc).enable()
  await listeners['visibilitychange']()
  expect(request).toHaveBeenCalledTimes(2)
})

test('disable 후에는 재획득하지 않는다', async () => {
  const { nav, doc, request, sentinel } = makeFakes()
  const mgr = createWakeLockManager(nav, doc)
  await mgr.enable()
  await mgr.disable()
  expect(sentinel.release).toHaveBeenCalled()
  expect(doc.removeEventListener).toHaveBeenCalled()
  expect(request).toHaveBeenCalledTimes(1)
})

test('API 미지원이면 조용히 no-op', async () => {
  const doc = { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Document
  const mgr = createWakeLockManager({} as Navigator, doc)
  await expect(mgr.enable()).resolves.toBeUndefined()
  await expect(mgr.disable()).resolves.toBeUndefined()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- wakeLock` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/core/recorder/wakeLock.ts`:
```ts
type Sentinel = { release(): Promise<void> }

export function createWakeLockManager(
  nav: Navigator = navigator,
  doc: Document = document,
) {
  let sentinel: Sentinel | null = null
  let active = false

  async function acquire(): Promise<void> {
    const wakeLock = (nav as { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }).wakeLock
    if (!wakeLock) return
    try { sentinel = await wakeLock.request('screen') } catch { /* 저전력 모드 등에서 거부될 수 있음 */ }
  }

  async function onVisibility(): Promise<void> {
    if (active && doc.visibilityState === 'visible') await acquire()
  }

  return {
    async enable(): Promise<void> {
      active = true
      doc.addEventListener('visibilitychange', onVisibility)
      await acquire()
    },
    async disable(): Promise<void> {
      active = false
      doc.removeEventListener('visibilitychange', onVisibility)
      await sentinel?.release().catch(() => {})
      sentinel = null
    },
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- wakeLock` → Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/recorder/wakeLock.ts src/core/recorder/wakeLock.test.ts
git commit -m "feat: 화면 꺼짐 방지 Wake Lock 매니저"
```

---

### Task 7: Web Speech 엔진 (재시작 루프)

**Files:**
- Create: `src/core/stt/webSpeech.ts`
- Test: `src/core/stt/webSpeech.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `getSpeechRecognitionCtor(win?: unknown): SpeechRecognitionCtor | null` — `SpeechRecognition` → `webkitSpeechRecognition` 폴백, 없으면 null
  - `type WebSpeechStatus = 'idle' | 'listening' | 'restarting' | 'stopped'`
  - `WebSpeechEvents { onInterim(text: string): void; onFinal(text: string): void; onStatus(status: WebSpeechStatus): void }`
  - `class WebSpeechEngine { constructor(ctor: SpeechRecognitionCtor, lang: string, events: WebSpeechEvents); start(): void; stop(): void }`
  - 규약: 브라우저가 스스로 멈추면(`onend`) 사용자가 `stop()`을 부르지 않은 한 자동 재시작(`restarting` → `listening`). final 결과만 `onFinal`, 중간 결과는 합쳐서 `onInterim`. Edge no-op 판정(이벤트 무발생 감지)은 Plan 3 capabilities에서 처리 — 여기서는 ctor 존재만 판단

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/stt/webSpeech.test.ts`:
```ts
import { WebSpeechEngine, getSpeechRecognitionCtor, type WebSpeechEvents } from './webSpeech'

class FakeRecognition {
  static instances: FakeRecognition[] = []
  lang = ''
  continuous = false
  interimResults = false
  onresult: ((ev: unknown) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  started = 0
  constructor() { FakeRecognition.instances.push(this) }
  start() { this.started++ }
  stop() { this.onend?.() }
  abort() {}
  emitResult(items: Array<{ text: string; isFinal: boolean }>, resultIndex = 0) {
    const results = items.map(i => Object.assign([{ transcript: i.text }], { isFinal: i.isFinal }))
    this.onresult?.({ resultIndex, results })
  }
}

function make() {
  FakeRecognition.instances = []
  const events: WebSpeechEvents = { onInterim: vi.fn(), onFinal: vi.fn(), onStatus: vi.fn() }
  const engine = new WebSpeechEngine(FakeRecognition as never, 'ko-KR', events)
  return { engine, events }
}

test('start는 ko-KR continuous 인식을 시작한다', () => {
  const { engine, events } = make()
  engine.start()
  const rec = FakeRecognition.instances[0]
  expect(rec.lang).toBe('ko-KR')
  expect(rec.continuous).toBe(true)
  expect(rec.interimResults).toBe(true)
  expect(rec.started).toBe(1)
  expect(events.onStatus).toHaveBeenLastCalledWith('listening')
})

test('final 결과는 onFinal, 중간 결과는 onInterim', () => {
  const { engine, events } = make()
  engine.start()
  const rec = FakeRecognition.instances[0]
  rec.emitResult([{ text: '안녕하세요', isFinal: false }])
  expect(events.onInterim).toHaveBeenLastCalledWith('안녕하세요')
  rec.emitResult([{ text: '안녕하세요 여러분', isFinal: true }])
  expect(events.onFinal).toHaveBeenLastCalledWith('안녕하세요 여러분')
  expect(events.onInterim).toHaveBeenLastCalledWith('')
})

test('스스로 멈추면 자동 재시작한다', () => {
  const { engine, events } = make()
  engine.start()
  const rec = FakeRecognition.instances[0]
  rec.onend?.()
  expect(rec.started).toBe(2)
  expect(events.onStatus).toHaveBeenCalledWith('restarting')
  expect(events.onStatus).toHaveBeenLastCalledWith('listening')
})

test('사용자 stop 후에는 재시작하지 않는다', () => {
  const { engine, events } = make()
  engine.start()
  const rec = FakeRecognition.instances[0]
  engine.stop()
  expect(rec.started).toBe(1)
  expect(events.onStatus).toHaveBeenLastCalledWith('stopped')
})

test('getSpeechRecognitionCtor는 프리픽스 폴백한다', () => {
  expect(getSpeechRecognitionCtor({})).toBeNull()
  expect(getSpeechRecognitionCtor({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition)
  expect(getSpeechRecognitionCtor({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition)
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- webSpeech` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/core/stt/webSpeech.ts`:
```ts
export interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: RecognitionResultEvent) => void) | null
  onend: (() => void) | null
  onerror: ((ev: unknown) => void) | null
  start(): void
  stop(): void
  abort(): void
}

export interface RecognitionResultEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

export type SpeechRecognitionCtor = new () => RecognitionLike

export function getSpeechRecognitionCtor(win: unknown = globalThis): SpeechRecognitionCtor | null {
  const w = win as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as SpeechRecognitionCtor | null
}

export type WebSpeechStatus = 'idle' | 'listening' | 'restarting' | 'stopped'

export interface WebSpeechEvents {
  onInterim(text: string): void
  onFinal(text: string): void
  onStatus(status: WebSpeechStatus): void
}

export class WebSpeechEngine {
  private recognition: RecognitionLike | null = null
  private userStopped = false

  constructor(
    private ctor: SpeechRecognitionCtor,
    private lang: string,
    private events: WebSpeechEvents,
  ) {}

  start(): void {
    this.userStopped = false
    const rec = new this.ctor()
    rec.lang = this.lang
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = ev => this.handleResult(ev)
    rec.onend = () => this.handleEnd()
    rec.onerror = () => { /* onend가 뒤따라 오므로 재시작은 handleEnd가 담당 */ }
    this.recognition = rec
    rec.start()
    this.events.onStatus('listening')
  }

  stop(): void {
    this.userStopped = true
    this.recognition?.stop()
  }

  private handleResult(ev: RecognitionResultEvent): void {
    let interim = ''
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i]
      const text = result[0].transcript.trim()
      if (!text) continue
      if (result.isFinal) this.events.onFinal(text)
      else interim += text
    }
    this.events.onInterim(interim)
  }

  private handleEnd(): void {
    if (this.userStopped) {
      this.events.onStatus('stopped')
      return
    }
    this.events.onStatus('restarting')
    try {
      this.recognition?.start()
      this.events.onStatus('listening')
    } catch {
      // InvalidStateError 등 — 잠시 후 재시도
      setTimeout(() => { if (!this.userStopped) this.start() }, 250)
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- webSpeech` → Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/stt/
git commit -m "feat: Web Speech 재시작 루프 전사 엔진"
```

---

### Task 8: 내보내기 (Markdown/TXT/다운로드)

**Files:**
- Create: `src/core/export/exporters.ts`
- Test: `src/core/export/exporters.test.ts`

**Interfaces:**
- Consumes: `Meeting`, `TranscriptSegment` (Task 2), `formatTimestamp` (Task 2)
- Produces:
  - `toMarkdown(meeting: Meeting, segments: TranscriptSegment[]): string`
  - `toPlainText(meeting: Meeting, segments: TranscriptSegment[]): string`
  - `exportFilename(meeting: Meeting, ext: string): string` — `YYYY-MM-DD-<제목>.<ext>`, 파일명 금지 문자는 `_`로
  - `downloadBlob(filename: string, blob: Blob): void` — a[download] 클릭, URL revoke

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/export/exporters.test.ts`:
```ts
import { toMarkdown, toPlainText, exportFilename, downloadBlob } from './exporters'
import type { Meeting, TranscriptSegment } from '../types'

const meeting: Meeting = {
  id: 'm1', title: '주간회의', createdAt: new Date('2026-07-06T10:00:00').getTime(),
  durationSec: 3725, status: 'done', language: 'ko-KR',
}
const segments: TranscriptSegment[] = [
  { meetingId: 'm1', startSec: 0, endSec: 5, text: '시작하겠습니다', source: 'webspeech', isFinal: true },
  { meetingId: 'm1', startSec: 5, endSec: 8, text: '(중간)', source: 'webspeech', isFinal: false },
  { meetingId: 'm1', startSec: 65, endSec: 70, text: '다음 안건입니다', source: 'webspeech', isFinal: true },
]

test('toMarkdown은 제목·메타·final 세그먼트만 포함한다', () => {
  const md = toMarkdown(meeting, segments)
  expect(md).toContain('# 주간회의')
  expect(md).toContain('1:02:05') // durationSec
  expect(md).toContain('**[00:00]** 시작하겠습니다')
  expect(md).toContain('**[01:05]** 다음 안건입니다')
  expect(md).not.toContain('(중간)')
})

test('toPlainText는 타임스탬프와 텍스트를 줄 단위로', () => {
  const txt = toPlainText(meeting, segments)
  expect(txt).toContain('[00:00] 시작하겠습니다')
  expect(txt).not.toContain('#')
})

test('exportFilename은 날짜 프리픽스와 안전한 파일명', () => {
  expect(exportFilename(meeting, 'md')).toBe('2026-07-06-주간회의.md')
  expect(exportFilename({ ...meeting, title: 'a/b:c' }, 'txt')).toBe('2026-07-06-a_b_c.txt')
})

test('downloadBlob은 a 태그 클릭으로 저장을 트리거한다', () => {
  const click = vi.fn()
  const a = document.createElement('a')
  a.click = click
  vi.spyOn(document, 'createElement').mockReturnValueOnce(a)
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn(),
  })
  downloadBlob('t.md', new Blob(['x']))
  expect(a.download).toBe('t.md')
  expect(a.href).toContain('blob:fake')
  expect(click).toHaveBeenCalled()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- exporters` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/core/export/exporters.ts`:
```ts
import type { Meeting, TranscriptSegment } from '../types'
import { formatTimestamp } from '../format'

function finalSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter(s => s.isFinal)
}

function meetingDate(meeting: Meeting): string {
  const d = new Date(meeting.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function toMarkdown(meeting: Meeting, segments: TranscriptSegment[]): string {
  const lines = finalSegments(segments).map(
    s => `- **[${formatTimestamp(s.startSec)}]** ${s.text}`,
  )
  return [
    `# ${meeting.title}`,
    '',
    `- 일시: ${meetingDate(meeting)}`,
    `- 길이: ${formatTimestamp(meeting.durationSec)}`,
    '',
    '## 전사',
    '',
    ...lines,
    '',
  ].join('\n')
}

export function toPlainText(meeting: Meeting, segments: TranscriptSegment[]): string {
  const lines = finalSegments(segments).map(
    s => `[${formatTimestamp(s.startSec)}] ${s.text}`,
  )
  return [`${meeting.title} (${meetingDate(meeting)}, ${formatTimestamp(meeting.durationSec)})`, '', ...lines, ''].join('\n')
}

export function exportFilename(meeting: Meeting, ext: string): string {
  const safe = meeting.title.replace(/[\\/:*?"<>|]/g, '_')
  return `${meetingDate(meeting)}-${safe}.${ext}`
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- exporters` → Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/export/
git commit -m "feat: Markdown/TXT 내보내기 및 파일 다운로드"
```

---

### Task 9: 라우팅 + 홈 화면 (목록·용량·복구 배너)

**Files:**
- Modify: `src/App.tsx`
- Create: `src/ui/pages/Home.tsx`
- Test: `src/ui/pages/Home.test.tsx`

**Interfaces:**
- Consumes: `listMeetings`, `findInterruptedMeetings`, `finalizeInterrupted`, `deleteMeeting` (Task 3), `ensurePersistentStorage`, `getStorageUsage` (Task 4), `formatTimestamp` (Task 2)
- Produces: 라우트 `/`(Home), `/record`(Task 10), `/meeting/:id`(Task 11). Home은 마운트 시 `ensurePersistentStorage()` 1회 호출

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ui/pages/Home.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting } from '../../core/store/meetings'
import Home from './Home'

beforeEach(async () => {
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear()])
})

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  )
}

test('완료된 회의가 목록에 보인다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => expect(screen.getByText(m.title)).toBeInTheDocument())
  expect(screen.getByText(/01:00/)).toBeInTheDocument()
})

test('회의가 없으면 안내 문구', async () => {
  renderHome()
  await waitFor(() => expect(screen.getByText(/아직 회의록이 없습니다/)).toBeInTheDocument())
})

test('중단된 회의가 있으면 복구 배너가 보인다', async () => {
  await createMeeting() // status: recording
  renderHome()
  await waitFor(() => expect(screen.getByText(/복구할 녹음/)).toBeInTheDocument())
})

test('녹음 시작/업로드 링크가 있다', async () => {
  renderHome()
  await waitFor(() => expect(screen.getByRole('link', { name: /녹음 시작/ })).toHaveAttribute('href', '#/record'))
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- Home` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/App.tsx` (전체 교체):
```tsx
import { Routes, Route } from 'react-router-dom'
import Home from './ui/pages/Home'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  )
}
```
(참고: `/record`, `/meeting/:id` 라우트는 Task 10·11에서 각각 추가한다.)

`src/ui/pages/Home.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Meeting } from '../../core/types'
import {
  listMeetings, findInterruptedMeetings, finalizeInterrupted, deleteMeeting,
} from '../../core/store/meetings'
import { ensurePersistentStorage, getStorageUsage } from '../../core/store/storage'
import { formatTimestamp } from '../../core/format'

export default function Home() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [interrupted, setInterrupted] = useState<Meeting[]>([])
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const navigate = useNavigate()

  async function refresh() {
    setMeetings(await listMeetings())
    setInterrupted(await findInterruptedMeetings())
    setUsage(await getStorageUsage())
  }

  useEffect(() => {
    void ensurePersistentStorage()
    void refresh()
  }, [])

  async function recover(id: string) {
    await finalizeInterrupted(id)
    navigate(`/meeting/${id}`)
  }

  async function remove(id: string) {
    if (!window.confirm('이 회의록을 삭제할까요? 되돌릴 수 없습니다.')) return
    await deleteMeeting(id)
    await refresh()
  }

  const done = meetings.filter(m => m.status === 'done')

  return (
    <main>
      <h1>MinuteFlow</h1>
      <p>
        <Link to="/record">🎙️ 녹음 시작</Link>
      </p>
      {interrupted.map(m => (
        <div key={m.id} role="alert">
          복구할 녹음이 있습니다: {m.title}{' '}
          <button onClick={() => recover(m.id)}>복구</button>
        </div>
      ))}
      {done.length === 0 ? (
        <p>아직 회의록이 없습니다. 녹음을 시작해보세요.</p>
      ) : (
        <ul>
          {done.map(m => (
            <li key={m.id}>
              <Link to={`/meeting/${m.id}`}>{m.title}</Link>{' '}
              ({formatTimestamp(m.durationSec)}){' '}
              <button onClick={() => remove(m.id)}>삭제</button>
            </li>
          ))}
        </ul>
      )}
      {usage && usage.quota > 0 && (
        <footer>
          저장 공간: {(usage.usage / 1e6).toFixed(1)}MB / {(usage.quota / 1e9).toFixed(1)}GB 사용 중
        </footer>
      )}
    </main>
  )
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- Home` → Expected: 4 passed
Run: `npm test` → Expected: 전체 통과 (App.test.tsx 포함 — Home이 `/`에 렌더되어도 `MinuteFlow` 텍스트가 있어 기존 스모크 테스트 유지)

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/ui/
git commit -m "feat: 홈 화면 — 회의 목록·저장 용량·복구 배너"
```

---

### Task 10: 녹음 화면 (녹음 + 실시간 전사 조립)

**Files:**
- Modify: `src/App.tsx` (라우트 추가)
- Create: `src/ui/pages/Record.tsx`
- Test: `src/ui/pages/Record.test.tsx`

**Interfaces:**
- Consumes: `createMeeting`, `appendAudioChunk`, `appendSegment`, `finishMeeting` (Task 3), `pickMimeType`, `ChunkedRecorder` (Task 5), `createWakeLockManager` (Task 6), `getSpeechRecognitionCtor`, `WebSpeechEngine` (Task 7), `formatTimestamp` (Task 2)
- Produces: 라우트 `/record`. 종료 시 `/meeting/:id`로 이동

**동작 규약 (스펙 §6·§4-①):**
- [녹음 시작] → `getUserMedia({audio:true})` → `createMeeting()` → `ChunkedRecorder.start()`(청크마다 `appendAudioChunk`) + Web Speech 가능 시 `WebSpeechEngine.start()` + wake lock enable
- final 텍스트 → `appendSegment({startSec: 직전 final의 endSec, endSec: 현재 경과초, source:'webspeech', isFinal:true})`
- Web Speech 미지원(ctor null) → "이 브라우저는 실시간 자막을 지원하지 않습니다(Chrome 권장). 녹음은 정상 저장됩니다." 안내 후 녹음만 진행
- getUserMedia 거부/실패 → 에러 메시지 표시, 아무것도 저장하지 않음
- [종료] → recorder.stop() → engine.stop() → wakeLock.disable() → `finishMeeting(id, 경과초)` → `/meeting/:id` 이동
- 기본 모드에서 "실시간 자막 사용 시 음성이 Google 서버로 전송됩니다" 고지 문구 상시 노출 (스펙 §4-① 프라이버시 고지)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ui/pages/Record.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Record from './Record'

function renderRecord() {
  return render(
    <MemoryRouter initialEntries={['/record']}>
      <Routes>
        <Route path="/record" element={<Record />} />
        <Route path="/meeting/:id" element={<div>회의록 페이지</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => vi.unstubAllGlobals())

test('마이크 권한 거부 시 에러 메시지를 보여준다', async () => {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
  })
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /녹음 시작/ }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/마이크/))
})

test('Web Speech 미지원 브라우저 안내가 보인다', () => {
  // jsdom에는 SpeechRecognition이 없으므로 기본 상태가 미지원
  renderRecord()
  expect(screen.getByText(/실시간 자막을 지원하지 않습니다/)).toBeInTheDocument()
})

test('시작 전에는 종료 버튼이 없다', () => {
  renderRecord()
  expect(screen.queryByRole('button', { name: /종료/ })).not.toBeInTheDocument()
})
```

(참고: 녹음 성공 경로의 완전한 통합 검증은 실 MediaRecorder가 필요해 Plan 3의 Playwright e2e — fake media stream — 에서 다룬다. 여기서는 실패 경로와 지원 감지 UI를 검증한다.)

- [ ] **Step 2: 실패 확인**

Run: `npm test -- Record` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 의존성 추가 및 구현**

```bash
npm install -D @testing-library/user-event
```

`src/App.tsx`의 Routes에 추가:
```tsx
import Record from './ui/pages/Record'
// ...
      <Route path="/record" element={<Record />} />
```

`src/ui/pages/Record.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createMeeting, appendAudioChunk, appendSegment, finishMeeting } from '../../core/store/meetings'
import { pickMimeType } from '../../core/recorder/mime'
import { ChunkedRecorder } from '../../core/recorder/chunkedRecorder'
import { createWakeLockManager } from '../../core/recorder/wakeLock'
import { getSpeechRecognitionCtor, WebSpeechEngine } from '../../core/stt/webSpeech'
import { formatTimestamp } from '../../core/format'

type Phase = 'idle' | 'recording' | 'stopping'

export default function Record() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [interim, setInterim] = useState('')
  const [finals, setFinals] = useState<string[]>([])
  const navigate = useNavigate()

  const sttCtor = getSpeechRecognitionCtor()

  const session = useRef<{
    meetingId: string
    recorder: ChunkedRecorder
    engine: WebSpeechEngine | null
    wakeLock: ReturnType<typeof createWakeLockManager>
    stream: MediaStream
    startedAt: number
    lastFinalEnd: number
    timer: ReturnType<typeof setInterval>
  } | null>(null)

  useEffect(() => () => { void cleanup() }, [])

  async function cleanup() {
    const s = session.current
    if (!s) return
    session.current = null
    clearInterval(s.timer)
    s.engine?.stop()
    await s.recorder.stop().catch(() => {})
    await s.wakeLock.disable()
    s.stream.getTracks().forEach(t => t.stop())
  }

  async function start() {
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('마이크를 사용할 수 없습니다. 브라우저 권한을 확인해주세요.')
      return
    }
    const meeting = await createMeeting()
    const mimeType = pickMimeType()
    const recorder = new ChunkedRecorder(stream, {
      onChunk: (blob, seq) => { void appendAudioChunk(meeting.id, seq, blob, mimeType ?? blob.type) },
      onStallRestart: () => setError('녹음이 잠시 끊겨 자동으로 재시작했습니다.'),
      onError: () => setError('녹음 장치 오류가 발생했습니다. 지금까지의 녹음은 저장되어 있습니다.'),
    }, { mimeType })

    const startedAt = Date.now()
    const elapsedSec = () => (Date.now() - startedAt) / 1000

    let engine: WebSpeechEngine | null = null
    if (sttCtor) {
      engine = new WebSpeechEngine(sttCtor, meeting.language, {
        onInterim: setInterim,
        onFinal: text => {
          const s = session.current
          if (!s) return
          const end = elapsedSec()
          void appendSegment({
            meetingId: s.meetingId, startSec: s.lastFinalEnd, endSec: end,
            text, source: 'webspeech', isFinal: true,
          })
          s.lastFinalEnd = end
          setFinals(prev => [...prev, text])
        },
        onStatus: () => {},
      })
    }

    const wakeLock = createWakeLockManager()
    const timer = setInterval(() => setElapsed(elapsedSec()), 1000)
    session.current = {
      meetingId: meeting.id, recorder, engine, wakeLock, stream,
      startedAt, lastFinalEnd: 0, timer,
    }
    recorder.start()
    engine?.start()
    await wakeLock.enable()
    setPhase('recording')
  }

  async function stop() {
    const s = session.current
    if (!s) return
    setPhase('stopping')
    const durationSec = Math.round((Date.now() - s.startedAt) / 1000)
    await cleanup()
    await finishMeeting(s.meetingId, durationSec)
    navigate(`/meeting/${s.meetingId}`)
  }

  return (
    <main>
      <h1>녹음</h1>
      {error && <div role="alert">{error}</div>}
      {!sttCtor && (
        <p>이 브라우저는 실시간 자막을 지원하지 않습니다(Chrome 권장). 녹음은 정상 저장됩니다.</p>
      )}
      {sttCtor && <p><small>실시간 자막 사용 시 음성이 Google 서버로 전송됩니다.</small></p>}
      {phase === 'idle' && <button onClick={() => void start()}>녹음 시작</button>}
      {phase === 'recording' && (
        <>
          <p>⏺ {formatTimestamp(elapsed)}</p>
          <button onClick={() => void stop()}>종료</button>
          <section aria-label="실시간 자막">
            {finals.map((t, i) => <p key={i}>{t}</p>)}
            {interim && <p style={{ color: 'gray' }}>{interim}</p>}
          </section>
        </>
      )}
      {phase === 'stopping' && <p>저장 중…</p>}
    </main>
  )
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- Record` → Expected: 3 passed
Run: `npm test` → Expected: 전체 통과

- [ ] **Step 5: 수동 스모크 (Chrome)**

Run: `npm run dev` → Chrome에서 `http://localhost:5173/#/record` 열기
확인: 녹음 시작 → 말하기 → 회색 interim → 검정 final 누적 → 종료 → (Task 11 전이므로) `/meeting/:id` 라우트 미존재로 홈 스타일 빈 화면이어도 콘솔 에러 없이 이동하면 OK

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/ui/pages/Record.tsx src/ui/pages/Record.test.tsx package.json package-lock.json
git commit -m "feat: 녹음 화면 — 청크 녹음과 실시간 전사 조립"
```

---

### Task 11: 회의록 뷰 (전사 보기·제목 편집·내보내기·오디오 다운로드)

**Files:**
- Modify: `src/App.tsx` (라우트 추가)
- Create: `src/ui/pages/Meeting.tsx`
- Test: `src/ui/pages/Meeting.test.tsx`

**Interfaces:**
- Consumes: `getMeeting`, `getSegments`, `getMeetingAudio`, `updateMeetingTitle` (Task 3), `toMarkdown`, `toPlainText`, `exportFilename`, `downloadBlob` (Task 8), `formatTimestamp` (Task 2)
- Produces: 라우트 `/meeting/:id`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ui/pages/Meeting.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { db } from '../../core/store/db'
import { createMeeting, finishMeeting, appendSegment, updateMeetingTitle } from '../../core/store/meetings'
import MeetingPage from './Meeting'

beforeEach(async () => {
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear()])
})

async function seed() {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 5, text: '첫 발언', source: 'webspeech', isFinal: true })
  await finishMeeting(m.id, 60)
  return m
}

function renderPage(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/meeting/${id}`]}>
      <Routes>
        <Route path="/meeting/:id" element={<MeetingPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

test('세그먼트가 타임스탬프와 함께 보인다', async () => {
  const m = await seed()
  renderPage(m.id)
  await waitFor(() => expect(screen.getByText('첫 발언')).toBeInTheDocument())
  expect(screen.getByText(/00:00/)).toBeInTheDocument()
})

test('제목을 편집하면 저장된다', async () => {
  const m = await seed()
  renderPage(m.id)
  await waitFor(() => screen.getByDisplayValue(m.title))
  const input = screen.getByDisplayValue(m.title)
  await userEvent.clear(input)
  await userEvent.type(input, '새 제목')
  await userEvent.tab() // blur → 저장
  await waitFor(async () => {
    expect((await db.meetings.get(m.id))?.title).toBe('새 제목')
  })
})

test('없는 회의는 안내 문구', async () => {
  renderPage('no-such-id')
  await waitFor(() => expect(screen.getByText(/회의록을 찾을 수 없습니다/)).toBeInTheDocument())
})

test('세그먼트가 없으면 빈 상태 안내', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 0)
  renderPage(m.id)
  await waitFor(() => expect(screen.getByText(/전사된 내용이 없습니다/)).toBeInTheDocument())
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- Meeting` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/App.tsx`의 Routes에 추가:
```tsx
import MeetingPage from './ui/pages/Meeting'
// ...
      <Route path="/meeting/:id" element={<MeetingPage />} />
```

`src/ui/pages/Meeting.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Meeting, TranscriptSegment } from '../../core/types'
import { getMeeting, getSegments, getMeetingAudio, updateMeetingTitle } from '../../core/store/meetings'
import { toMarkdown, toPlainText, exportFilename, downloadBlob } from '../../core/export/exporters'
import { formatTimestamp } from '../../core/format'

export default function MeetingPage() {
  const { id } = useParams<{ id: string }>()
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [title, setTitle] = useState('')

  useEffect(() => {
    if (!id) return
    void (async () => {
      const m = await getMeeting(id)
      setMeeting(m ?? null)
      if (m) {
        setTitle(m.title)
        setSegments((await getSegments(id)).filter(s => s.isFinal))
      }
    })()
  }, [id])

  if (meeting === undefined) return <main><p>불러오는 중…</p></main>
  if (meeting === null) return <main><p>회의록을 찾을 수 없습니다.</p><Link to="/">홈으로</Link></main>

  async function saveTitle() {
    if (!meeting || !title.trim() || title === meeting.title) return
    await updateMeetingTitle(meeting.id, title.trim())
    setMeeting({ ...meeting, title: title.trim() })
  }

  function exportAs(format: 'md' | 'txt') {
    if (!meeting) return
    const content = format === 'md' ? toMarkdown(meeting, segments) : toPlainText(meeting, segments)
    const type = format === 'md' ? 'text/markdown' : 'text/plain'
    downloadBlob(exportFilename(meeting, format), new Blob([content], { type }))
  }

  async function downloadAudio() {
    if (!meeting) return
    const blob = await getMeetingAudio(meeting.id)
    if (!blob) return
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
    downloadBlob(exportFilename(meeting, ext), blob)
  }

  return (
    <main>
      <p><Link to="/">← 홈</Link></p>
      <input value={title} onChange={e => setTitle(e.target.value)} onBlur={() => void saveTitle()} aria-label="회의 제목" />
      <p>길이: {formatTimestamp(meeting.durationSec)}</p>
      <p>
        <button onClick={() => exportAs('md')}>Markdown 내보내기</button>{' '}
        <button onClick={() => exportAs('txt')}>TXT 내보내기</button>{' '}
        <button onClick={() => void downloadAudio()}>오디오 다운로드</button>
      </p>
      {segments.length === 0 ? (
        <p>전사된 내용이 없습니다. (실시간 자막 미지원 환경에서 녹음된 회의는 Plan 2의 파일 전사로 처리할 수 있습니다)</p>
      ) : (
        <section>
          {segments.map(s => (
            <p key={s.id}>
              <small>[{formatTimestamp(s.startSec)}]</small> {s.text}
            </p>
          ))}
        </section>
      )}
    </main>
  )
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- Meeting` → Expected: 4 passed
Run: `npm test` → Expected: 전체 통과

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/ui/pages/Meeting.tsx src/ui/pages/Meeting.test.tsx
git commit -m "feat: 회의록 뷰 — 전사 보기·제목 편집·내보내기"
```

---

### Task 12: 엔드투엔드 수동 검증 + README + 배포 준비

**Files:**
- Create: `README.md`
- Modify: 없음 (검증 위주)

**Interfaces:**
- Consumes: 전체 앱
- Produces: 배포 가능한 `dist/`, Cloudflare Pages 연결 절차 문서

- [ ] **Step 1: 전체 테스트·빌드·산출물 크기 확인**

```bash
npm test          # Expected: 전체 통과
npm run build     # Expected: 에러 없음
find dist -size +20M   # Expected: 출력 없음 (25MiB 제한 여유 확인)
```

- [ ] **Step 2: Chrome 수동 E2E (스펙 §6 크래시 복구 포함)**

`npm run preview` 후 Chrome에서:
1. 녹음 시작 → 10초 이상 말하기 → 실시간 자막 확인 → 종료 → 회의록 뷰에서 세그먼트·타임스탬프 확인
2. Markdown/TXT 내보내기 파일 내용 확인, 오디오 다운로드 재생 확인
3. **크래시 복구**: 녹음 시작 → 15초 후 탭 강제 닫기 → 재접속 → 홈에 "복구할 녹음" 배너 → 복구 → 오디오 다운로드로 저장분 확인
4. 홈 저장 용량 표시 확인

- [ ] **Step 3: README 작성**

`README.md`:
```markdown
# MinuteFlow — 브라우저에서 완결되는 음성 회의록

서버 없이 동작하는 음성 회의록 웹앱. 녹음·전사·저장이 모두 브라우저 안에서
이루어지며, 데이터는 이 기기의 브라우저(IndexedDB)에만 저장됩니다.

## 현재 기능 (v1 core)

- 실시간 녹음 + 실시간 자막 (Chrome, Web Speech API)
- 10초 단위 증분 저장 — 탭이 죽어도 그 시점까지 복구
- 회의록 보기·제목 편집·Markdown/TXT 내보내기·원본 오디오 다운로드

로드맵: 파일 업로드 전사(브라우저 Whisper·Groq BYOK), AI 요약(Gemini BYOK),
PWA. 설계: `docs/superpowers/specs/2026-07-06-minuteflow-design.md`

## 개발

```bash
npm install
npm run dev    # 개발 서버
npm test       # 테스트
npm run build  # 정적 빌드 → dist/
```

## 배포 (Cloudflare Pages, 무료)

1. Cloudflare 대시보드 → Workers & Pages → Create → Pages → Connect to Git
2. `gum798/MinuteFlow` 선택
3. Build command: `npm run build`, Build output directory: `dist`
4. Save and Deploy → `https://<project>.pages.dev`

정적 자산만 사용하므로(Functions 없음) 요청·대역폭 무료·무제한입니다.
```

- [ ] **Step 4: Commit + Push**

```bash
git add README.md
git commit -m "docs: README 및 Cloudflare Pages 배포 안내"
git push -u origin main   # 사용자에게 push 진행을 먼저 확인할 것
```

- [ ] **Step 5: 배포 연결은 사용자 액션**

Cloudflare Pages 연결(README §배포 1~4)은 대시보드 로그인이 필요하므로 사용자에게 안내하고 종료.

---

## Self-Review 결과 (작성자 체크)

1. **스펙 커버리지**: 이 플랜은 스펙 §3(정적 아키텍처·모듈 경계), §4-①(Web Speech 재시작 루프·미지원 안내·프라이버시 고지), §6(timeslice·워치독·Wake Lock·코덱 폴백·크래시 복구), §8(스키마·홈/녹음/회의록 뷰), §10(vitest 유닛) 커버. §4-②③(Whisper/Groq)·§5(요약)·§7(업로드)·§8(업로드/설정 화면)·§9(기능 감지 매트릭스)·§10(Playwright)·§11(배포 자동화 세부)은 Plan 2/3 범위로 명시적 이월.
2. **플레이스홀더 스캔**: TBD/TODO 없음. 모든 코드 스텝에 실제 코드 포함.
3. **타입 일관성 확인**: `ChunkedRecorderEvents.onStallRestart`(Task 5 정의 = Task 10 사용), `WebSpeechEvents.onInterim/onFinal/onStatus`(Task 7 = Task 10), `appendAudioChunk(meetingId, seq, blob, mimeType)`(Task 3 = Task 10), `exportFilename/downloadBlob`(Task 8 = Task 11) 시그니처 일치 확인함. `AudioChunk.data: ArrayBuffer`는 Global Constraints에 근거 명시.
