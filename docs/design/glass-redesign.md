# MinuteFlow 글래스 리디자인 스펙 (2026-07-07)

사용자 브리프: "모바일에 최적화 + 아이폰처럼 글래스 UI" (참조: simpleparser.pages.dev의 유리 변수 기법).
원칙: 기존 클래스 계약(.card/.btn*/.input/.badge/.progress/.dropzone/.toast/.alert*/.rec-chip 등)을 유지해 페이지 수정 최소화. 시그니처는 하나 — **Dynamic Island 녹음 캡슐**.

## 1. 토큰 (theme.css :root 교체)

```css
:root {
  --bg-base: #EEF1F7;
  --text-strong: #0F1222;
  --text-body: #2A3145;
  --text-sub: rgba(15, 18, 34, 0.66);
  --text-muted: rgba(15, 18, 34, 0.45);
  --placeholder: rgba(15, 18, 34, 0.35);
  --accent: #1E43B8;            /* 브랜드 유지 */
  --accent-hover: #16359B;
  --accent-soft: rgba(30, 67, 184, 0.10);
  --accent-border: rgba(30, 67, 184, 0.35);
  /* 유리 */
  --glass: rgba(255, 255, 255, 0.60);
  --glass-strong: rgba(255, 255, 255, 0.78);
  --glass-weak: rgba(255, 255, 255, 0.38);
  --glass-border: rgba(255, 255, 255, 0.65);
  --glass-edge: rgba(15, 18, 34, 0.06);   /* 유리 아래쪽 미세 경계 */
  --glass-blur: 20px;
  --glass-shadow: 0 8px 32px rgba(15, 18, 34, 0.10);
  --island: rgba(18, 20, 30, 0.82);        /* 다이내믹 아일랜드/토스트 다크 유리 */
  /* 시맨틱 (유리 위 가독 확보를 위해 채도 소폭 상향) */
  --ok-fg: #0F7A3D; --ok-bg: rgba(52, 199, 89, 0.16);
  --warn-fg: #A05A00; --warn-bg: rgba(255, 159, 10, 0.16);
  --err-fg: #C0261C; --err-bg: rgba(255, 59, 48, 0.14);
  --rec: #E5484D;                           /* 녹음 레드 (iOS record) */
  --border: var(--glass-edge);              /* 구계약 별칭 */
  --border-soft: rgba(15, 18, 34, 0.05);
  --input-border: rgba(15, 18, 34, 0.12);
  --drop-border: rgba(30, 67, 184, 0.28);
  --highlight: #FFE59E;
  --chip-dark: var(--island);
  --font: 'Pretendard Variable', Pretendard, -apple-system, 'Noto Sans KR', sans-serif;
}
```
(주의: 기존 변수명은 전부 유지하되 값만 유리 체계로 — `--bg`→`--bg-base` 처럼 이름을 바꾸지 말고 `--bg: var(--bg-base)` 별칭 유지. `--surface`는 `var(--glass)` 별칭. theme.test.ts의 hex 단언은 새 값으로 갱신하되 "변수 정의에만 accent hex 존재" 가드는 유지)

## 2. 앰비언트 캔버스 (body)

```css
body { background: var(--bg-base); }
body::before {
  content: ''; position: fixed; inset: -20%; z-index: -1; pointer-events: none;
  background:
    radial-gradient(40% 34% at 18% 12%, rgba(30, 67, 184, 0.16), transparent 70%),
    radial-gradient(36% 30% at 85% 8%, rgba(124, 58, 237, 0.12), transparent 70%),
    radial-gradient(44% 38% at 70% 88%, rgba(14, 116, 144, 0.12), transparent 70%);
  filter: blur(48px);
}
body.is-recording::before { animation: breathe 9s ease-in-out infinite; }
@keyframes breathe {
  0%, 100% { transform: translateY(0) scale(1); opacity: 1; }
  50% { transform: translateY(-2%) scale(1.04); opacity: 0.85; }
}
@media (prefers-reduced-motion: reduce) { body.is-recording::before { animation: none; } }
```
- `is-recording` 클래스는 AppShell에서 recording.phase !== 'idle'일 때 `document.body.classList` 토글 (useEffect)

## 3. 유리 패널 공통

```css
.card, .sidebar, .toast, .theme-glass {
  background: var(--glass);
  backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
}
.card { border-radius: 20px; padding: 20px; }
```
- backdrop-filter 미지원 폴백: `@supports not (backdrop-filter: blur(1px)) { .card, .sidebar { background: rgba(255,255,255,0.92); } }`

## 4. 컴포넌트

- **버튼**: `.btn` 높이 44(데스크톱 40), radius 14, w600. `.btn-primary` accent 채움 + `box-shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 4px 14px rgba(30,67,184,.35)`. `.btn-outline` → 유리 버튼(`background: var(--glass-weak)` + blur + `border: 1px solid var(--input-border)`). `.btn-ghost` 투명 → hover `var(--accent-soft)`
- **입력/셀렉트**: 유리 인셋 — `background: var(--glass-weak)`, blur 12px, radius 12, focus는 기존 outline 유지
- **배지**: pill 유지, 시맨틱 bg 변수로. `.badge-accent`는 `--accent-soft`/accent
- **진행률**: 트랙 `rgba(15,18,34,0.08)`, 채움 accent, radius 999 유지
- **드롭존**: 유리 위 dashed `--drop-border`, radius 20, hover 시 `--accent-soft` 배경
- **토스트**: `--island` 다크 유리 + blur, radius 999 유지 (.toast-action 색 `#9DB8FF`)
- **.rec-chip**: `background: rgba(229,72,77,0.14); color: var(--rec);` 유지 (Home 헤더용)

## 5. 레이아웃

**데스크톱**: 사이드바를 떠 있는 유리 레일로 — `margin: 12px; height: calc(100vh - 24px); border-radius: 22px; position: sticky; top: 12px;` 내용 `.content` 최대폭 유지
**모바일 (≤880px)**: 사이드바 숨김(`display:none`) → **하단 탭 바**:
```css
.tabbar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 50;
  display: none;
  padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
  background: var(--glass-strong);
  backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  border-top: 1px solid var(--glass-border);
}
.tabbar a { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 4px 0; border-radius: 12px; font-size: 11px; font-weight: 600;
  color: var(--text-muted); text-decoration: none; }
.tabbar a .glyph { font-size: 20px; line-height: 1; }
.tabbar a.active { color: var(--accent); }
@media (max-width: 880px) {
  .sidebar { display: none; }
  .tabbar { display: flex; }
  .content { padding: 20px 16px calc(84px + env(safe-area-inset-bottom)); }
}
```
- AppShell: 기존 NavLink 4개를 `.tabbar`에도 렌더 (glyph: 홈 ⌂ → '🏠'식 이모지 대신 단순 텍스트 글리프 '●'류 지양 — **이모지 사용**: 🏠 🎙️ 📁 ⚙️ — 시스템 이모지가 iOS 감성에 자연스러움). 데스크톱 사이드바는 유지(기존 테스트 보존)
- 560px 블록의 기존 규칙 유지·조정 (sidebar overflow 규칙은 제거 가능 — 탭바로 대체)

## 6. 시그니처 — Dynamic Island 녹음 캡슐

사이드바 rec-chip을 **전 화면 공통 아일랜드**로 대체 (AppShell):
```tsx
{recording.phase !== 'idle' && (
  <Link to="/record" className="island" aria-label="녹음 중 — 녹음 화면으로">
    <span className="island-dot" />녹음 중 · {formatTimestamp(recording.elapsedSec)}
  </Link>
)}
```
```css
.island {
  position: fixed; top: calc(10px + env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
  z-index: 100; display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 18px; border-radius: 999px;
  background: var(--island); color: #fff;
  backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  box-shadow: 0 10px 30px rgba(15, 18, 34, 0.35);
  font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums;
  text-decoration: none;
  animation: island-in 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.island-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--rec);
  animation: pulseDot 1.2s infinite; }
@keyframes island-in { from { transform: translateX(-50%) translateY(-16px) scale(0.8); opacity: 0; }
  to { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .island { animation: none; } }
```
- 사이드바의 기존 rec-chip 렌더는 제거 (AppShell 테스트의 '녹음 중' 칩 단언은 island로 이전 — href 단언 유지)

## 7. 테스트 영향

- theme.test.ts: hex 단언을 새 토큰 값으로 갱신 (`--accent: #1E43B8` 유지라 가드 존속), 클래스 계약 목록에 `.tabbar`, `.island` 추가
- AppShell.test: rec-chip → island 클래스/텍스트로 조정 (텍스트 '녹음 중'과 href는 동일해 최소 수정), 탭바 링크 존재 단언 1개 추가 가능
- 나머지 페이지 테스트는 텍스트/role 기반이라 무영향 예상

## 8. 마감 기준

- 375px·320px에서 가로 스크롤 없음, 터치 타깃 ≥44px, focus-visible 유지, reduced-motion 존중
- `npm test`·tsc·build green, 배포 산출물 한도 준수
