# MinuteFlow 디자인 토큰 (minutelog 디자인 언어 이식)

출처: `/Users/seojeonghwa/project/minutelog` 분석 (2026-07-07). minutelog는 인라인 스타일로 하드코딩되어 있으므로, MinuteFlow에서는 아래 값을 **CSS 커스텀 프로퍼티**(`src/ui/theme.css`)로 정의해 사용한다.

## 폰트

- 패밀리: `'Pretendard Variable', Pretendard, -apple-system, 'Noto Sans KR', sans-serif`
- 로딩 (index.html):
  ```html
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
  ```
- 크기: 페이지 제목 23px(w800, ls -0.4px) / 카드 제목 16px(w700, ls -0.2px) / 본문 13.5px / 보조 12.5px / 스몰 12px / 타이니 11.5px
- 웨이트: 500 기본 / 600 라벨·버튼 / 700 강조·배지 / 800 제목·수치

## 색상 (CSS 변수 정의안)

```css
:root {
  --bg: #F4F5F9;            /* 앱 배경 */
  --surface: #FFFFFF;       /* 카드 */
  --accent: #1E43B8;        /* 브랜드 블루 */
  --accent-hover: #16359B;
  --accent-soft: #EEF2FD;   /* 선택·active·태그칩 배경 */
  --accent-softer: #F3F6FE;
  --accent-border: #C9D4EE; /* hover 보더 */
  --text-strong: #1A2033;
  --text-body: #3D4657;
  --text-sub: #555E73;
  --text-muted: #8A93A8;
  --placeholder: #9AA3B8;
  --border: #E4E7EE;
  --border-soft: #EDEFF4;
  --input-border: #D8DDE8;
  --drop-border: #C4CFE8;
  --highlight: #FFE59E;     /* 키워드 하이라이트 */
  --chip-dark: #1A2033;     /* 툴팁·토스트 */
  /* 시맨틱 */
  --ok-fg: #15803D;  --ok-bg: #E7F5EC;
  --warn-fg: #B45309; --warn-bg: #FBF4E4;
  --err-bg: #FBEAE8;
}
```

## 상태 배지

| 상태 | bg | fg |
|---|---|---|
| 변환 중 | #EEF2FD | #1E43B8 |
| 초안 | #F1F2F6 | #555E73 |
| 검토 중 | #FBF4E4 | #B45309 |
| 확정 | #E7F5EC | #15803D |

배지 형태: `border-radius:999; padding:3px 10px; font-size:12px; font-weight:700; display:inline-flex; gap:6px`. 진행 중이면 6px 펄스 닷 (`@keyframes pulseDot { 0%,100%{opacity:1} 50%{opacity:.3} }`, 1.2s infinite).

## 화자 팔레트 (8색, {fg, bg})

```ts
export const SPEAKER_COLORS = [
  { fg: '#0E7490', bg: '#E5F3F6' }, { fg: '#7C3AED', bg: '#F1ECFC' },
  { fg: '#B45309', bg: '#FAF0E1' }, { fg: '#BE185D', bg: '#FAE8F0' },
  { fg: '#15803D', bg: '#E7F5EC' }, { fg: '#4F46E5', bg: '#EEF0FD' },
  { fg: '#0369A1', bg: '#E3F1FA' }, { fg: '#A21CAF', bg: '#F8EAFA' },
]
```
아바타 배경 변형: `fg + '1A'` (10% 알파). 아바타는 원형, `border:2px solid #fff`, 겹칠 때 `margin-left:-7px`.

## 레이아웃

- 사이드바: 고정 228px, 흰 배경, `border-right:1px solid var(--border)`, padding `20px 14px 16px`. 상단 30×30 라운드 로고(radius 8, accent 배경 흰 글자) + nav 스택. 좁은 화면(≤880px)은 상단 sticky 바로 대체
- 콘텐츠: `margin:0 auto`, max-width 1080~1160, padding `32px 36px 48px`
- 카드: `background:#fff; border:1px solid var(--border); border-radius:12px; padding:18~22px`. hover: `box-shadow:0 4px 16px rgba(26,32,51,.08); border-color:var(--accent-border)`
- 카드 그리드: `repeat(auto-fill, minmax(320px,1fr)); gap:16px`
- 여백 리듬: 섹션 간 22~24px, 요소 간 4/8/10/14/16px

## 컴포넌트

- **Primary 버튼**: h38(작은 것 34), border:none, radius 9(작은 것 8), accent 배경 흰 글자 w600~700, hover accent-hover
- **Outline 버튼**: `1px solid var(--input-border)`, radius 9, 흰 배경 `--text-body`, hover 시 보더·글자 accent
- **Ghost 버튼**: 투명, hover `--accent-soft`
- **입력/셀렉트**: h38, padding 0 12px, `1px solid var(--input-border)`, radius 9, 13.5px. 포커스: `outline:2px solid var(--accent); outline-offset:-1px`
- **토글**: 38×22 radius 999, on accent / off #D4D9E4, 노브 16×16 흰색
- **진행률 바**: 트랙 h8 radius 999 `--border-soft` overflow hidden; 채움 accent, `transition:width .2s`; 퍼센트 텍스트 accent w700
- **드롭존**: `2px dashed var(--drop-border); border-radius:14px; padding:52px 24px;` 중앙정렬, 상단 52×52 원형 아이콘(accent-soft 배경 accent ↑). 드래그오버: `background:var(--accent-softer); border-color:var(--accent)`. `transition: border-color .15s, background .15s`
- **파이프라인 스테퍼**: 30×30 원형 노드 — done: accent 배경 흰글자 / active: accent-soft + `2px solid` accent / 대기: #F1F2F6 회색. 커넥터 2px 라인 (진행 accent / 미진행 --border)
- **토스트**: 하단 중앙 고정, chip-dark 배경 흰 글자, radius 999, `box-shadow:0 8px 24px rgba(26,32,51,.25)`
- **툴팁**: 순수 CSS `.tip[data-tip]::after` — chip-dark 배경, 11.5px 흰 글자, radius 7

## 전역 CSS 베이스

```css
body { margin: 0; background: var(--bg); color: var(--text-strong); }
* { box-sizing: border-box; }
button, input, select, textarea { font-family: inherit; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
::placeholder { color: var(--placeholder); }
```

다크모드: minutelog는 미지원. MinuteFlow도 v1은 라이트 전용으로 가고, 변수화해뒀으므로 추후 `prefers-color-scheme`로 확장 가능.
