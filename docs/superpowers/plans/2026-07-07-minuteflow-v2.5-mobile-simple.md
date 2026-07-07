# MinuteFlow Plan 2.5 — 모바일 대응 + 심플 UI (상세 숨김) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모바일 화면(320px~)에서 전 화면이 자연스럽게 동작하고, 기술적 선택지(엔진·모델 등)를 기본 화면에서 숨겨 "누르면 그냥 되는" 경험으로 단순화한다.

**Architecture:** 로직 변경 없음 — 표현 계층만. 자동 엔진 선택은 이미 재전사(Meeting)에 있는 규칙(Groq 키 있으면 Groq, 없으면 로컬)을 Upload에도 기본값으로 적용하고, 수동 선택은 `<details>` 고급 영역으로 이동. 설정도 키 입력만 남기고 나머지는 접는다.

**Tech Stack:** 기존 스택 그대로. `<details>/<summary>` 네이티브 요소로 접기(JS 불필요, 접근성 무료).

**사용자 요구 (2026-07-07):** "모바일도 되게, 심플하게, 상세한 건 모두 숨겨서 어렵게 느껴지지 않게"

## Global Constraints

- **로직 변경 금지** — 전사 파이프라인·스토어 호출은 그대로. 기본값 결정 로직 1곳(Upload 엔진 자동 선택)만 예외이며, 재전사와 동일 규칙 사용
- 기존 테스트의 시맨틱(role, 라벨) 유지. 라디오가 `<details>` 안으로 들어가도 `getByLabelText`는 동작함 (jsdom은 details 내용을 렌더함)
- 색·크기는 theme.css 변수/클래스로. 미디어쿼리는 theme.css의 기존 880px 브레이크포인트 + 신규 560px(폰) 사용
- TDD (표현 변경은 클래스/텍스트 단언), conventional commits

---

### Task 1: Upload 심플화 — 자동 엔진 + 고급 접기

**Files:**
- Modify: `src/ui/pages/Upload.tsx`
- Test: `src/ui/pages/Upload.test.tsx` (기존 4개 유지 + 조정 최소화 + 신규 1)

**동작 규약:**
- `engine` 초기값을 자동 결정: `loadSettings().groqApiKey ? 'groq' : 'whisper'` (마운트 시 1회 — useState 초기화 함수)
- 엔진 라디오 카드 전체를 `<details className="card advanced">`로 감싸고 `<summary>고급 설정</summary>` 뒤에 배치. 기본 닫힘
- 드롭존 위 안내 문구를 한 줄로 단순화: "녹음 파일을 올리면 자동으로 회의록을 만들어드려요." (엔진·키·기술 용어는 고급 영역과 힌트에만)
- 대용량/모바일 Groq 권장 힌트는 고급 영역 안으로 이동
- 진행 카드의 stage 문구는 유지 (진행 중 정보는 숨기지 않음)
- 기존 테스트 중 "Groq 키가 없으면 Groq 라디오 비활성" / "Groq 소파일 경로" 테스트는 라디오가 details 안에 있어도 통과해야 함. "Groq 소파일" 테스트에서 라디오 클릭 전 `details`가 닫혀 있어도 jsdom에서 클릭 가능 — 만약 userEvent가 실패하면 테스트에서 먼저 summary를 클릭
- 신규 테스트: 키가 저장돼 있으면 마운트 시 Groq가 이미 선택돼 있다 (`expect(screen.getByLabelText(/Groq/)).toBeChecked()`)

- [ ] Step 1: 신규 테스트 작성 → RED
- [ ] Step 2: 구현 → GREEN + 전체 통과
- [ ] Step 3: Commit `feat: 업로드 자동 엔진 선택 및 고급 설정 접기`

`theme.css`에 추가할 클래스 (Task 3에서 일괄 추가하지 말고 이 태스크에서):
```css
details.advanced > summary {
  cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--text-muted);
  list-style: none; display: flex; align-items: center; gap: 6px;
}
details.advanced > summary::before { content: '▸'; transition: transform .15s; }
details.advanced[open] > summary::before { transform: rotate(90deg); }
details.advanced > summary::-webkit-details-marker { display: none; }
details.advanced[open] > summary { margin-bottom: 12px; }
```

---

### Task 2: 설정 심플화 — 키 카드만 기본 노출

**Files:**
- Modify: `src/ui/pages/Settings.tsx`
- Test: `src/ui/pages/Settings.test.tsx` (기존 4개 유지)

**동작 규약:**
- 기본 노출: 제목 + "이 브라우저에만 저장" 문구 + **Groq API 키 카드**(발급 링크 포함) + [저장]
- Whisper 모델 카드 + 언어 카드를 `<details className="advanced">`(카드 밖 래퍼)로 묶고 `<summary>고급 설정 (전사 모델·언어)</summary>`. 기본 닫힘
- WebGPU 배지는 고급 영역 안(모델 카드 위치 그대로)
- 키 설명 문구 단순화: "무료로 발급받아 넣으면 파일 전사가 훨씬 빨라져요." + 발급 링크. "하루 오디오 8시간" 등 수치는 hint로 유지
- 기존 테스트 4개는 라벨 기반이라 details 안에서도 통과 (WebGPU 미지원 배지 테스트 포함 — jsdom은 닫힌 details 내용도 DOM에 있음)

- [ ] Step 1: 기존 테스트가 계속 통과하는 구조인지 확인하며 리팩터 → 전체 GREEN
- [ ] Step 2: Commit `feat: 설정 화면 고급 설정 접기`

---

### Task 3: 모바일 반응형 마감

**Files:**
- Modify: `src/ui/theme.css`, (필요시) `src/ui/pages/Home.tsx`
- Test: `src/ui/theme.test.ts`에 560px 블록 존재 단언 1개 추가

**규약 (theme.css에 560px 블록 추가):**
```css
@media (max-width: 560px) {
  .content { padding: 16px 12px 32px; }
  h1 { font-size: 20px; }
  .card-grid { grid-template-columns: 1fr; }
  .row { flex-wrap: wrap; }
  .btn { height: 42px; }             /* 터치 타깃 */
  .dropzone { padding: 32px 16px; }
  .sidebar { overflow-x: auto; }     /* nav 스크롤 */
  .toast { width: calc(100% - 32px); max-width: 360px; text-align: center; }
}
```
- Home 헤더의 버튼 그룹이 랩될 때 자연스럽도록 `.row`에 `row-gap` 추가: 기존 `.row` 정의에 `flex-wrap: wrap;` 넣지 말고 위 미디어쿼리에서만
- Record 페이지에 모바일 안내 1줄 추가 (스펙 §6): 녹음 중일 때 `<p className="hint">모바일에서는 화면을 켠 채 이 탭을 유지해주세요.</p>`
- 수동 확인: `npm run dev` + 브라우저 개발자도구 375px/320px에서 홈·녹음·업로드·설정·회의록 5화면 가로 스크롤 없음

- [ ] Step 1: theme 테스트 1개 추가 → RED → CSS 구현 → GREEN
- [ ] Step 2: Record 안내 추가 (기존 테스트 유지)
- [ ] Step 3: 전체 테스트 + 빌드 → Commit `feat: 모바일 반응형 마감 및 녹음 화면 모바일 안내`

---

## Self-Review

- 스펙 §6 모바일 안내("화면을 켜둔 채 유지") 이행: Task 3. §8 화면 요구는 불변
- 로직 변경: Upload 엔진 초기값 1곳만 (재전사와 동일 규칙 — 새 동작 아님)
- 타입/시그니처 변경 없음. 기존 92개 테스트 유지 + 신규 2개
