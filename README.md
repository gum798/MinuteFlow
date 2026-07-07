# MinuteFlow — 브라우저에서 완결되는 음성 회의록

서버 없이 동작하는 음성 회의록 웹앱. 녹음·전사·저장이 모두 브라우저 안에서
이루어지며, 데이터는 이 기기의 브라우저(IndexedDB)에만 저장됩니다.

## 현재 기능

- 실시간 녹음 + 실시간 자막 (Chrome, Web Speech API)
- **녹음 파일 업로드 전사** — 브라우저 내 Whisper(WebGPU, 음성이 기기 밖으로 안 나감)
  또는 내 Groq 무료 키로 고속 전사 (25MB 초과 파일은 자동 분할)
- 완료된 회의의 **고품질 재전사** (실시간 자막 → Whisper/Groq 결과로 교체)
- **화자 구분** — 브라우저 안에서 누가 말했는지 자동 분리 (음성이 밖으로 안 나감), 화자 이름 편집·색상 표시
- 10초 단위 증분 저장 — 탭이 죽어도 그 시점까지 복구
- 회의록 보기·제목 편집·Markdown/TXT 내보내기·원본 오디오 다운로드
- minutelog 디자인 언어 (Pretendard · 카드 UI)

로드맵: AI 요약(Gemini BYOK)·PWA(Plan 4).

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
