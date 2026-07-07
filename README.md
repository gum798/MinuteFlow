# MinuteFlow — 브라우저에서 완결되는 음성 회의록

서버 없이 동작하는 음성 회의록 웹앱. 녹음·전사·저장이 모두 브라우저 안에서
이루어지며, 데이터는 이 기기의 브라우저(IndexedDB)에만 저장됩니다.

## 현재 기능

- 실시간 녹음 + 실시간 자막 (Chrome, Web Speech API)
- **녹음 파일 업로드 전사** — 브라우저 내 Whisper(WebGPU, 음성이 기기 밖으로 안 나감)
  또는 내 Groq 무료 키로 고속 전사 (25MB 초과 파일은 자동 분할)
- 완료된 회의의 **고품질 재전사** (실시간 자막 → Whisper/Groq 결과로 교체)
- **화자 구분** — 브라우저 안에서 누가 말했는지 자동 분리 (음성이 밖으로 안 나감), 화자 이름 편집·색상 표시
- **AI 요약** — 내 Gemini 무료 키로 회의록/짧은 요약/타임라인 자동 작성. 키가 없으면
  "AI 프롬프트 복사"로 ChatGPT 등에 붙여넣어 사용
- 10초 단위 증분 저장 — 탭이 죽어도 그 시점까지 복구, 페이지를 옮겨도 녹음 유지
- 회의록 보기·제목 편집·**Markdown/TXT/DOCX** 내보내기·원본 오디오 다운로드
- **PWA** — 홈 화면에 설치 가능, 모델을 받아두면 전사·화자 구분은 오프라인에서도 동작
- minutelog 디자인 언어 (Pretendard · 카드 UI), 모바일 대응

## 데이터·프라이버시

- 모든 회의 데이터는 이 기기의 브라우저(IndexedDB)에만 저장됩니다 — 서버가 없습니다
- 전사(Whisper)와 화자 구분은 기기 안에서 처리되어 음성이 밖으로 나가지 않습니다
- AI 요약을 쓰면 전사 텍스트가 본인 키로 Google Gemini에 전송됩니다 (선택 사항)
- API 키는 이 브라우저의 localStorage에만 저장됩니다

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
