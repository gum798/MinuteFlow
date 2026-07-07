# MinuteFlow Plan 4 — AI 요약(Gemini BYOK) + DOCX + PWA + e2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의록에서 [AI 요약] 버튼으로 Gemini(내 키) 요약을 생성·저장하고, 키가 없어도 "AI 프롬프트 복사"로 가치를 제공한다. DOCX 내보내기, PWA 설치·오프라인, Playwright e2e까지 마감한다.

**Architecture:** `core/summarize/*` 신설(프롬프트 빌더 순수 함수 + Gemini raw fetch 클라이언트), summaries 스토어 함수(테이블은 Plan 1 스키마에 이미 존재), Meeting UI 요약 카드. DOCX는 `docx` npm. PWA는 `vite-plugin-pwa`(모델 캐시는 transformers.js의 Cache API가 담당하므로 SW는 앱 셸만). e2e는 Playwright(chromium, fake 마이크) 로컬 실행.

**Tech Stack:** 기존 + `docx`, `vite-plugin-pwa`(dev), `@playwright/test`(dev), sharp(이미 transitive — 아이콘 생성 스크립트용)

**참조 (필수 열람):** `docs/research/2026-07-07-plan2-apis.md`의 "Gemini generateContent (2026-07-07 재검증)" 섹션 — 모델 ID·에러 시맨틱이 여기 verbatim. 스펙 §5(요약), §8(내보내기).

## Global Constraints

- **Gemini 모델: `gemini-3.5-flash`** (검증됨 — 2.0 계열은 종료라 금지). 엔드포인트/헤더/추출 경로는 리서치 문서 verbatim
- **에러 분기 (실측 시맨틱)**: HTTP **400 + reason 'API_KEY_INVALID' = 키 오류** (401 아님), 403 = 권한, 429 = 한도 — 대기값은 응답 바디 `error.details[]`의 `retryDelay`("30s") 파싱, 1회 재시도. candidates 부재 시 안전필터 안내
- 응답 텍스트: `candidates[0].content.parts.map(p => p.text).join('')`
- 설정: `AppSettings.geminiApiKey: string` 추가 (기본 ''). Gemini 키 카드는 **항상 노출** (Groq와 달리 — 요약은 공개 기능). "이 브라우저에만 저장" 원칙 동일
- 키 없으면 [AI 프롬프트 복사]: 프롬프트 전문을 `navigator.clipboard.writeText` → 토스트. 클립보드 실패 시 alert로 폴백
- 템플릿 3종 `'minutes' | 'brief' | 'timeline'` (Summary 타입에 이미 정의됨) — 기본 'minutes', 셀렉트로 변경
- 요약 프롬프트에 화자 이름 반영 (speakerNames 치환)
- PWA: 앱 셸만 프리캐시 (모델/오디오는 SW 대상 아님 — transformers.js Cache API·IndexedDB가 담당). `registerType: 'autoUpdate'`. 배포 산출물 파일당 25MiB 준수 유지
- e2e는 로컬 실행 (`npm run e2e`) — Pages 빌드에 포함 금지 (playwright는 devDependency)
- UI 한국어·theme 클래스·심플 원칙(세부는 숨김), TDD, conventional commits

## File Structure

```
src/core/settings.ts               수정: geminiApiKey
src/core/summarize/prompts.ts      신규: 템플릿 프롬프트 빌더 (순수)
src/core/summarize/gemini.ts       신규: generateContent 클라이언트
src/core/store/meetings.ts         수정: saveSummary, getSummaries
src/core/export/docx.ts            신규: DOCX 생성
src/ui/pages/Settings.tsx          수정: Gemini 키 카드
src/ui/pages/Meeting.tsx           수정: 요약 섹션 + DOCX 버튼
vite.config.ts                     수정: vite-plugin-pwa
public/icons/…                     신규: PWA 아이콘 (생성 스크립트)
scripts/gen-icons.mjs              신규: sharp로 아이콘 렌더
e2e/record.spec.ts                 신규: Playwright
playwright.config.ts               신규
```

---

### Task 1: 설정 확장 + 요약 프롬프트 빌더

**Files:**
- Modify: `src/core/settings.ts` (+ 테스트 1개 추가)
- Create: `src/core/summarize/prompts.ts`
- Test: `src/core/summarize/prompts.test.ts`

**Interfaces:**
- `AppSettings`에 `geminiApiKey: string` (DEFAULTS `''`) — 기존 테스트의 `toEqual` 기본값 단언에 필드 추가 필요
- `prompts.ts`:
  - `type SummaryTemplate = 'minutes' | 'brief' | 'timeline'`
  - `TEMPLATE_LABELS: Record<SummaryTemplate, string>` — `{ minutes: '회의록', brief: '짧은 요약', timeline: '타임라인' }`
  - `buildSummaryPrompt(template: SummaryTemplate, meeting: Meeting, segments: TranscriptSegment[]): string` — 전사문을 `[MM:SS] (화자표시명) 텍스트` 줄로 직렬화(화자 없으면 생략), 템플릿별 지시문 결합. 빈 세그먼트면 빈 전사 안내 포함하지 않고 그냥 지시문+빈 본문 (호출측이 막음)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/settings.test.ts`에 추가:
```ts
test('geminiApiKey 기본값과 저장', () => {
  expect(loadSettings().geminiApiKey).toBe('')
  saveSettings({ geminiApiKey: 'AIza_test' })
  expect(loadSettings().geminiApiKey).toBe('AIza_test')
})
```
(기존 '저장된 값이 없으면 기본값' 테스트의 `toEqual` 객체에 `geminiApiKey: ''` 추가)

`src/core/summarize/prompts.test.ts`:
```ts
import { buildSummaryPrompt, TEMPLATE_LABELS } from './prompts'
import type { Meeting, TranscriptSegment } from '../types'

const meeting: Meeting = {
  id: 'm1', title: '주간회의', createdAt: 0, durationSec: 600, status: 'done',
  language: 'ko-KR', speakerNames: { SPK1: '김팀장' },
}
const segments: TranscriptSegment[] = [
  { meetingId: 'm1', startSec: 0, endSec: 5, text: '시작합니다', source: 'whisper', isFinal: true, speaker: 'SPK1' },
  { meetingId: 'm1', startSec: 65, endSec: 70, text: '네 알겠습니다', source: 'whisper', isFinal: true, speaker: 'SPK2' },
  { meetingId: 'm1', startSec: 80, endSec: 85, text: '무화자 발언', source: 'whisper', isFinal: true },
]

test('전사문이 타임스탬프·화자 이름과 함께 직렬화된다', () => {
  const p = buildSummaryPrompt('minutes', meeting, segments)
  expect(p).toContain('[00:00] (김팀장) 시작합니다')   // speakerNames 치환
  expect(p).toContain('[01:05] (SPK2) 네 알겠습니다')  // 미치환 라벨 그대로
  expect(p).toContain('[01:20] 무화자 발언')           // 화자 없으면 괄호 생략
  expect(p).toContain('주간회의')
})

test('템플릿별 지시문이 다르다', () => {
  const minutes = buildSummaryPrompt('minutes', meeting, segments)
  const brief = buildSummaryPrompt('brief', meeting, segments)
  const timeline = buildSummaryPrompt('timeline', meeting, segments)
  expect(minutes).toContain('결정사항')
  expect(minutes).toContain('액션아이템')
  expect(brief).toContain('3~5문장')
  expect(timeline).toContain('시간순')
  expect(new Set([minutes, brief, timeline]).size).toBe(3)
})

test('TEMPLATE_LABELS', () => {
  expect(TEMPLATE_LABELS.minutes).toBe('회의록')
})
```

- [ ] **Step 2: 실패 확인** — `npm test -- prompts` → FAIL

- [ ] **Step 3: 구현**

`src/core/settings.ts`: `AppSettings`에 `geminiApiKey: string`, DEFAULTS에 `geminiApiKey: ''`.

`src/core/summarize/prompts.ts`:
```ts
import type { Meeting, TranscriptSegment } from '../types'
import { formatTimestamp } from '../format'

export type SummaryTemplate = 'minutes' | 'brief' | 'timeline'

export const TEMPLATE_LABELS: Record<SummaryTemplate, string> = {
  minutes: '회의록',
  brief: '짧은 요약',
  timeline: '타임라인',
}

const INSTRUCTIONS: Record<SummaryTemplate, string> = {
  minutes: `아래 회의 전사문을 바탕으로 한국어 회의록을 Markdown으로 작성해줘. 구성:
## 안건
## 논의 요지
## 결정사항
## 액션아이템 (담당자가 언급됐으면 함께)
전사문에 없는 내용은 지어내지 마.`,
  brief: `아래 회의 전사문을 한국어 3~5문장으로 요약해줘. 핵심 결론 위주로.`,
  timeline: `아래 회의 전사문을 시간순 타임라인으로 정리해줘. Markdown 목록으로, 각 항목은 "- **[MM:SS]** 내용" 형식.`,
}

export function buildSummaryPrompt(
  template: SummaryTemplate, meeting: Meeting, segments: TranscriptSegment[],
): string {
  const lines = segments.filter(s => s.isFinal).map(s => {
    const ts = `[${formatTimestamp(s.startSec)}]`
    const name = s.speaker ? ` (${meeting.speakerNames?.[s.speaker] ?? s.speaker})` : ''
    return `${ts}${name} ${s.text}`
  })
  return [
    INSTRUCTIONS[template],
    '',
    `회의 제목: ${meeting.title}`,
    `길이: ${formatTimestamp(meeting.durationSec)}`,
    '',
    '--- 전사문 ---',
    ...lines,
  ].join('\n')
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- prompts && npm test -- settings` → 통과 (기존 settings 기본값 단언 갱신 포함)
- [ ] **Step 5: Commit** — `feat: 요약 프롬프트 빌더 및 Gemini 키 설정 필드`

---

### Task 2: Gemini 클라이언트

**Files:**
- Create: `src/core/summarize/gemini.ts`
- Test: `src/core/summarize/gemini.test.ts`

**Interfaces:**
- `summarizeWithGemini(prompt: string, apiKey: string, opts?: { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<string>`
- 규약: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`, 헤더 `x-goog-api-key` + `Content-Type: application/json`, body `{ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }`
- 에러 (리서치 실측 시맨틱): 400이고 바디의 `error.details` 중 `reason === 'API_KEY_INVALID'` → `'Gemini API 키를 확인해주세요. (설정에서 재등록)'`; 403 → `'API 키 권한을 확인해주세요.'`; 429 → 바디 `error.details[]`에서 `retryDelay`("30s") 파싱해 그 초만큼 대기 후 **1회 재시도**(파싱 실패 시 15초), 재실패 시 `'무료 사용량을 잠시 초과했습니다. 잠시 후 다시 시도해주세요.'`; candidates 비면 `'안전 필터로 요약이 차단되었습니다.'`
- 성공: `candidates[0].content.parts.map(p => p.text).join('')`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/summarize/gemini.test.ts`:
```ts
import { summarizeWithGemini } from './gemini'

function ok(text: string) {
  return new Response(JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: '## 요약\n' }, { text }] }, finishReason: 'STOP' }],
  }), { status: 200 })
}

test('요청 형식과 다중 parts 결합', async () => {
  const fetchFn = vi.fn(async () => ok('본문'))
  const out = await summarizeWithGemini('프롬프트', 'AIza_1', { fetchFn: fetchFn as unknown as typeof fetch })
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent')
  const headers = init.headers as Record<string, string>
  expect(headers['x-goog-api-key']).toBe('AIza_1')
  expect(headers['Content-Type']).toBe('application/json')
  const body = JSON.parse(init.body as string)
  expect(body.contents[0].parts[0].text).toBe('프롬프트')
  expect(out).toBe('## 요약\n본문')
})

test('400 API_KEY_INVALID는 키 오류로', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({
    error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] },
  }), { status: 400 }))
  await expect(summarizeWithGemini('p', 'bad', { fetchFn: fetchFn as unknown as typeof fetch }))
    .rejects.toThrow(/API 키/)
})

test('429는 retryDelay만큼 대기 후 1회 재시도', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' }] },
    }), { status: 429 }))
    .mockResolvedValueOnce(ok('성공'))
  const sleeps: number[] = []
  const out = await summarizeWithGemini('p', 'k', {
    fetchFn: fetchFn as unknown as typeof fetch, sleep: async ms => { sleeps.push(ms) },
  })
  expect(sleeps).toEqual([3000])
  expect(out).toBe('## 요약\n성공')
})

test('candidates가 없으면 안전 필터 안내', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }))
  await expect(summarizeWithGemini('p', 'k', { fetchFn: fetchFn as unknown as typeof fetch }))
    .rejects.toThrow(/안전 필터/)
})
```

- [ ] **Step 2: 실패 확인** — `npm test -- gemini` → FAIL

- [ ] **Step 3: 구현**

`src/core/summarize/gemini.ts`:
```ts
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface GeminiError {
  error?: { code?: number; status?: string; details?: { reason?: string; retryDelay?: string }[] }
}

function parseRetryMs(body: GeminiError): number {
  const raw = body.error?.details?.find(d => d.retryDelay)?.retryDelay
  const sec = raw ? Number.parseFloat(raw) : NaN
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 15_000
}

async function requestOnce(prompt: string, apiKey: string, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 },
    }),
  })
}

export async function summarizeWithGemini(
  prompt: string, apiKey: string,
  opts: { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch
  let res = await requestOnce(prompt, apiKey, fetchFn)
  if (res.status === 429) {
    const body = (await res.json()) as GeminiError
    await (opts.sleep ?? defaultSleep)(parseRetryMs(body))
    res = await requestOnce(prompt, apiKey, fetchFn)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as GeminiError
    const reason = body.error?.details?.find(d => d.reason)?.reason
    if (res.status === 400 && reason === 'API_KEY_INVALID')
      throw new Error('Gemini API 키를 확인해주세요. (설정에서 재등록)')
    if (res.status === 403) throw new Error('API 키 권한을 확인해주세요.')
    if (res.status === 429) throw new Error('무료 사용량을 잠시 초과했습니다. 잠시 후 다시 시도해주세요.')
    throw new Error(`요약 요청 실패 (${res.status})`)
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const parts = data.candidates?.[0]?.content?.parts
  if (!parts || parts.length === 0) throw new Error('안전 필터로 요약이 차단되었습니다. 내용을 확인해주세요.')
  return parts.map(p => p.text ?? '').join('')
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- gemini` → 4 passed
- [ ] **Step 5: Commit** — `feat: Gemini 요약 클라이언트`

---

### Task 3: summaries 스토어

**Files:**
- Modify: `src/core/store/meetings.ts` (+ 테스트 2개)

**Interfaces:**
- `saveSummary(meetingId: string, template: Summary['template'], markdown: string, provider: string): Promise<void>` — 같은 (meetingId, template) 기존 요약 삭제 후 삽입 (템플릿당 최신 1개, 트랜잭션)
- `getSummaries(meetingId: string): Promise<Summary[]>` — createdAt 내림차순

**테스트:**
```ts
test('saveSummary는 템플릿당 최신 1개만 유지한다', async () => {
  const m = await createMeeting()
  await saveSummary(m.id, 'minutes', '# 첫번째', 'gemini-3.5-flash')
  await saveSummary(m.id, 'minutes', '# 두번째', 'gemini-3.5-flash')
  await saveSummary(m.id, 'brief', '짧은', 'gemini-3.5-flash')
  const sums = await getSummaries(m.id)
  expect(sums).toHaveLength(2)
  expect(sums.find(s => s.template === 'minutes')?.markdown).toBe('# 두번째')
})

test('getSummaries는 다른 회의를 섞지 않는다', async () => {
  const a = await createMeeting(); const b = await createMeeting()
  await saveSummary(a.id, 'brief', 'A', 'x')
  await saveSummary(b.id, 'brief', 'B', 'x')
  expect((await getSummaries(a.id)).map(s => s.markdown)).toEqual(['A'])
})
```

**구현** (meetings.ts 추가):
```ts
export async function saveSummary(
  meetingId: string, template: Summary['template'], markdown: string, provider: string,
): Promise<void> {
  await db.transaction('rw', [db.summaries], async () => {
    const olds = await db.summaries.where('meetingId').equals(meetingId).toArray()
    const dup = olds.filter(s => s.template === template).map(s => s.id!)
    if (dup.length) await db.summaries.bulkDelete(dup)
    await db.summaries.add({ meetingId, template, markdown, provider, createdAt: Date.now() })
  })
}

export async function getSummaries(meetingId: string): Promise<Summary[]> {
  const rows = await db.summaries.where('meetingId').equals(meetingId).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}
```
(`Summary` 타입 import 추가)

- [ ] Step 1-4: RED → 구현 → GREEN → Commit — `feat: 요약 저장·조회`

---

### Task 4: 설정 — Gemini 키 카드

**Files:**
- Modify: `src/ui/pages/Settings.tsx` (+ 테스트 1개)

**규약:** Groq 카드와 별개로 **항상 노출**되는 카드 (고급 접기 밖, 최상단 키 카드 자리): 제목 `AI 요약 키 (Gemini)`, 문구 `무료로 발급받아 넣으면 회의록 AI 요약을 쓸 수 있어요.` + [Google AI Studio](https://aistudio.google.com/apikey) 링크, password input(label `Gemini API 키`), 기존 [저장] 버튼이 함께 저장 (form state에 geminiApiKey 추가). Groq 카드는 GROQ_ENABLED 게이트 그대로.

**테스트:**
```ts
test('Gemini 키를 저장하면 설정에 반영된다', async () => {
  renderPage()
  await userEvent.type(screen.getByLabelText(/Gemini API 키/), 'AIza_x')
  await userEvent.click(screen.getByRole('button', { name: /저장/ }))
  await waitFor(() => expect(loadSettings().geminiApiKey).toBe('AIza_x'))
})
```
(flagOff 테스트의 'Groq 없음' 단언과 충돌 주의 — `queryByText(/Groq/)` 전면 단언이 있으면 Gemini 카드 문구에 Groq가 없으므로 무영향 확인)

- [ ] Step 1-4: RED → 구현 → GREEN (기존 Settings·flagOff 테스트 유지) → Commit — `feat: 설정에 Gemini 요약 키 카드`

---

### Task 5: Meeting UI — AI 요약 섹션

**Files:**
- Modify: `src/ui/pages/Meeting.tsx` (+ 테스트 3개)

**동작 규약 (심플 원칙):**
- 세그먼트 있을 때 전사 카드 위에 **요약 섹션**: 저장된 요약 있으면 `.card`로 표시(템플릿 라벨 배지 + markdown은 `<pre>`가 아닌 줄바꿈 유지 `<div style={{whiteSpace:'pre-wrap'}}>` 렌더 — 별도 md 렌더러 의존성 금지)
- 버튼 줄에 추가: 템플릿 `<select className="input" style={{width:'auto'}}>`(기본 minutes, TEMPLATE_LABELS) + **키 있으면** [AI 요약] `.btn-primary .btn-sm`(진행 중 라벨 교체+disabled, 다른 오디오 작업과 상호 배타 불필요 — 텍스트만 사용) / **키 없으면** [AI 프롬프트 복사] `.btn-outline .btn-sm` — `navigator.clipboard.writeText(buildSummaryPrompt(...))` 성공 시 토스트 `복사했어요! AI 채팅에 붙여넣어 주세요.`(2초), 실패 시 `window.alert`
- [AI 요약] 흐름: `buildSummaryPrompt(template, meeting, segments)` → `summarizeWithGemini(prompt, settings.geminiApiKey)` → `saveSummary` → 요약 목록 재로드. 실패 alert
- 요약은 내보내기에도 반영: **md 내보내기에만** 요약 섹션 추가 — `toMarkdown` 시그니처를 `toMarkdown(meeting, segments, summaries?: Summary[])`로 확장 (optional — 기존 호출 무영향), 요약 있으면 `## AI 요약 (회의록)` 섹션들로 앞부분에 삽입. exporters 테스트 1개 추가

**테스트 3개:**
1. 키 없음 → [AI 프롬프트 복사] 버튼, 클릭 시 clipboard mock에 프롬프트 기록 + 토스트
2. 키 있음(saveSettings) + summarizeWithGemini mock → [AI 요약] 클릭 → 요약 카드 텍스트 표시 + db.summaries에 저장
3. 저장된 요약이 마운트 시 로드되어 보임

- [ ] Step 1-4: RED → 구현 → GREEN (기존 Meeting 테스트 12개 유지) → Commit — `feat: 회의록 AI 요약 — 생성·프롬프트 복사·내보내기 반영`

---

### Task 6: DOCX 내보내기

**Files:**
- Create: `src/core/export/docx.ts`
- Modify: `src/ui/pages/Meeting.tsx` ([DOCX] 버튼)
- Test: `src/core/export/docx.test.ts`

**Interfaces:**
- `npm install docx`
- `toDocxBlob(meeting: Meeting, segments: TranscriptSegment[], summaries: Summary[]): Promise<Blob>` — 제목(Heading1) + 메타(일시·길이) + 요약 섹션(있으면, Heading2 + 문단) + 전사(각 세그먼트: `[MM:SS] 화자명 — 텍스트` 문단). docx의 `Document`/`Packer.toBlob` 사용
- Meeting 버튼 줄에 [DOCX 내보내기] `.btn-outline .btn-sm` — `downloadBlob(exportFilename(meeting, 'docx'), await toDocxBlob(...))`

**테스트** (node에서 docx 실생성):
```ts
test('DOCX Blob이 생성된다', async () => {
  const blob = await toDocxBlob(meeting, segments, [])
  expect(blob.size).toBeGreaterThan(1000)
  expect(blob.type).toContain('officedocument')
})
```
(+ 요약 포함 시 크기 증가 단언 1개)

- [ ] Step 1-4: RED → 구현 → GREEN + `npm run build` (docx 번들 크기 확인 — 청크 분리 필요 시 dynamic import `const { toDocxBlob } = await import('../../core/export/docx')`로 버튼 클릭 시 로드) → Commit — `feat: DOCX 내보내기`

---

### Task 7: PWA

**Files:**
- Modify: `vite.config.ts`, `index.html`(theme-color 메타), `.gitignore`(dev-dist)
- Create: `scripts/gen-icons.mjs`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/maskable-512.png`

**규약:**
- `npm install -D vite-plugin-pwa`
- 아이콘: `scripts/gen-icons.mjs` — node_modules의 sharp로 SVG(라운드 사각 `#1E43B8` 배경 + 흰 'M') → PNG 3종 렌더. 스크립트 실행해 커밋 (빌드 파이프라인에 넣지 않음 — 1회 생성물)
```js
// scripts/gen-icons.mjs — node scripts/gen-icons.mjs
import sharp from 'sharp'
const svg = (pad) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
     <rect width="512" height="512" rx="${pad ? 0 : 96}" fill="#1E43B8"/>
     <text x="256" y="340" font-family="Arial, sans-serif" font-size="280" font-weight="800"
           fill="#fff" text-anchor="middle">M</text>
   </svg>`)
await sharp(svg(false)).resize(192, 192).png().toFile('public/icons/icon-192.png')
await sharp(svg(false)).resize(512, 512).png().toFile('public/icons/icon-512.png')
await sharp(svg(true)).resize(512, 512).png().toFile('public/icons/maskable-512.png')
console.log('icons generated')
```
- vite.config.ts:
```ts
import { VitePWA } from 'vite-plugin-pwa'
// plugins에 추가:
VitePWA({
  registerType: 'autoUpdate',
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png}'],
    globIgnores: ['**/*.wasm'],           // onnxruntime wasm 22.5MiB — 프리캐시 제외 (Workbox 기본 2MiB 상한도 초과)
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    navigateFallback: 'index.html',
  },
  manifest: {
    name: 'MinuteFlow — 음성 회의록',
    short_name: 'MinuteFlow',
    description: '브라우저에서 완결되는 음성 회의록 — 녹음·전사·화자 구분·요약',
    lang: 'ko',
    start_url: '/',
    display: 'standalone',
    background_color: '#F4F5F9',
    theme_color: '#1E43B8',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
})
```
- `index.html` head에 `<meta name="theme-color" content="#1E43B8" />`
- `.gitignore`에 `dev-dist/` 추가
- 검증: `npm run build` 후 `dist/manifest.webmanifest`와 `dist/sw.js` 존재, `find dist -size +24M` 무출력 유지, `npm test` 전체 통과 (vitest는 SW 미개입)

- [ ] Step 1-3: 아이콘 생성 → 설정 → 빌드 검증 → Commit — `feat: PWA — 설치 매니페스트·서비스 워커·앱 아이콘`

---

### Task 8: Playwright e2e

**Files:**
- Create: `playwright.config.ts`, `e2e/record.spec.ts`
- Modify: `package.json` (scripts: `"e2e": "playwright test"`), `.gitignore` (playwright-report, test-results)

**규약:**
- `npm install -D @playwright/test && npx playwright install chromium`
- config: `webServer: { command: 'npm run preview', port: 4173, reuseExistingServer: true }`, use.baseURL `http://localhost:4173`, chromium 단일 프로젝트, `launchOptions.args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']` + `contextOptions.permissions: ['microphone']`
- `e2e/record.spec.ts` 2개 테스트:
  1. **녹음→저장→회의록**: `/#/record?autostart=1` 접속(즉시 녹음) → 경과시간 `⏺` 표시 대기 → 12초 대기(청크 1개 확보) → [종료] 클릭 → `/#/meeting/` URL 대기 → [오디오 다운로드] 버튼 존재 확인
  2. **크래시 복구**: 녹음 시작 → 12초 → `page.reload()` (종료 없이) → 홈 이동 → `복구할 녹음` 배너 노출 → [복구] 클릭 → 회의록 페이지 도달
- e2e는 `npm test`(vitest)와 분리 — vitest가 e2e 디렉터리를 집지 않도록 vite.config test.exclude에 `'e2e/**'` 추가
- 실행·통과 확인 후 커밋 (로컬 chromium 필요 — 다운로드 실패 시 BLOCKED 보고)

- [ ] Step 1-3: 설치 → 테스트 작성 → `npm run e2e` 통과 → Commit — `test: Playwright e2e — 녹음·복구 플로우`

---

### Task 9: 검증 + README + 스펙 마감

- [ ] `npm test` 전체, `npm run e2e`, `npm run build`, `find dist -size +24M` 무출력
- [ ] README: 기능에 AI 요약(BYOK — 키는 브라우저에만)·DOCX·PWA 설치 추가, 로드맵 섹션 제거(전 플랜 완료) — 대신 `## 데이터·프라이버시` 한 단락 (모든 데이터 로컬, BYOK 키 브라우저만, Whisper·화자구분 온디바이스)
- [ ] 스펙 §15 로드맵 표: Plan 4 행 `구현 완료`
- [ ] Commit — `docs: Plan 4 마감 — README·스펙 갱신`

---

## Self-Review 결과 (작성자 체크)

1. **스펙 커버리지**: §5 요약(템플릿 3종·프롬프트 빌더 순수 함수·키 없으면 프롬프트 복사·키 등록 UI 문구) Task 1·2·4·5 — 단 OpenRouter 폴백은 스펙대로 v1 미구현(인터페이스만 단순 유지). §8 내보내기 docx Task 6, PWA Task 7. Playwright(§10) Task 8. 기능감지 매트릭스(§9)는 기존 인라인 안내로 갈음 — 스펙 §9 원문과의 차이는 Task 9에서 스펙에 각주 추가하지 않고 유지(현 UX가 심플 원칙에 부합, Edge probe는 마이크 권한을 선요구해 역효과)
2. **플레이스홀더**: 없음. Task 5·6 UI는 규약+시그니처 수준(기존 패턴 반복), 나머지 코드 전문
3. **타입 일관성**: `SummaryTemplate`=`Summary['template']`(기존 types.ts와 동일 리터럴), `buildSummaryPrompt`(1→5), `summarizeWithGemini`(2→5), `saveSummary/getSummaries`(3→5·6), `toMarkdown` optional 3번째 인자(5 — 기존 호출 무영향), `toDocxBlob`(6). settings 기본값 단언 갱신은 Task 1에 명시
4. **리스크**: docx 번들 크기(동적 import 지침 포함), Playwright 로컬 chromium 다운로드(실패 시 BLOCKED), Gemini 실호출은 배포 후 사용자 키로 실측
