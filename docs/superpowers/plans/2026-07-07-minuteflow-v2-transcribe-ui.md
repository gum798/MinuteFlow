# MinuteFlow Plan 2 — UI 리스타일 + 파일 업로드 전사 (Whisper 로컬·Groq BYOK) + 설정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** minutelog 디자인 언어로 전면 리스타일하고, 녹음 파일 업로드를 브라우저 내 Whisper(WebGPU) 또는 Groq BYOK로 전사하는 기능을 추가한다.

**Architecture:** Plan 1의 `core/*`/`ui/*` 경계 유지. 신규 `core/audio`(16kHz 디코딩·WAV 인코딩·분할), `core/stt/whisperLocal`(Web Worker), `core/stt/groq`(직접 fetch), `core/settings`(localStorage). UI는 CSS 커스텀 프로퍼티 테마(`ui/theme.css`) + 사이드바 앱 셸로 재구성.

**Tech Stack:** 기존(React 19, TS strict, Vite, Dexie, vitest) + `@huggingface/transformers` v4.

**참조 문서 (구현 시 필수 열람):**
- 검증된 API 패턴: `docs/research/2026-07-07-plan2-apis.md` — transformers.js/Groq/디코딩 코드가 이 문서의 verbatim 패턴을 따름
- 디자인 토큰: `docs/design/design-tokens.md` — 모든 색·크기·컴포넌트 스타일의 단일 출처
- 스펙: `docs/superpowers/specs/2026-07-06-minuteflow-design.md` §4-②③, §7, §8, §14

## Global Constraints

- **순수 정적**: 서버 코드·Pages Functions 금지. 외부 호출은 HuggingFace CDN(모델)과 `api.groq.com`(사용자 키) 뿐
- **배포 산출물 파일당 25MiB 미만** — Whisper 모델은 번들에 포함하지 않음 (transformers.js가 HF CDN에서 런타임 로드, Cache API 자동 캐시)
- TypeScript strict, TDD, conventional commits, UI 문구 한국어
- Whisper 모델: WebGPU 시 `onnx-community/whisper-large-v3-turbo` (dtype `{encoder_model:'fp16', decoder_model_merged:'q4'}`), WASM 폴백 시 `onnx-community/whisper-base` (dtype `'q8'`)
- Whisper 호출 옵션: `{ language, chunk_length_s: 30, stride_length_s: 5, return_timestamps: true }`
- Groq: `https://api.groq.com/openai/v1/audio/transcriptions`, model `whisper-large-v3-turbo`, `response_format=verbose_json`. **FormData 사용 시 Content-Type 헤더 직접 지정 금지**. 파일 25MB 제한 — 초과 시 16kHz mono 16-bit WAV 세그먼트(750초 = 24MB)로 분할
- 디코딩: `new AudioContext({sampleRate:16000})` 통디코딩, 스테레오는 `(L+R)×√2/2` 다운믹스, `sampleRate !== 16000`이면 OfflineAudioContext 재리샘플
- API 키는 localStorage에만 저장, UI에 "이 브라우저에만 저장됩니다" 명시
- 테마: 모든 색상은 `ui/theme.css`의 CSS 변수만 사용 (하드코딩 금지). 클래스 기반 스타일 (인라인 스타일은 동적 값만)

## File Structure (이 플랜이 만들거나 수정하는 파일)

```
index.html                        수정: Pretendard CDN 링크
src/ui/theme.css                  신규: CSS 변수 + 베이스 + 컴포넌트 클래스
src/main.tsx                      수정: theme.css import
src/ui/AppShell.tsx               신규: 사이드바 레이아웃 (Outlet)
src/App.tsx                       수정: AppShell 중첩 라우트 + /upload /settings
src/core/settings.ts              신규: 설정 localStorage 래퍼
src/core/audio/decode.ts          신규: 16kHz mono 디코딩 (팩토리 주입)
src/core/audio/wav.ts             신규: WAV 인코딩 + Groq용 분할 (순수 함수)
src/core/stt/whisperLocal.ts      신규: 워커 클라이언트 + WebGPU 감지
src/core/stt/whisper.worker.ts    신규: transformers.js 파이프라인 워커
src/core/stt/groq.ts              신규: Groq 전사 (분할·병합·백오프)
src/core/stt/types.ts             신규: 공용 DraftSegment 타입
src/core/store/meetings.ts        수정: replaceSegments, createUploadMeeting 추가
src/ui/pages/Upload.tsx           신규: 드롭존 + 엔진 선택 + 진행률
src/ui/pages/Settings.tsx         신규: Groq 키·모델·언어
src/ui/pages/{Home,Record,Meeting}.tsx  수정: 테마 클래스 적용 + Meeting에 재전사
(각 모듈 옆 *.test.ts[x] colocated)
```

---

### Task 1: 테마 기반 — theme.css + Pretendard + 전역 적용

**Files:**
- Create: `src/ui/theme.css`
- Modify: `index.html`, `src/main.tsx`
- Test: `src/ui/theme.test.ts`

**Interfaces:**
- Consumes: `docs/design/design-tokens.md` (값의 출처)
- Produces: CSS 클래스 계약 — `.btn`, `.btn-primary`, `.btn-outline`, `.btn-ghost`, `.card`, `.badge`, `.input`, `.progress`(트랙)+`.progress > i`(채움), `.dropzone`(+`.drag-over`), `.sidebar`, `.nav-item`(+`.active`), `.content`, `.toast`. 이후 모든 UI 태스크가 이 클래스를 사용

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ui/theme.test.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'

const css = fs.readFileSync(path.resolve(__dirname, 'theme.css'), 'utf-8')

test('디자인 토큰 CSS 변수가 정의되어 있다', () => {
  for (const v of ['--bg: #F4F5F9', '--surface: #FFFFFF', '--accent: #1E43B8',
    '--accent-hover: #16359B', '--accent-soft: #EEF2FD', '--text-strong: #1A2033',
    '--border: #E4E7EE', '--input-border: #D8DDE8']) {
    expect(css).toContain(v)
  }
})

test('컴포넌트 클래스 계약이 존재한다', () => {
  for (const cls of ['.btn-primary', '.btn-outline', '.btn-ghost', '.card',
    '.badge', '.input', '.progress', '.dropzone', '.sidebar', '.nav-item', '.content', '.toast']) {
    expect(css).toContain(cls)
  }
})

test('색상 하드코딩 대신 변수 사용 — accent 원색이 변수 정의 외에 재등장하지 않는다', () => {
  const defs = css.split('\n').filter(l => l.includes('#1E43B8'))
  // :root 변수 정의 줄에서만 허용
  expect(defs.every(l => l.trim().startsWith('--'))).toBe(true)
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- theme` → Expected: FAIL — theme.css 없음

- [ ] **Step 3: 구현**

`src/ui/theme.css` (전체 — design-tokens.md의 값 그대로):
```css
:root {
  --bg: #F4F5F9;
  --surface: #FFFFFF;
  --accent: #1E43B8;
  --accent-hover: #16359B;
  --accent-soft: #EEF2FD;
  --accent-softer: #F3F6FE;
  --accent-border: #C9D4EE;
  --text-strong: #1A2033;
  --text-body: #3D4657;
  --text-sub: #555E73;
  --text-muted: #8A93A8;
  --placeholder: #9AA3B8;
  --border: #E4E7EE;
  --border-soft: #EDEFF4;
  --input-border: #D8DDE8;
  --drop-border: #C4CFE8;
  --highlight: #FFE59E;
  --chip-dark: #1A2033;
  --ok-fg: #15803D; --ok-bg: #E7F5EC;
  --warn-fg: #B45309; --warn-bg: #FBF4E4;
  --err-bg: #FBEAE8;
  --font: 'Pretendard Variable', Pretendard, -apple-system, 'Noto Sans KR', sans-serif;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text-strong);
  font-family: var(--font);
  font-size: 13.5px;
  font-weight: 500;
}
* { box-sizing: border-box; }
button, input, select, textarea { font-family: inherit; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
::placeholder { color: var(--placeholder); }
h1 { font-size: 23px; font-weight: 800; letter-spacing: -0.4px; margin: 0 0 4px; }
h2 { font-size: 16px; font-weight: 700; letter-spacing: -0.2px; margin: 0; }
a { color: var(--accent); text-decoration: none; }

@keyframes pulseDot { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }

/* 레이아웃 */
.shell { display: flex; min-height: 100vh; }
.sidebar {
  width: 228px; flex-shrink: 0; background: var(--surface);
  border-right: 1px solid var(--border); padding: 20px 14px 16px;
  display: flex; flex-direction: column; gap: 4px;
}
.sidebar .logo {
  display: flex; align-items: center; gap: 8px; font-size: 14.5px; font-weight: 800;
  margin-bottom: 18px; color: var(--text-strong);
}
.sidebar .logo i {
  width: 30px; height: 30px; border-radius: 8px; background: var(--accent); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  font-style: normal; font-weight: 800; font-size: 15px;
}
.nav-item {
  display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 9px;
  border: none; background: transparent; color: var(--text-sub); font-size: 13.5px;
  font-weight: 600; cursor: pointer; text-align: left; width: 100%;
}
.nav-item:hover { background: var(--accent-softer); }
.nav-item.active { background: var(--accent-soft); color: var(--accent); }
.content { flex: 1; max-width: 1160px; margin: 0 auto; padding: 32px 36px 48px; min-width: 0; }
@media (max-width: 880px) {
  .shell { flex-direction: column; }
  .sidebar {
    width: 100%; flex-direction: row; align-items: center; position: sticky; top: 0; z-index: 10;
    padding: 10px 14px; border-right: none; border-bottom: 1px solid var(--border); gap: 6px;
  }
  .sidebar .logo { margin-bottom: 0; margin-right: 8px; }
  .nav-item { width: auto; padding: 7px 10px; }
  .content { padding: 20px 16px 40px; }
}

/* 카드 */
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 20px; transition: box-shadow .15s, border-color .15s;
}
.card.hoverable:hover { box-shadow: 0 4px 16px rgba(26, 32, 51, 0.08); border-color: var(--accent-border); }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }

/* 버튼 */
.btn {
  height: 38px; padding: 0 16px; border-radius: 9px; font-size: 13.5px; font-weight: 600;
  cursor: pointer; display: inline-flex; align-items: center; gap: 6px; justify-content: center;
  transition: background .12s, border-color .12s, color .12s;
}
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { border: none; background: var(--accent); color: #fff; font-weight: 700; }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-outline { border: 1px solid var(--input-border); background: var(--surface); color: var(--text-body); }
.btn-outline:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-ghost { border: none; background: transparent; color: var(--text-sub); }
.btn-ghost:hover:not(:disabled) { background: var(--accent-soft); }
.btn-sm { height: 34px; padding: 0 12px; border-radius: 8px; font-size: 12.5px; }

/* 입력 */
.input, select.input {
  height: 38px; padding: 0 12px; border: 1px solid var(--input-border); border-radius: 9px;
  font-size: 13.5px; background: var(--surface); color: var(--text-strong); width: 100%;
}
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.field label { font-size: 12.5px; font-weight: 600; color: var(--text-sub); }
.hint { font-size: 12px; color: var(--text-muted); }

/* 배지 */
.badge {
  display: inline-flex; align-items: center; gap: 6px; border-radius: 999px;
  padding: 3px 10px; font-size: 12px; font-weight: 700;
}
.badge .dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; animation: pulseDot 1.2s infinite; }
.badge-accent { background: var(--accent-soft); color: var(--accent); }
.badge-gray { background: #F1F2F6; color: var(--text-sub); }
.badge-ok { background: var(--ok-bg); color: var(--ok-fg); }
.badge-warn { background: var(--warn-bg); color: var(--warn-fg); }

/* 진행률 */
.progress { height: 8px; border-radius: 999px; background: var(--border-soft); overflow: hidden; }
.progress > i { display: block; height: 100%; border-radius: 999px; background: var(--accent); transition: width .2s; }
.progress-label { font-size: 12.5px; font-weight: 700; color: var(--accent); }

/* 드롭존 */
.dropzone {
  border: 2px dashed var(--drop-border); border-radius: 14px; padding: 52px 24px;
  text-align: center; color: var(--text-sub); cursor: pointer;
  transition: border-color .15s, background .15s;
}
.dropzone:hover { border-color: var(--accent); background: #FAFBFE; }
.dropzone.drag-over { border-color: var(--accent); background: var(--accent-softer); }
.dropzone .icon {
  width: 52px; height: 52px; border-radius: 999px; background: var(--accent-soft); color: var(--accent);
  display: inline-flex; align-items: center; justify-content: center; font-size: 22px; margin-bottom: 12px;
}

/* 토스트/경고 */
.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: var(--chip-dark); color: #fff; border-radius: 999px; padding: 10px 18px;
  font-size: 12.5px; font-weight: 600; box-shadow: 0 8px 24px rgba(26, 32, 51, 0.25); z-index: 100;
}
.alert { border-radius: 10px; padding: 10px 14px; font-size: 12.5px; font-weight: 600; margin-bottom: 14px; }
.alert-warn { background: var(--warn-bg); color: var(--warn-fg); }
.alert-err { background: var(--err-bg); color: #B4231B; }

/* 목록 행 */
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.muted { color: var(--text-muted); font-size: 12px; }
.sub { color: var(--text-sub); font-size: 12.5px; }
.seg-time { color: var(--text-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
```

`index.html`의 `<head>`에 추가 (title 위):
```html
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
```

`src/main.tsx` 상단에 추가:
```ts
import './ui/theme.css'
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- theme` → Expected: 3 passed
Run: `npm test` → Expected: 전체 통과 (기존 화면은 클래스 미적용 상태여도 무관)
Run: `npm run build` → Expected: 성공

- [ ] **Step 5: Commit**

```bash
git add src/ui/theme.css src/ui/theme.test.ts index.html src/main.tsx
git commit -m "feat: minutelog 디자인 토큰 기반 테마 시스템"
```

---

### Task 2: 앱 셸 (사이드바 + 중첩 라우트)

**Files:**
- Create: `src/ui/AppShell.tsx`
- Modify: `src/App.tsx`
- Test: `src/ui/AppShell.test.tsx`

**Interfaces:**
- Consumes: theme.css 클래스 (`.shell`, `.sidebar`, `.nav-item`, `.content`)
- Produces: `<AppShell />` — react-router `<Outlet />`을 `.content`에 렌더. nav: 홈(`/`)·녹음(`/record`)·업로드(`/upload`)·설정(`/settings`). App.tsx 라우트가 AppShell 하위로 중첩됨 (기존 페이지 경로 불변, `/upload`·`/settings`는 Task 8·6에서 추가될 때까지 placeholder 없이 nav 링크만 존재해도 됨 — 라우트는 이 태스크에서 미리 등록하되 element는 `<div />` 스텁)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ui/AppShell.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import AppShell from './AppShell'

function renderShell(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<div>홈콘텐츠</div>} />
          <Route path="/record" element={<div>녹음콘텐츠</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

test('사이드바 nav 4개와 로고가 보인다', () => {
  renderShell()
  expect(screen.getByText('MinuteFlow')).toBeInTheDocument()
  for (const name of ['홈', '녹음', '업로드', '설정']) {
    expect(screen.getByRole('link', { name })).toBeInTheDocument()
  }
})

test('Outlet에 자식 라우트가 렌더된다', () => {
  renderShell('/record')
  expect(screen.getByText('녹음콘텐츠')).toBeInTheDocument()
})

test('현재 경로의 nav에 active 클래스', () => {
  renderShell('/record')
  expect(screen.getByRole('link', { name: '녹음' })).toHaveClass('active')
  expect(screen.getByRole('link', { name: '홈' })).not.toHaveClass('active')
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- AppShell` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/ui/AppShell.tsx`:
```tsx
import { NavLink, Outlet } from 'react-router-dom'

const NAV = [
  { to: '/', label: '홈' },
  { to: '/record', label: '녹음' },
  { to: '/upload', label: '업로드' },
  { to: '/settings', label: '설정' },
]

export default function AppShell() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo"><i>M</i>MinuteFlow</div>
        {NAV.map(n => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {n.label}
          </NavLink>
        ))}
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
```

`src/App.tsx` (전체 교체):
```tsx
import { Routes, Route } from 'react-router-dom'
import AppShell from './ui/AppShell'
import Home from './ui/pages/Home'
import Record from './ui/pages/Record'
import MeetingPage from './ui/pages/Meeting'

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/record" element={<Record />} />
        <Route path="/meeting/:id" element={<MeetingPage />} />
        <Route path="/upload" element={<div />} />
        <Route path="/settings" element={<div />} />
      </Route>
    </Routes>
  )
}
```
(주의: 기존 페이지의 최상위 `<main>` 태그는 AppShell이 `<main className="content">`를 제공하므로 Task 7 리스타일에서 `<div>` 등으로 바뀐다. 이 태스크에서는 중첩만 하고 페이지 내부는 손대지 않는다 — `<main>` 중첩이 일시적으로 생겨도 테스트에 영향 없음.)

- [ ] **Step 4: 통과 확인**

Run: `npm test -- AppShell` → Expected: 3 passed
Run: `npm test` → Expected: 전체 통과 (기존 Home/Record/Meeting 테스트는 페이지를 직접 렌더하므로 영향 없음. App.test.tsx는 Home의 h1 "MinuteFlow"…가 사이드바 로고와 중복 매칭될 수 있음 — `getByText(/MinuteFlow/)`가 다중 매칭으로 실패하면 App.test.tsx의 단언을 `screen.getAllByText(/MinuteFlow/).length`가 1 이상으로 수정)

- [ ] **Step 5: Commit**

```bash
git add src/ui/AppShell.tsx src/ui/AppShell.test.tsx src/App.tsx
git commit -m "feat: 사이드바 앱 셸 및 중첩 라우팅"
```

---

### Task 3: 설정 스토어 (localStorage)

**Files:**
- Create: `src/core/settings.ts`
- Test: `src/core/settings.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces (Settings 페이지·Upload·Meeting 재전사가 사용):
  - `type WhisperModelId = 'onnx-community/whisper-large-v3-turbo' | 'onnx-community/whisper-base'`
  - `interface AppSettings { groqApiKey: string; whisperModel: WhisperModelId; language: string }`
  - `loadSettings(): AppSettings` — 기본값 `{groqApiKey:'', whisperModel:'onnx-community/whisper-large-v3-turbo', language:'ko'}`
  - `saveSettings(patch: Partial<AppSettings>): AppSettings` — 병합 후 저장·반환
  - 저장 키: `minuteflow.settings` (JSON)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/settings.test.ts`:
```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- settings` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/core/settings.ts`:
```ts
export type WhisperModelId =
  | 'onnx-community/whisper-large-v3-turbo'
  | 'onnx-community/whisper-base'

export interface AppSettings {
  groqApiKey: string
  whisperModel: WhisperModelId
  language: string
}

const KEY = 'minuteflow.settings'

const DEFAULTS: AppSettings = {
  groqApiKey: '',
  whisperModel: 'onnx-community/whisper-large-v3-turbo',
  language: 'ko',
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- settings` → Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/settings.ts src/core/settings.test.ts
git commit -m "feat: 설정 localStorage 스토어"
```

---

### Task 4: 오디오 디코딩 + WAV 인코딩·분할

**Files:**
- Create: `src/core/audio/decode.ts`, `src/core/audio/wav.ts`
- Test: `src/core/audio/decode.test.ts`, `src/core/audio/wav.test.ts`

**Interfaces:**
- Consumes: 없음 (Web Audio는 팩토리 주입으로 테스트)
- Produces:
  - `decode.ts`:
    - `downmixToMono(buffers: Float32Array[]): Float32Array` — 2채널이면 `(L+R)×√2/2`, 1채널이면 그대로 (순수 함수)
    - `decodeTo16kMono(data: ArrayBuffer, createCtx?: (rate: number) => BaseAudioContextLike): Promise<Float32Array>` — 16kHz 컨텍스트 통디코딩 + 다운믹스. `decoded.sampleRate !== 16000`이면 에러 대신 그대로 반환하지 말고 `resampleTo16k` 호출 (OfflineAudioContext 주입 불가 환경 대비, 팩토리에 offline 생성 함수 포함)
    - `BaseAudioContextLike = { decodeAudioData(b: ArrayBuffer): Promise<AudioBufferLike>; close?(): Promise<void> }`, `AudioBufferLike = { sampleRate: number; numberOfChannels: number; length: number; duration: number; getChannelData(i: number): Float32Array }`
  - `wav.ts`:
    - `encodeWav16k(samples: Float32Array): Blob` — 16kHz mono 16-bit PCM WAV (RIFF 헤더 44바이트)
    - `splitForGroq(samples: Float32Array, maxSec?: number): { samples: Float32Array; offsetSec: number }[]` — 기본 750초(= 24MB WAV) 단위 분할, 마지막 조각은 잔여

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/audio/wav.test.ts`:
```ts
import { encodeWav16k, splitForGroq } from './wav'

test('WAV 헤더가 16kHz mono 16bit로 인코딩된다', async () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
  const blob = encodeWav16k(samples)
  const buf = new DataView(await blob.arrayBuffer())
  expect(blob.type).toBe('audio/wav')
  expect(buf.getUint32(0, false)).toBe(0x52494646) // 'RIFF'
  expect(buf.getUint32(8, false)).toBe(0x57415645) // 'WAVE'
  expect(buf.getUint32(24, true)).toBe(16000)      // sampleRate
  expect(buf.getUint16(22, true)).toBe(1)          // channels
  expect(buf.getUint16(34, true)).toBe(16)         // bits
  expect(buf.byteLength).toBe(44 + samples.length * 2)
  expect(buf.getInt16(44, true)).toBe(0)
  expect(buf.getInt16(46, true)).toBe(16383)       // 0.5 → 0.5*32767 반올림
  expect(buf.getInt16(50, true)).toBe(32767)       // 1 → 클램프 상한
  expect(buf.getInt16(52, true)).toBe(-32768)      // -1 → 하한
})

test('splitForGroq는 maxSec 단위로 오프셋과 함께 분할한다', () => {
  const oneSec = 16000
  const samples = new Float32Array(oneSec * 5) // 5초
  const parts = splitForGroq(samples, 2)
  expect(parts.map(p => p.offsetSec)).toEqual([0, 2, 4])
  expect(parts.map(p => p.samples.length)).toEqual([oneSec * 2, oneSec * 2, oneSec])
})

test('한 조각이면 분할 없음', () => {
  const parts = splitForGroq(new Float32Array(16000), 750)
  expect(parts).toHaveLength(1)
  expect(parts[0].offsetSec).toBe(0)
})
```

`src/core/audio/decode.test.ts`:
```ts
import { downmixToMono, decodeTo16kMono, type AudioBufferLike } from './decode'

function fakeBuffer(channels: Float32Array[], sampleRate = 16000): AudioBufferLike {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    getChannelData: (i: number) => channels[i],
  }
}

test('스테레오는 (L+R)×√2/2로 다운믹스', () => {
  const out = downmixToMono([new Float32Array([1, 0]), new Float32Array([1, 1])])
  expect(out[0]).toBeCloseTo(Math.SQRT2, 5)      // (1+1)*√2/2 = √2
  expect(out[1]).toBeCloseTo(Math.SQRT2 / 2, 5)  // (0+1)*√2/2
})

test('모노는 그대로', () => {
  const mono = new Float32Array([0.1, 0.2])
  expect(downmixToMono([mono])).toBe(mono)
})

test('decodeTo16kMono는 16kHz 컨텍스트로 디코딩해 모노를 반환한다', async () => {
  const rates: number[] = []
  const createCtx = (rate: number) => {
    rates.push(rate)
    return {
      decodeAudioData: async () => fakeBuffer([new Float32Array([0.5, 0.5])]),
      close: async () => {},
    }
  }
  const out = await decodeTo16kMono(new ArrayBuffer(4), createCtx)
  expect(rates).toEqual([16000])
  expect(Array.from(out)).toEqual([0.5, 0.5])
})

test('디코딩 실패는 명확한 에러로 전파된다', async () => {
  const createCtx = () => ({
    decodeAudioData: async () => { throw new DOMException('invalid content') },
    close: async () => {},
  })
  await expect(decodeTo16kMono(new ArrayBuffer(4), createCtx)).rejects.toThrow(/디코딩/)
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- audio` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/core/audio/decode.ts`:
```ts
export interface AudioBufferLike {
  sampleRate: number
  numberOfChannels: number
  length: number
  duration: number
  getChannelData(i: number): Float32Array
}

export interface BaseAudioContextLike {
  decodeAudioData(b: ArrayBuffer): Promise<AudioBufferLike>
  close?(): Promise<void>
}

export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const [left, right] = channels
  const out = new Float32Array(left.length)
  for (let i = 0; i < left.length; ++i) out[i] = (Math.SQRT2 * (left[i] + right[i])) / 2
  return out
}

function defaultCreateCtx(rate: number): BaseAudioContextLike {
  return new AudioContext({ sampleRate: rate }) as unknown as BaseAudioContextLike
}

async function resampleTo16k(buffer: AudioBufferLike): Promise<Float32Array> {
  // 방어 경로: 컨텍스트가 16kHz를 무시한 드문 경우 (스펙상 리샘플은 should)
  const length = Math.ceil(buffer.duration * 16000)
  const off = new OfflineAudioContext(1, length, 16000)
  const src = off.createBufferSource()
  const real = new AudioBuffer({
    length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate,
  })
  for (let c = 0; c < buffer.numberOfChannels; c++) real.copyToChannel(buffer.getChannelData(c), c)
  src.buffer = real
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

export async function decodeTo16kMono(
  data: ArrayBuffer,
  createCtx: (rate: number) => BaseAudioContextLike = defaultCreateCtx,
): Promise<Float32Array> {
  const ctx = createCtx(16000)
  let decoded: AudioBufferLike
  try {
    decoded = await ctx.decodeAudioData(data)
  } catch {
    throw new Error('오디오를 디코딩할 수 없습니다. 지원되지 않는 형식이거나 손상된 파일입니다.')
  } finally {
    void ctx.close?.()
  }
  if (decoded.sampleRate !== 16000) return resampleTo16k(decoded)
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i))
  return downmixToMono(channels.slice(0, 2))
}
```

`src/core/audio/wav.ts`:
```ts
const SAMPLE_RATE = 16000

export function encodeWav16k(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)          // fmt chunk size
  v.setUint16(20, 1, true)           // PCM
  v.setUint16(22, 1, true)           // mono
  v.setUint32(24, SAMPLE_RATE, true)
  v.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
  v.setUint16(32, 2, true)           // block align
  v.setUint16(34, 16, true)          // bits
  writeStr(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, Math.round(s * 32767), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// 750초 = 16000*750*2B = 24MB < Groq 25MB 제한
export function splitForGroq(
  samples: Float32Array,
  maxSec = 750,
): { samples: Float32Array; offsetSec: number }[] {
  const maxLen = maxSec * SAMPLE_RATE
  const parts: { samples: Float32Array; offsetSec: number }[] = []
  for (let start = 0; start < samples.length; start += maxLen) {
    parts.push({
      samples: samples.subarray(start, Math.min(start + maxLen, samples.length)),
      offsetSec: start / SAMPLE_RATE,
    })
  }
  return parts.length > 0 ? parts : [{ samples, offsetSec: 0 }]
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- audio` → Expected: 7 passed
(참고: `-1 → -32768` 단언은 `Math.round(-1×32767) = -32767`이므로 구현과 불일치 시 테스트를 `-32767`로 수정 — 클램프는 -1에서 -32767이 정답. 테스트 작성 시 `-32767`을 기대값으로 사용할 것)

- [ ] **Step 5: Commit**

```bash
git add src/core/audio/
git commit -m "feat: 16kHz 모노 디코딩 및 WAV 인코딩·분할"
```

---

### Task 5: 공용 STT 타입 + Whisper 로컬 엔진 (워커)

**Files:**
- Create: `src/core/stt/types.ts`, `src/core/stt/whisperLocal.ts`, `src/core/stt/whisper.worker.ts`
- Test: `src/core/stt/whisperLocal.test.ts`

**Interfaces:**
- Consumes: `AppSettings.whisperModel` (Task 3), 16kHz Float32Array (Task 4)
- Produces:
  - `types.ts`: `interface DraftSegment { startSec: number; endSec: number; text: string }`
  - `whisperLocal.ts`:
    - `detectWebGPU(): Promise<boolean>` — `navigator.gpu` + `requestAdapter()` null 체크
    - `type WhisperProgress = { kind: 'download'; file: string; progress: number } | { kind: 'status'; message: string }`
    - `class WhisperLocalEngine { constructor(createWorker?: () => Worker); transcribe(audio: Float32Array, opts: { model: string; device: 'webgpu' | 'wasm'; language: string }, onProgress?: (p: WhisperProgress) => void): Promise<DraftSegment[]>; dispose(): void }`
  - 워커 프로토콜 (in): `{ type: 'transcribe', audio: Float32Array, model: string, device: string, language: string }` / (out): `{ status: 'progress', file, progress }` | `{ status: 'info', message }` | `{ status: 'done', chunks: { text: string; timestamp: [number, number | null] }[] }` | `{ status: 'error', message }`
  - transformers.js 마지막 청크의 `timestamp[1]`이 `null`일 수 있음 → endSec은 `timestamp[1] ?? timestamp[0]`으로 방어

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/stt/whisperLocal.test.ts`:
```ts
import { WhisperLocalEngine, detectWebGPU } from './whisperLocal'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  posted: unknown[] = []
  terminated = false
  constructor() { FakeWorker.instances.push(this) }
  postMessage(msg: unknown) { this.posted.push(msg) }
  terminate() { this.terminated = true }
  emit(data: unknown) { this.onmessage?.({ data }) }
}

beforeEach(() => { FakeWorker.instances = [] })

function makeEngine() {
  return new WhisperLocalEngine(() => new FakeWorker() as unknown as Worker)
}

test('transcribe는 워커에 오디오·옵션을 보내고 done 청크를 세그먼트로 변환한다', async () => {
  const engine = makeEngine()
  const audio = new Float32Array([0.1])
  const p = engine.transcribe(audio, {
    model: 'onnx-community/whisper-base', device: 'wasm', language: 'ko',
  })
  const w = FakeWorker.instances[0]
  expect(w.posted[0]).toMatchObject({ type: 'transcribe', model: 'onnx-community/whisper-base', device: 'wasm', language: 'ko' })
  w.emit({ status: 'done', chunks: [
    { text: ' 안녕하세요', timestamp: [0, 3.2] },
    { text: ' 반갑습니다', timestamp: [3.2, null] },
  ] })
  const segs = await p
  expect(segs).toEqual([
    { startSec: 0, endSec: 3.2, text: '안녕하세요' },
    { startSec: 3.2, endSec: 3.2, text: '반갑습니다' }, // null end 방어
  ])
})

test('progress 이벤트가 onProgress로 전달된다', async () => {
  const engine = makeEngine()
  const seen: unknown[] = []
  const p = engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' }, x => seen.push(x))
  const w = FakeWorker.instances[0]
  w.emit({ status: 'progress', file: 'model.onnx', progress: 42 })
  w.emit({ status: 'info', message: '워밍업 중' })
  w.emit({ status: 'done', chunks: [] })
  await p
  expect(seen).toEqual([
    { kind: 'download', file: 'model.onnx', progress: 42 },
    { kind: 'status', message: '워밍업 중' },
  ])
})

test('error 상태는 reject된다', async () => {
  const engine = makeEngine()
  const p = engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' })
  FakeWorker.instances[0].emit({ status: 'error', message: '메모리 부족' })
  await expect(p).rejects.toThrow('메모리 부족')
})

test('dispose는 워커를 종료한다', () => {
  const engine = makeEngine()
  void engine.transcribe(new Float32Array(1), { model: 'm', device: 'wasm', language: 'ko' }).catch(() => {})
  engine.dispose()
  expect(FakeWorker.instances[0].terminated).toBe(true)
})

test('detectWebGPU는 adapter가 null이면 false', async () => {
  vi.stubGlobal('navigator', { ...navigator, gpu: { requestAdapter: async () => null } })
  expect(await detectWebGPU()).toBe(false)
  vi.stubGlobal('navigator', { ...navigator, gpu: undefined })
  expect(await detectWebGPU()).toBe(false)
  vi.stubGlobal('navigator', { ...navigator, gpu: { requestAdapter: async () => ({}) } })
  expect(await detectWebGPU()).toBe(true)
  vi.unstubAllGlobals()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- whisperLocal` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 의존성 설치 및 구현**

```bash
npm install @huggingface/transformers
```

`src/core/stt/types.ts`:
```ts
export interface DraftSegment {
  startSec: number
  endSec: number
  text: string
}
```

`src/core/stt/whisper.worker.ts` (검증된 공식 패턴 — docs/research/2026-07-07-plan2-apis.md):
```ts
import { pipeline } from '@huggingface/transformers'

const PER_DEVICE_CONFIG = {
  webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, device: 'webgpu' },
  wasm: { dtype: 'q8', device: 'wasm' },
} as const

type InMsg = { type: 'transcribe'; audio: Float32Array; model: string; device: 'webgpu' | 'wasm'; language: string }

let transcriber: Awaited<ReturnType<typeof pipeline>> | null = null
let loadedKey = ''

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const { audio, model, device, language } = ev.data
  try {
    const key = `${model}|${device}`
    if (!transcriber || loadedKey !== key) {
      transcriber = await pipeline('automatic-speech-recognition', model, {
        ...PER_DEVICE_CONFIG[device],
        progress_callback: (x: { status: string; file?: string; progress?: number }) => {
          if (x.status === 'progress') {
            self.postMessage({ status: 'progress', file: x.file, progress: x.progress })
          }
        },
      })
      loadedKey = key
      if (device === 'webgpu') {
        self.postMessage({ status: 'info', message: '셰이더 컴파일 및 워밍업 중…' })
        await transcriber(new Float32Array(16_000), { language })
      }
    }
    self.postMessage({ status: 'info', message: '전사 중…' })
    const output = await transcriber(audio, {
      language,
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    })
    const chunks = (Array.isArray(output) ? output[0] : output).chunks ?? []
    self.postMessage({ status: 'done', chunks })
  } catch (e) {
    self.postMessage({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
```

`src/core/stt/whisperLocal.ts`:
```ts
import type { DraftSegment } from './types'

export type WhisperProgress =
  | { kind: 'download'; file: string; progress: number }
  | { kind: 'status'; message: string }

export async function detectWebGPU(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

type WorkerOut =
  | { status: 'progress'; file: string; progress: number }
  | { status: 'info'; message: string }
  | { status: 'done'; chunks: { text: string; timestamp: [number, number | null] }[] }
  | { status: 'error'; message: string }

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
}

export class WhisperLocalEngine {
  private worker: Worker | null = null

  constructor(private createWorker: () => Worker = defaultCreateWorker) {}

  transcribe(
    audio: Float32Array,
    opts: { model: string; device: 'webgpu' | 'wasm'; language: string },
    onProgress?: (p: WhisperProgress) => void,
  ): Promise<DraftSegment[]> {
    this.worker ??= this.createWorker()
    const worker = this.worker
    return new Promise((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
        const msg = ev.data
        if (msg.status === 'progress') onProgress?.({ kind: 'download', file: msg.file, progress: msg.progress })
        else if (msg.status === 'info') onProgress?.({ kind: 'status', message: msg.message })
        else if (msg.status === 'done') {
          resolve(msg.chunks.map(c => ({
            startSec: c.timestamp[0],
            endSec: c.timestamp[1] ?? c.timestamp[0],
            text: c.text.trim(),
          })))
        } else if (msg.status === 'error') reject(new Error(msg.message))
      }
      worker.postMessage({ type: 'transcribe', audio, ...opts })
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- whisperLocal` → Expected: 5 passed
Run: `npm run build` → Expected: 성공 (워커가 Vite 모듈 워커로 번들됨)

- [ ] **Step 5: Commit**

```bash
git add src/core/stt/types.ts src/core/stt/whisperLocal.ts src/core/stt/whisper.worker.ts src/core/stt/whisperLocal.test.ts package.json package-lock.json
git commit -m "feat: 브라우저 Whisper 전사 워커 및 엔진"
```

---

### Task 6: Groq 전사 엔진

**Files:**
- Create: `src/core/stt/groq.ts`
- Test: `src/core/stt/groq.test.ts`

**Interfaces:**
- Consumes: `DraftSegment` (Task 5), `encodeWav16k`/`splitForGroq` (Task 4)
- Produces:
  - `transcribeBlobWithGroq(blob: Blob, filename: string, opts: { apiKey: string; language: string; fetchFn?: typeof fetch }): Promise<DraftSegment[]>` — 단일 파일(≤25MB) 전사. verbose_json의 `segments[{start,end,text}]` → DraftSegment. 429면 `retry-after`초 대기 후 1회 재시도(대기는 주입 가능한 `sleep`), 재실패 시 에러. 401은 "API 키를 확인해주세요" 에러
  - `transcribeSamplesWithGroq(samples: Float32Array, opts: { apiKey: string; language: string; fetchFn?: typeof fetch; onPart?: (done: number, total: number) => void }): Promise<DraftSegment[]>` — `splitForGroq` → 각 조각 `encodeWav16k` → 순차 전사 → `offsetSec` 보정 병합
  - `GROQ_FILE_LIMIT = 25 * 1024 * 1024`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/core/stt/groq.test.ts`:
```ts
import { transcribeBlobWithGroq, transcribeSamplesWithGroq } from './groq'

function okResponse(segments: { start: number; end: number; text: string }[]) {
  return new Response(JSON.stringify({ text: 'x', segments }), { status: 200 })
}

test('FormData 필드와 인증 헤더가 규격대로 전송된다', async () => {
  const fetchFn = vi.fn(async () => okResponse([{ start: 0, end: 2, text: ' 안녕' }]))
  const segs = await transcribeBlobWithGroq(new Blob(['x'], { type: 'audio/webm' }), 'rec.webm', {
    apiKey: 'gsk_1', language: 'ko', fetchFn: fetchFn as unknown as typeof fetch,
  })
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_1')
  expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined() // boundary 자동
  const form = init.body as FormData
  expect((form.get('file') as File).name).toBe('rec.webm')
  expect(form.get('model')).toBe('whisper-large-v3-turbo')
  expect(form.get('language')).toBe('ko')
  expect(form.get('response_format')).toBe('verbose_json')
  expect(segs).toEqual([{ startSec: 0, endSec: 2, text: '안녕' }])
})

test('429는 retry-after 후 1회 재시도한다', async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3' } }))
    .mockResolvedValueOnce(okResponse([{ start: 0, end: 1, text: 'ok' }]))
  const sleeps: number[] = []
  const segs = await transcribeBlobWithGroq(new Blob(['x']), 'a.wav', {
    apiKey: 'k', language: 'ko', fetchFn: fetchFn as unknown as typeof fetch,
    sleep: async ms => { sleeps.push(ms) },
  })
  expect(sleeps).toEqual([3000])
  expect(segs).toHaveLength(1)
})

test('401은 키 확인 에러', async () => {
  const fetchFn = vi.fn(async () => new Response('', { status: 401 }))
  await expect(transcribeBlobWithGroq(new Blob(['x']), 'a.wav', {
    apiKey: 'bad', language: 'ko', fetchFn: fetchFn as unknown as typeof fetch,
  })).rejects.toThrow(/API 키/)
})

test('대용량 샘플은 분할 전사 후 오프셋 보정 병합된다', async () => {
  const fetchFn = vi.fn(async () => okResponse([{ start: 0, end: 1, text: '부분' }]))
  const parts: [number, number][] = []
  const samples = new Float32Array(16000 * 3) // 3초
  const segs = await transcribeSamplesWithGroq(samples, {
    apiKey: 'k', language: 'ko', fetchFn: fetchFn as unknown as typeof fetch,
    maxSec: 1, onPart: (d, t) => parts.push([d, t]),
  })
  expect(fetchFn).toHaveBeenCalledTimes(3)
  expect(segs.map(s => s.startSec)).toEqual([0, 1, 2]) // 각 조각 start 0 + 오프셋 0,1,2
  expect(parts).toEqual([[1, 3], [2, 3], [3, 3]])
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- groq` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/core/stt/groq.ts`:
```ts
import type { DraftSegment } from './types'
import { encodeWav16k, splitForGroq } from '../audio/wav'

export const GROQ_FILE_LIMIT = 25 * 1024 * 1024
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'

interface GroqOpts {
  apiKey: string
  language: string
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function requestOnce(blob: Blob, filename: string, opts: GroqOpts): Promise<Response> {
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('model', 'whisper-large-v3-turbo')
  form.append('language', opts.language)
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0')
  const fetchFn = opts.fetchFn ?? fetch
  return fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}` }, // Content-Type 지정 금지 (boundary 자동)
    body: form,
  })
}

export async function transcribeBlobWithGroq(
  blob: Blob, filename: string, opts: GroqOpts,
): Promise<DraftSegment[]> {
  let res = await requestOnce(blob, filename, opts)
  if (res.status === 429) {
    const waitSec = Number(res.headers.get('retry-after') ?? '10')
    await (opts.sleep ?? defaultSleep)(waitSec * 1000)
    res = await requestOnce(blob, filename, opts)
  }
  if (res.status === 401) throw new Error('Groq API 키를 확인해주세요. (설정에서 재등록)')
  if (res.status === 429) throw new Error('Groq 무료 한도를 초과했습니다. 잠시 후 다시 시도하거나 로컬 전사를 사용해주세요.')
  if (!res.ok) throw new Error(`Groq 오류 (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { segments?: { start: number; end: number; text: string }[] }
  return (data.segments ?? []).map(s => ({ startSec: s.start, endSec: s.end, text: s.text.trim() }))
}

export async function transcribeSamplesWithGroq(
  samples: Float32Array,
  opts: GroqOpts & { maxSec?: number; onPart?: (done: number, total: number) => void },
): Promise<DraftSegment[]> {
  const parts = splitForGroq(samples, opts.maxSec ?? 750)
  const all: DraftSegment[] = []
  for (let i = 0; i < parts.length; i++) {
    const segs = await transcribeBlobWithGroq(encodeWav16k(parts[i].samples), `part-${i}.wav`, opts)
    all.push(...segs.map(s => ({
      ...s,
      startSec: s.startSec + parts[i].offsetSec,
      endSec: s.endSec + parts[i].offsetSec,
    })))
    opts.onPart?.(i + 1, parts.length)
  }
  return all
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- groq` → Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/core/stt/groq.ts src/core/stt/groq.test.ts
git commit -m "feat: Groq BYOK 전사 — 분할·오프셋 병합·백오프"
```

---

### Task 7: 스토어 확장 (업로드 회의 생성 + 세그먼트 교체)

**Files:**
- Modify: `src/core/store/meetings.ts`
- Test: `src/core/store/meetings.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: 기존 스토어
- Produces:
  - `createUploadMeeting(title: string, durationSec: number, blob: Blob, mimeType: string, language?: string): Promise<Meeting>` — status `'done'`으로 생성 + 원본을 audioChunks(seq 0 단일 청크)로 저장
  - `replaceSegments(meetingId: string, segs: Omit<TranscriptSegment, 'id' | 'meetingId'>[]): Promise<void>` — 기존 세그먼트 전부 삭제 후 일괄 삽입 (트랜잭션)

- [ ] **Step 1: 실패하는 테스트 추가** (기존 파일 끝에)

```ts
test('createUploadMeeting은 done 상태로 원본 오디오와 함께 생성된다', async () => {
  const m = await createUploadMeeting('업로드 회의', 120, new Blob(['aud']), 'audio/mp4')
  expect(m).toMatchObject({ title: '업로드 회의', durationSec: 120, status: 'done' })
  const audio = await getMeetingAudio(m.id)
  expect(await audio!.text()).toBe('aud')
  expect(audio!.type).toBe('audio/mp4')
})

test('replaceSegments는 기존 세그먼트를 전부 교체한다', async () => {
  const m = await createMeeting()
  await appendSegment({ meetingId: m.id, startSec: 0, endSec: 1, text: '옛것', source: 'webspeech', isFinal: true })
  await replaceSegments(m.id, [
    { startSec: 0, endSec: 2, text: '새것1', source: 'whisper', isFinal: true },
    { startSec: 2, endSec: 4, text: '새것2', source: 'whisper', isFinal: true },
  ])
  const segs = await getSegments(m.id)
  expect(segs.map(s => s.text)).toEqual(['새것1', '새것2'])
  expect(segs.every(s => s.source === 'whisper')).toBe(true)
})
```
(import 줄에 `createUploadMeeting`, `replaceSegments` 추가)

- [ ] **Step 2: 실패 확인**

Run: `npm test -- meetings` → Expected: FAIL — export 없음

- [ ] **Step 3: 구현** (`meetings.ts`에 추가)

```ts
export async function createUploadMeeting(
  title: string, durationSec: number, blob: Blob, mimeType: string, language = 'ko-KR',
): Promise<Meeting> {
  const meeting: Meeting = {
    id: crypto.randomUUID(), title, createdAt: Date.now(), durationSec, status: 'done', language,
  }
  const data = await blob.arrayBuffer()
  await db.transaction('rw', [db.meetings, db.audioChunks], async () => {
    await db.meetings.add(meeting)
    await db.audioChunks.add({ meetingId: meeting.id, seq: 0, data, mimeType, startedAt: meeting.createdAt })
  })
  return meeting
}

export async function replaceSegments(
  meetingId: string, segs: Omit<TranscriptSegment, 'id' | 'meetingId'>[],
): Promise<void> {
  await db.transaction('rw', [db.transcriptSegments], async () => {
    await db.transcriptSegments.where('meetingId').equals(meetingId).delete()
    await db.transcriptSegments.bulkAdd(segs.map(s => ({ ...s, meetingId })))
  })
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- meetings` → Expected: 11 passed (기존 9 + 신규 2)

- [ ] **Step 5: Commit**

```bash
git add src/core/store/meetings.ts src/core/store/meetings.test.ts
git commit -m "feat: 업로드 회의 생성 및 세그먼트 일괄 교체"
```

---

### Task 8: 설정 화면

**Files:**
- Create: `src/ui/pages/Settings.tsx`
- Modify: `src/App.tsx` (`/settings` 스텁 교체)
- Test: `src/ui/pages/Settings.test.tsx`

**Interfaces:**
- Consumes: `loadSettings`/`saveSettings` (Task 3), `detectWebGPU` (Task 5), theme 클래스
- Produces: `/settings` 화면 — Groq 키 입력(password type, 저장 버튼, "이 브라우저에만 저장됩니다" 문구 + console.groq.com 발급 링크), Whisper 모델 선택(radio: large-v3-turbo ≈560MB 고품질 / base ≈200MB 경량), 언어 select(ko/en/ja/zh), WebGPU 지원 여부 배지 표시. 저장 시 toast "저장되었습니다"

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ui/pages/Settings.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { loadSettings } from '../../core/settings'
import Settings from './Settings'

beforeEach(() => localStorage.clear())

function renderPage() {
  return render(<MemoryRouter><Settings /></MemoryRouter>)
}

test('Groq 키를 저장하면 설정에 반영되고 토스트가 뜬다', async () => {
  renderPage()
  await userEvent.type(screen.getByLabelText(/Groq API 키/), 'gsk_abc')
  await userEvent.click(screen.getByRole('button', { name: /저장/ }))
  await waitFor(() => expect(loadSettings().groqApiKey).toBe('gsk_abc'))
  expect(screen.getByText(/저장되었습니다/)).toBeInTheDocument()
})

test('키는 브라우저에만 저장된다는 고지가 있다', () => {
  renderPage()
  expect(screen.getByText(/이 브라우저에만 저장/)).toBeInTheDocument()
})

test('모델 선택이 저장된다', async () => {
  renderPage()
  await userEvent.click(screen.getByLabelText(/whisper-base/))
  await userEvent.click(screen.getByRole('button', { name: /저장/ }))
  await waitFor(() => expect(loadSettings().whisperModel).toBe('onnx-community/whisper-base'))
})

test('WebGPU 미지원이면 안내 배지', async () => {
  renderPage() // jsdom에는 navigator.gpu 없음
  await waitFor(() => expect(screen.getByText(/WebGPU 미지원/)).toBeInTheDocument())
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- Settings` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/ui/pages/Settings.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { loadSettings, saveSettings, type WhisperModelId } from '../../core/settings'
import { detectWebGPU } from '../../core/stt/whisperLocal'

const MODELS: { id: WhisperModelId; label: string; desc: string }[] = [
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'whisper-large-v3-turbo', desc: '고품질 · 다운로드 약 560MB · WebGPU 권장' },
  { id: 'onnx-community/whisper-base', label: 'whisper-base', desc: '경량 · 약 200MB · 저사양/WASM용' },
]

export default function Settings() {
  const [form, setForm] = useState(loadSettings)
  const [webgpu, setWebgpu] = useState<boolean | null>(null)
  const [toast, setToast] = useState(false)

  useEffect(() => { void detectWebGPU().then(setWebgpu) }, [])

  function save() {
    saveSettings(form)
    setToast(true)
    setTimeout(() => setToast(false), 2000)
  }

  return (
    <div>
      <h1>설정</h1>
      <p className="sub">모든 설정과 키는 이 브라우저에만 저장되며 어떤 서버로도 전송되지 않습니다.</p>

      <section className="card" style={{ marginTop: 22 }}>
        <h2>Groq API 키 (파일 전사 고속 처리)</h2>
        <p className="hint">
          <a href="https://console.groq.com" target="_blank" rel="noreferrer">console.groq.com</a>에서
          무료로 발급받을 수 있습니다. 무료 한도: 하루 오디오 8시간.
        </p>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="groq-key">Groq API 키</label>
          <input id="groq-key" type="password" className="input" placeholder="gsk_..."
            value={form.groqApiKey}
            onChange={e => setForm({ ...form, groqApiKey: e.target.value })} />
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>브라우저 Whisper 모델</h2>
        <p className="hint" style={{ marginBottom: 10 }}>
          {webgpu === null ? '' : webgpu
            ? <span className="badge badge-ok">WebGPU 지원 — 고품질 모델 사용 가능</span>
            : <span className="badge badge-warn">WebGPU 미지원 — 경량 모델 권장, Groq 키 사용을 추천합니다</span>}
        </p>
        {MODELS.map(m => (
          <div key={m.id} className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="radio" id={m.id} name="model" checked={form.whisperModel === m.id}
              onChange={() => setForm({ ...form, whisperModel: m.id })} />
            <label htmlFor={m.id}>{m.label} <span className="hint">— {m.desc}</span></label>
          </div>
        ))}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>언어</h2>
        <div className="field" style={{ marginTop: 10 }}>
          <label htmlFor="lang">전사 언어</label>
          <select id="lang" className="input" value={form.language}
            onChange={e => setForm({ ...form, language: e.target.value })}>
            <option value="ko">한국어</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="zh">中文</option>
          </select>
        </div>
      </section>

      <p style={{ marginTop: 18 }}>
        <button className="btn btn-primary" onClick={save}>저장</button>
      </p>
      {toast && <div className="toast">저장되었습니다</div>}
    </div>
  )
}
```

`src/App.tsx`: `/settings` 스텁을 교체:
```tsx
import Settings from './ui/pages/Settings'
// ...
        <Route path="/settings" element={<Settings />} />
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- Settings` → Expected: 4 passed
(참고: Record 페이지 언어는 `ko-KR`(BCP-47, Web Speech용), 설정 언어는 `ko`(ISO-639-1, Whisper/Groq용) — 서로 다른 체계이며 이 태스크에서는 변환하지 않는다)

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/Settings.tsx src/ui/pages/Settings.test.tsx src/App.tsx
git commit -m "feat: 설정 화면 — Groq 키·Whisper 모델·언어"
```

---

### Task 9: 업로드 화면 (드롭존 → 전사 파이프라인)

**Files:**
- Create: `src/ui/pages/Upload.tsx`
- Modify: `src/App.tsx` (`/upload` 스텁 교체)
- Test: `src/ui/pages/Upload.test.tsx`

**Interfaces:**
- Consumes: `decodeTo16kMono`(Task 4), `WhisperLocalEngine`/`detectWebGPU`(Task 5), `transcribeBlobWithGroq`/`transcribeSamplesWithGroq`/`GROQ_FILE_LIMIT`(Task 6), `createUploadMeeting`/`replaceSegments`(Task 7), `loadSettings`(Task 3)
- Produces: `/upload` 화면

**동작 규약:**
- 드롭존(클릭=파일선택, 드래그앤드롭). accept: `audio/*,.m4a,.mp3,.wav,.webm,.ogg`
- 엔진 선택 radio: **로컬 Whisper**(기본) / **Groq**(키 없으면 disabled + "설정에서 키 등록" 링크)
- [전사 시작] 흐름:
  1. `createUploadMeeting(파일명에서 확장자 뗀 제목, 0, file, file.type)` — duration은 디코딩 후 `finishMeeting`으로 갱신
  2. **Groq + 파일 ≤25MB**: 원본 그대로 `transcribeBlobWithGroq` (디코딩 불필요 — Groq가 서버에서 디코딩)
  3. 그 외(로컬 Whisper 전부, Groq >25MB): `decodeTo16kMono` → duration = `samples.length/16000` → 로컬이면 `WhisperLocalEngine.transcribe`(device는 `detectWebGPU()` 결과, 모델은 설정값 — 단 WASM이면 강제 base), Groq면 `transcribeSamplesWithGroq`
  4. `replaceSegments(meetingId, segs.map(s => ({...s, source, isFinal: true})))` → `finishMeeting(id, duration)` → navigate(`/meeting/:id`)
- 진행 UI: 단계 텍스트(디코딩 중 → 모델 다운로드 x% → 전사 중 → 저장 중) + `.progress` 바 (모델 다운로드/Groq 파트 진행률)
- 실패 시: `.alert-err`로 메시지 + 디코딩 실패면 "Groq 경로는 원본을 그대로 전송하므로 성공할 수 있습니다" 안내. 생성했던 meeting은 세그먼트 없이 남음(오디오는 보존 — 재전사 가능)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ui/pages/Upload.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { db } from '../../core/store/db'
import { saveSettings } from '../../core/settings'
import Upload from './Upload'

vi.mock('../../core/audio/decode', () => ({
  decodeTo16kMono: vi.fn(async () => new Float32Array(16000 * 2)), // 2초
}))
vi.mock('../../core/stt/groq', async importOriginal => ({
  ...(await importOriginal<typeof import('../../core/stt/groq')>()),
  transcribeBlobWithGroq: vi.fn(async () => [{ startSec: 0, endSec: 2, text: 'Groq 전사' }]),
}))
vi.mock('../../core/stt/whisperLocal', () => ({
  detectWebGPU: vi.fn(async () => false),
  WhisperLocalEngine: class {
    async transcribe() { return [{ startSec: 0, endSec: 2, text: '로컬 전사' }] }
    dispose() {}
  },
}))

beforeEach(async () => {
  localStorage.clear()
  await Promise.all([db.meetings.clear(), db.audioChunks.clear(), db.transcriptSegments.clear()])
})

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/upload']}>
      <Routes>
        <Route path="/upload" element={<Upload />} />
        <Route path="/meeting/:id" element={<div>회의록 도착</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function pickFile() {
  const file = new File(['x'], '주간회의.m4a', { type: 'audio/mp4' })
  const input = screen.getByTestId('file-input')
  await userEvent.upload(input, file)
}

test('Groq 키가 없으면 Groq 라디오가 비활성화된다', () => {
  renderPage()
  expect(screen.getByLabelText(/Groq/)).toBeDisabled()
})

test('로컬 엔진으로 전사하면 회의록으로 이동하고 세그먼트가 저장된다', async () => {
  renderPage()
  await pickFile()
  await userEvent.click(screen.getByRole('button', { name: /전사 시작/ }))
  await waitFor(() => expect(screen.getByText('회의록 도착')).toBeInTheDocument())
  const segs = await db.transcriptSegments.toArray()
  expect(segs).toHaveLength(1)
  expect(segs[0]).toMatchObject({ text: '로컬 전사', source: 'whisper', isFinal: true })
  const meetings = await db.meetings.toArray()
  expect(meetings[0]).toMatchObject({ title: '주간회의', status: 'done', durationSec: 2 })
})

test('Groq 소파일 경로는 원본 그대로 전송한다', async () => {
  saveSettings({ groqApiKey: 'gsk_1' })
  const { transcribeBlobWithGroq } = await import('../../core/stt/groq')
  renderPage()
  await pickFile()
  await userEvent.click(screen.getByLabelText(/Groq/))
  await userEvent.click(screen.getByRole('button', { name: /전사 시작/ }))
  await waitFor(() => expect(screen.getByText('회의록 도착')).toBeInTheDocument())
  expect(vi.mocked(transcribeBlobWithGroq)).toHaveBeenCalled()
  const segs = await db.transcriptSegments.toArray()
  expect(segs[0]).toMatchObject({ text: 'Groq 전사', source: 'groq' })
})

test('파일 선택 전에는 전사 시작이 비활성', () => {
  renderPage()
  expect(screen.getByRole('button', { name: /전사 시작/ })).toBeDisabled()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- Upload` → Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/ui/pages/Upload.tsx`:
```tsx
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadSettings } from '../../core/settings'
import { decodeTo16kMono } from '../../core/audio/decode'
import { detectWebGPU, WhisperLocalEngine, type WhisperProgress } from '../../core/stt/whisperLocal'
import { transcribeBlobWithGroq, transcribeSamplesWithGroq, GROQ_FILE_LIMIT } from '../../core/stt/groq'
import { createUploadMeeting, replaceSegments, finishMeeting } from '../../core/store/meetings'
import type { DraftSegment } from '../../core/stt/types'

type Engine = 'whisper' | 'groq'

export default function Upload() {
  const settings = loadSettings()
  const [file, setFile] = useState<File | null>(null)
  const [engine, setEngine] = useState<Engine>('whisper')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const hasGroqKey = settings.groqApiKey.length > 0

  function onWhisperProgress(p: WhisperProgress) {
    if (p.kind === 'download') { setStage(`모델 다운로드 중 — ${p.file}`); setProgress(p.progress) }
    else { setStage(p.message); setProgress(null) }
  }

  async function start() {
    if (!file || busy) return
    setBusy(true); setError(null)
    const title = file.name.replace(/\.[^.]+$/, '') || file.name
    let meetingId: string | null = null
    try {
      setStage('회의 생성 중…')
      const meeting = await createUploadMeeting(title, 0, file, file.type || 'audio/mpeg')
      meetingId = meeting.id
      let segs: DraftSegment[]
      let durationSec = 0

      if (engine === 'groq' && file.size <= GROQ_FILE_LIMIT) {
        setStage('Groq로 전사 중…')
        segs = await transcribeBlobWithGroq(file, file.name, {
          apiKey: settings.groqApiKey, language: settings.language,
        })
        durationSec = Math.round(segs.at(-1)?.endSec ?? 0)
      } else {
        setStage('오디오 디코딩 중… (긴 파일은 수십 초 걸릴 수 있어요)')
        const samples = await decodeTo16kMono(await file.arrayBuffer())
        durationSec = Math.round(samples.length / 16000)
        if (engine === 'groq') {
          segs = await transcribeSamplesWithGroq(samples, {
            apiKey: settings.groqApiKey, language: settings.language,
            onPart: (d, t) => { setStage(`Groq 분할 전사 중 (${d}/${t})`); setProgress((d / t) * 100) },
          })
        } else {
          const webgpu = await detectWebGPU()
          const model = webgpu ? settings.whisperModel : 'onnx-community/whisper-base'
          const eng = new WhisperLocalEngine()
          try {
            segs = await eng.transcribe(samples, {
              model, device: webgpu ? 'webgpu' : 'wasm', language: settings.language,
            }, onWhisperProgress)
          } finally {
            eng.dispose()
          }
        }
      }

      setStage('저장 중…')
      await replaceSegments(meetingId, segs.map(s => ({
        ...s, source: engine, isFinal: true,
      })))
      await finishMeeting(meetingId, durationSec)
      navigate(`/meeting/${meetingId}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('디코딩')
        ? `${msg} — Groq 경로는 원본을 그대로 전송하므로 성공할 수 있습니다.`
        : msg)
      setBusy(false); setStage(''); setProgress(null)
    }
  }

  return (
    <div>
      <h1>파일 업로드</h1>
      <p className="sub">녹음 파일을 올리면 브라우저 안에서(또는 내 Groq 키로) 전사합니다.</p>
      {error && <div className="alert alert-err" role="alert" style={{ marginTop: 14 }}>{error}</div>}

      <div
        className={`dropzone${dragOver ? ' drag-over' : ''}`}
        style={{ marginTop: 18 }}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault(); setDragOver(false)
          const f = e.dataTransfer.files[0]
          if (f) setFile(f)
        }}
      >
        <div className="icon">↑</div>
        <div style={{ fontWeight: 700, color: 'var(--text-strong)' }}>
          {file ? file.name : '클릭하거나 파일을 끌어다 놓으세요'}
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          m4a · mp3 · wav · webm · ogg {file && `(${(file.size / 1e6).toFixed(1)}MB)`}
        </div>
        <input ref={inputRef} data-testid="file-input" type="file" hidden
          accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg"
          onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>전사 엔진</h2>
        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="radio" id="eng-whisper" name="engine"
            checked={engine === 'whisper'} onChange={() => setEngine('whisper')} />
          <label htmlFor="eng-whisper">브라우저 Whisper <span className="hint">— 음성이 기기 밖으로 나가지 않음 · 최초 1회 모델 다운로드</span></label>
        </div>
        <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="radio" id="eng-groq" name="engine" disabled={!hasGroqKey}
            checked={engine === 'groq'} onChange={() => setEngine('groq')} />
          <label htmlFor="eng-groq">Groq (내 키) <span className="hint">
            — 빠름 · 오디오가 Groq로 전송됨{!hasGroqKey && ' · 설정에서 키를 등록하세요'}</span></label>
        </div>
      </section>

      <p style={{ marginTop: 18 }}>
        <button className="btn btn-primary" disabled={!file || busy} onClick={() => void start()}>
          {busy ? '처리 중…' : '전사 시작'}
        </button>
      </p>

      {busy && (
        <section className="card" style={{ marginTop: 8 }}>
          <div className="sub">{stage}</div>
          {progress !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <div className="progress" style={{ flex: 1 }}><i style={{ width: `${progress}%` }} /></div>
              <span className="progress-label">{Math.round(progress)}%</span>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
```

`src/App.tsx`: `/upload` 스텁 교체:
```tsx
import Upload from './ui/pages/Upload'
// ...
        <Route path="/upload" element={<Upload />} />
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- Upload` → Expected: 4 passed
Run: `npm test` → Expected: 전체 통과

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/Upload.tsx src/ui/pages/Upload.test.tsx src/App.tsx
git commit -m "feat: 업로드 화면 — 드롭존·엔진 선택·전사 파이프라인"
```

---

### Task 10: Meeting 재전사 + 세그먼트 소스 배지

**Files:**
- Modify: `src/ui/pages/Meeting.tsx`
- Test: `src/ui/pages/Meeting.test.tsx` (테스트 추가)

**Interfaces:**
- Consumes: `getMeetingAudio`, `replaceSegments`(Task 7), 전사 엔진들(Task 5·6), `loadSettings`, `decodeTo16kMono`
- Produces: 회의록 뷰에 [고품질 재전사] 버튼 — 클릭 시 엔진 선택(로컬/Groq, Upload와 동일 규칙) 후 저장된 원본 오디오를 재전사해 세그먼트 교체. 전사 소스 배지(`실시간`(webspeech)/`Whisper`/`Groq`)를 상단에 표시

**동작 규약:**
- `getMeetingAudio` → null이면 버튼 숨김
- 재전사 중 진행 상태 표시(Upload와 동일 패턴), 완료 후 세그먼트 다시 로드
- 재전사는 파괴적(기존 세그먼트 교체)이므로 `window.confirm('기존 전사를 새 결과로 교체할까요?')` 가드

- [ ] **Step 1: 실패하는 테스트 추가** (기존 파일에)

```tsx
vi.mock('../../core/audio/decode', () => ({
  decodeTo16kMono: vi.fn(async () => new Float32Array(16000)),
}))
vi.mock('../../core/stt/whisperLocal', () => ({
  detectWebGPU: vi.fn(async () => false),
  WhisperLocalEngine: class {
    async transcribe() { return [{ startSec: 0, endSec: 1, text: '재전사됨' }] }
    dispose() {}
  },
}))

test('오디오가 있으면 재전사 버튼이 보이고, 확인 후 세그먼트가 교체된다', async () => {
  const m = await seed()
  await appendAudioChunk(m.id, 0, new Blob(['aud']), 'audio/webm')
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderPage(m.id)
  await waitFor(() => screen.getByRole('button', { name: /재전사/ }))
  await userEvent.click(screen.getByRole('button', { name: /재전사/ }))
  await waitFor(() => expect(screen.getByText('재전사됨')).toBeInTheDocument())
  expect(screen.queryByText('첫 발언')).not.toBeInTheDocument()
  vi.restoreAllMocks()
})

test('오디오가 없으면 재전사 버튼이 없다', async () => {
  const m = await seed() // seed는 세그먼트만 추가, 오디오 없음
  renderPage(m.id)
  await waitFor(() => screen.getByText('첫 발언'))
  expect(screen.queryByRole('button', { name: /재전사/ })).not.toBeInTheDocument()
})
```
(import에 `appendAudioChunk`, `userEvent` 추가 확인)

- [ ] **Step 2: 실패 확인**

Run: `npm test -- Meeting` → Expected: FAIL

- [ ] **Step 3: 구현**

`Meeting.tsx`에 추가/수정 (핵심 변경만 — 파일 전체 구조는 유지):
```tsx
// 추가 import
import { replaceSegments } from '../../core/store/meetings'
import { loadSettings } from '../../core/settings'
import { decodeTo16kMono } from '../../core/audio/decode'
import { detectWebGPU, WhisperLocalEngine } from '../../core/stt/whisperLocal'
import { transcribeSamplesWithGroq } from '../../core/stt/groq'

// 상태 추가
const [audioAvailable, setAudioAvailable] = useState(false)
const [retranscribing, setRetranscribing] = useState<string | null>(null)

// 로드 효과 안에서: setAudioAvailable((await getMeetingAudio(id)) !== null)
// (기존 getMeetingAudio 호출과 중복 로드를 피하려면 여기서 한 번만 조회해 상태와 다운로드에 공용 사용해도 좋다)

async function retranscribe() {
  if (!meeting || !window.confirm('기존 전사를 새 결과로 교체할까요?')) return
  const settings = loadSettings()
  setRetranscribing('오디오 준비 중…')
  try {
    const blob = await getMeetingAudio(meeting.id)
    if (!blob) return
    const samples = await decodeTo16kMono(await blob.arrayBuffer())
    let segs
    let source: 'whisper' | 'groq'
    if (settings.groqApiKey) {
      source = 'groq'
      setRetranscribing('Groq로 전사 중…')
      segs = await transcribeSamplesWithGroq(samples, {
        apiKey: settings.groqApiKey, language: settings.language,
        onPart: (d, t) => setRetranscribing(`Groq 분할 전사 중 (${d}/${t})`),
      })
    } else {
      source = 'whisper'
      const webgpu = await detectWebGPU()
      const eng = new WhisperLocalEngine()
      try {
        setRetranscribing('브라우저 Whisper로 전사 중… (모델 다운로드가 필요할 수 있어요)')
        segs = await eng.transcribe(samples, {
          model: webgpu ? settings.whisperModel : 'onnx-community/whisper-base',
          device: webgpu ? 'webgpu' : 'wasm',
          language: settings.language,
        }, p => { if (p.kind === 'status') setRetranscribing(p.message) })
      } finally { eng.dispose() }
    }
    await replaceSegments(meeting.id, segs.map(s => ({ ...s, source, isFinal: true })))
    setSegments((await getSegments(meeting.id)).filter(s => s.isFinal))
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  } finally {
    setRetranscribing(null)
  }
}

// 버튼 영역에 추가 (오디오 다운로드 버튼 옆):
{audioAvailable && (
  <button className="btn btn-outline" disabled={retranscribing !== null} onClick={() => void retranscribe()}>
    {retranscribing ?? '고품질 재전사'}
  </button>
)}

// 소스 배지 (제목 아래): 세그먼트가 있으면 첫 세그먼트의 source 기준
{segments.length > 0 && (
  <span className={`badge ${segments[0].source === 'webspeech' ? 'badge-gray' : 'badge-accent'}`}>
    {segments[0].source === 'webspeech' ? '실시간 자막' : segments[0].source === 'whisper' ? 'Whisper 전사' : 'Groq 전사'}
  </span>
)}
```
(재전사 엔진 선택 규칙: Groq 키가 있으면 Groq 우선(빠름), 없으면 로컬 Whisper — Upload처럼 별도 선택 UI 없이 단순화. Groq를 원치 않는 사용자는 키를 비우면 됨. 이 규칙을 버튼 hint로 표기: 키 존재 시 "Groq 사용", 아니면 "브라우저 Whisper 사용")

- [ ] **Step 4: 통과 확인**

Run: `npm test -- Meeting` → Expected: 6 passed (기존 4 + 신규 2)
Run: `npm test` → Expected: 전체 통과

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/Meeting.tsx src/ui/pages/Meeting.test.tsx
git commit -m "feat: 회의록 재전사 및 전사 소스 배지"
```

---

### Task 11: Home·Record·Meeting 테마 리스타일

**Files:**
- Modify: `src/ui/pages/Home.tsx`, `src/ui/pages/Record.tsx`, `src/ui/pages/Meeting.tsx`
- Test: 기존 테스트 유지 (텍스트·role 기반이라 클래스 변경에 안전). Home에 카드 클래스 단언 1개 추가

**Interfaces:**
- Consumes: theme.css 클래스
- Produces: 시각 리스타일 (기능 변화 없음)

**규약:**
- 각 페이지 최상위 `<main>` → `<div>` (AppShell이 main 제공)
- **Home**: 회의 목록을 `.card-grid`의 `.card.hoverable` 카드로 (제목 + `.muted` 날짜·길이 + `.badge-ok` "확정" 스타일 상태 + 삭제는 `.btn-ghost .btn-sm`). [녹음 시작]/[파일 업로드] `.btn-primary`/`.btn-outline` 헤더 버튼. 복구 배너는 `.alert-warn` (role="alert" 유지). 용량 게이지는 `.progress` + `.muted` 라벨
- **Record**: 상태·경과시간을 카드 헤더로, 실시간 자막 영역 `.card`(final은 본문색, interim은 `--text-muted`), 프라이버시 고지 `.hint`. 시작/종료 `.btn-primary`
- **Meeting**: 제목 input `.input`(테두리 없는 큰 제목 스타일: `style={{fontSize:20, fontWeight:800, border:'none', background:'transparent', padding:0}}` + 포커스 시 기본 outline), 내보내기 버튼들 `.btn-outline .btn-sm`, 세그먼트는 `.card` 안에 `[.seg-time] 텍스트` 행
- 기존 테스트가 깨지면 **텍스트/시맨틱은 유지**하는 방향으로 마크업만 조정 (예: role="alert", 버튼 이름 불변)

- [ ] **Step 1: Home 테스트에 카드 단언 추가**

```tsx
test('회의 카드에 테마 클래스가 적용된다', async () => {
  const m = await createMeeting()
  await finishMeeting(m.id, 60)
  renderHome()
  await waitFor(() => screen.getByText(m.title))
  expect(screen.getByText(m.title).closest('.card')).not.toBeNull()
})
```

- [ ] **Step 2: 실패 확인** — `npm test -- Home` → FAIL (카드 클래스 없음)

- [ ] **Step 3: 3개 페이지 리스타일 구현** — 위 규약대로 JSX 구조 조정. 로직(함수·상태·store 호출)은 변경하지 않는다. Home 헤더는:
```tsx
<div className="row" style={{ marginBottom: 22 }}>
  <div>
    <h1>회의록</h1>
    <p className="sub">모든 데이터는 이 브라우저에만 저장됩니다</p>
  </div>
  <div style={{ display: 'flex', gap: 8 }}>
    <Link to="/record" className="btn btn-primary">🎙️ 녹음 시작</Link>
    <Link to="/upload" className="btn btn-outline">파일 업로드</Link>
  </div>
</div>
```

- [ ] **Step 4: 통과 확인**

Run: `npm test` → Expected: 전체 통과 (기존 단언 전부 유지)
Run: `npm run dev` → 브라우저에서 홈·녹음·업로드·설정·회의록 화면이 minutelog 스타일(흰 카드/블루 액센트/Pretendard)로 보이는지 확인

- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/
git commit -m "feat: 홈·녹음·회의록 화면 테마 리스타일"
```

---

### Task 12: 빌드 검증 + README 갱신

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 전체 검증**

```bash
npm test          # Expected: 전체 통과
npm run build     # Expected: 성공
find dist -size +20M   # Expected: 출력 없음 (transformers.js는 코드만 번들, 모델은 런타임 로드)
```

- [ ] **Step 2: README의 "현재 기능" 섹션 갱신**

`## 현재 기능 (v1 core)` 섹션을 다음으로 교체:
```markdown
## 현재 기능

- 실시간 녹음 + 실시간 자막 (Chrome, Web Speech API)
- **녹음 파일 업로드 전사** — 브라우저 내 Whisper(WebGPU, 음성이 기기 밖으로 안 나감)
  또는 내 Groq 무료 키로 고속 전사 (25MB 초과 파일은 자동 분할)
- 완료된 회의의 **고품질 재전사** (실시간 자막 → Whisper/Groq 결과로 교체)
- 10초 단위 증분 저장 — 탭이 죽어도 그 시점까지 복구
- 회의록 보기·제목 편집·Markdown/TXT 내보내기·원본 오디오 다운로드
- minutelog 디자인 언어 (Pretendard · 카드 UI)

로드맵: 화자 분리(Plan 3), AI 요약(Gemini BYOK)·PWA(Plan 4).
```

- [ ] **Step 3: Commit** (push는 컨트롤러가 최종 리뷰 후)

```bash
git add README.md
git commit -m "docs: README 기능 목록 갱신 (업로드 전사)"
```

---

## Self-Review 결과 (작성자 체크)

1. **스펙 커버리지**: §4-②(transformers.js 모델·WebGPU/WASM 분기·진행률·Cache API 자동) Task 5, §4-③(Groq 25MB 분할·429 백오프·한도 안내) Task 6, §7 개정판(16kHz 통디코딩·√2 다운믹스·방어 리샘플·WAV 분할·Groq 원본 직송) Task 4·9, §8(업로드/설정 화면) Task 8·9, §14(디자인 언어) Task 1·2·11. 재전사는 §4-② "재전사 가능" 요구 구현(Task 10). 화자분리(§13)는 Plan 3, 요약(§5)·PWA는 Plan 4로 이월.
2. **플레이스홀더 스캔**: 없음. Task 11만 "규약 + 핵심 코드" 수준(순수 시각 변경, 기존 테스트가 안전망)이고 나머지는 전부 실코드.
3. **타입 일관성**: `DraftSegment`(Task 5 정의 → 6·9·10 사용), `decodeTo16kMono(ArrayBuffer)`(4→9·10), `transcribeSamplesWithGroq(samples, {onPart})`(6→9·10), `createUploadMeeting`/`replaceSegments`(7→9·10), `AppSettings`(3→8·9·10) 시그니처 일치 확인. Task 4 Step 1의 `-32768` 기대값은 Step 4 참고에 명시된 대로 `-32767`로 작성.
4. **알려진 리스크**: whisper.worker.ts의 transformers.js 실호출은 jsdom에서 검증 불가(프로토콜 레벨만 테스트) — Task 12 수동 검증 + Plan 4 Playwright에서 실검증. Vite 워커 번들·@huggingface/transformers의 빌드 호환은 Task 5 Step 4의 `npm run build`로 조기 확인.
