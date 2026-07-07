# MinuteFlow 설계 문서

**작성일**: 2026-07-06 · **개정**: 2026-07-07 (v1.1 — 화자 분리 범위 편입, UI 디자인 언어 확정)
**상태**: 승인됨 (Plan 1 구현·배포 완료: https://minuteflow.pages.dev)

## 1. 개요

MinuteFlow는 **서버 없이 브라우저에서 완전히 동작하는 음성 회의록 웹 서비스**다. 실시간 녹음 또는 녹음 파일 업로드로 음성을 받아 전사(STT)하고, 사용자가 원하면 본인의 무료 API 키(BYOK)로 AI 회의록 요약까지 생성한다. 불특정 다수에게 공개되는 서비스이며, **운영·유지비가 0원**이어야 한다.

### 목표

- 설치·가입·키 발급 없이 접속 즉시 실시간 전사 사용 가능 (Chrome 기준)
- 녹음 파일 업로드 → 브라우저 내 Whisper로 전사 (음성이 기기 밖으로 나가지 않음)
- BYOK(Gemini 등 무료 키)로 고품질 회의록 요약 — 선택 사항
- 모든 데이터는 브라우저 로컬(IndexedDB)에만 저장, 내보내기로 보관
- 순수 정적 사이트 → Cloudflare Pages 무료 플랜에서 비용 0원 보장

### 비목표 (v1에서 제외)

- 계정·클라우드 동기화
- 서버 사이드 처리 일체 (Pages Functions 포함 — 쓰는 순간 Workers 일 10만 요청 쿼터에 묶임)
- 모바일 백그라운드 녹음 (웹 플랫폼 제약상 불가 — Android 9+ 백그라운드 마이크 차단)

## 2. 검증된 기술 전제 (2026-07 웹 리서치)

설계의 근거가 되는 사실들. 무료 티어 정책은 변동 가능하므로 앱 내에서는 대략치로 표기하고 공식 한도 페이지 링크를 함께 노출한다.

| 전제 | 내용 | 출처 |
|---|---|---|
| Cloudflare Pages 정적 서빙 | 요청·대역폭 **무료·무제한** (공식). 파일당 25MiB 제한 → 대형 모델 직접 호스팅 불가 | developers.cloudflare.com |
| Web Speech API | 사실상 **Chrome 전용** — Edge는 API 객체만 있고 실제 no-op, Safari continuous 불안정(iOS 사용 불가), Firefox 기본 비활성. ko-KR 지원, 무료·무쿼터. 무음 7~10초/60초 타임아웃으로 자동 중단 → 재시작 루프 필수 | caniuse.com, MDN |
| Chrome 온디바이스 인식 | Chrome 139+ `processLocally=true` — 음성이 Google로 전송되지 않음. ko-KR 포함 17개 언어. `available()`/`install()`로 모델 준비 | MDN (SpeechRecognition/processLocally) |
| transformers.js v4 | WebGPU 재작성 (2026-02). WebGPU는 WASM 대비 5~10배 빠름 | huggingface/transformers.js |
| Whisper 모델 크기 | large-v3-turbo **q4f16 = 인코더 370MB + 디코더 193MB ≈ 563MB** (WebGPU 필요). base 하이브리드(fp32 인코더+q4 디코더) ≈ 206MB. 한국어 실용 품질은 large-v3-turbo가 뚜렷하게 우위 (large-v3 한국어 WER 8~13%) | onnx-community (HF) |
| WebGPU 처리 속도 | base ≈ 실시간 5~8배 (1시간 오디오 ≈ 7.5~12분), small ≈ 2~4배. WASM 폴백은 small부터 실시간보다 느림 | 실측 보고 종합 |
| Groq 무료 티어 | whisper-large-v3-turbo 전사 무료: 20 RPM, 일 2,000요청, **일 오디오 8시간**(시간당 2시간). 파일당 25MB → 분할 필요. CORS `*` 실측 확인 → 브라우저 직접 호출 가능 | console.groq.com |
| Gemini 무료 티어 | Flash 계열, 약 10 RPM / 일 1,500요청, **1M 컨텍스트** → 긴 회의록 통짜 요약 가능. 네이티브 REST(`generativelanguage.googleapis.com`)는 CORS 허용 실측 확인. 단 OpenAI 호환 엔드포인트 + OpenAI SDK는 `x-stainless-*` 헤더가 프리플라이트에서 차단됨 → **raw fetch + 네이티브 엔드포인트만 사용** | ai.google.dev |
| BYOK 프록시 불필요 | Groq·Gemini·OpenRouter·Cerebras·Mistral 모두 CORS 허용 실측 → 정적 사이트에서 프록시 서버 없이 직접 호출 | OPTIONS 프리플라이트 실측 |
| MediaRecorder 장시간 | timeslice 없이 쓰면 메모리 누적·크래시. 일부 코덱은 onerror 없이 조용히 죽음 → 워치독 필요. 슬립/복귀 구간 무결성 불가 | Chromium 이슈 트래커 |
| IndexedDB | 데스크톱 오리진당 디스크 ~60%까지 — 용량은 충분. 리스크는 **임의 축출**: `navigator.storage.persist()` 요청 필수, Safari는 7일 미상호작용 시 삭제(ITP) | web.dev, WebKit 문서 |
| 녹음 코덱 | Chrome/Firefox = webm/opus, Safari = mp4/aac. `isTypeSupported` 폴백 체인 필수 | MDN |
| 탭 오디오 캡처 | `getDisplayMedia` 오디오는 Chromium 데스크톱 전용. Firefox/Safari/모바일은 조용히 무시 | MDN |
| 대용량 디코딩 | `decodeAudioData` 통디코딩은 1시간 오디오에 RAM ~1.4GB → 구간 반복 디코딩(OfflineAudioContext) 필수 | Web Audio 스펙 |

## 3. 아키텍처

```
┌─ Cloudflare Pages (순수 정적, 무료·무제한) ─────────────┐
│  React + TypeScript + Vite PWA                          │
│                                                          │
│  ┌── 전사 엔진 (3계층) ──────────────────────────┐       │
│  │ ① Web Speech API (실시간, Chrome, 0MB)        │       │
│  │ ② transformers.js Whisper (Web Worker/WebGPU) │◄──── HuggingFace CDN
│  │ ③ Groq Whisper API (BYOK, 브라우저 직접 호출) │       │  (모델 런타임 로드)
│  └────────────────────────────────────────────────┘       │
│  ┌── 요약 엔진 ──────────────────────────────────┐       │
│  │ Gemini Flash 네이티브 REST (BYOK, raw fetch)  │       │
│  └────────────────────────────────────────────────┘       │
│  ┌── 저장 ───────────────────────────────────────┐       │
│  │ IndexedDB(Dexie): 회의·오디오청크·전사·요약   │       │
│  │ localStorage: API 키·설정                      │       │
│  └────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────┘
```

- 서버·DB·계정·Pages Functions 없음. 배포는 GitHub(`gum798/MinuteFlow`) → Cloudflare Pages 자동 빌드.
- Whisper 모델 파일은 Pages의 25MiB 파일 제한 때문에 HuggingFace CDN에서 런타임 로드하고 브라우저(Cache API)에 캐시.
- BYOK 호출은 브라우저 → 제공자 직접(CORS 검증 완료). 키는 localStorage에만 있고 어디로도 전송되지 않음 — UI에 명시.

### 모듈 경계

| 모듈 | 책임 | 인터페이스 |
|---|---|---|
| `core/recorder` | 마이크/탭오디오 캡처, timeslice 청크 생성, 워치독, Wake Lock | `start(sources) / onChunk / stop()` |
| `core/stt` | 3계층 전사 엔진 공통 인터페이스 | `transcribe(audio) → segments[]`, `stream() → 실시간 이벤트` |
| `core/summarize` | 프롬프트 빌드 + Gemini 호출 + 폴백 | `summarize(transcript, template) → markdown` |
| `core/store` | Dexie 스키마, 복구, persist/용량 관리 | CRUD + `recoverSessions()` |
| `core/audio` | 업로드 파일 청크 디코딩·리샘플링(16kHz mono), Groq용 분할 | `decodeChunked(file) → Float32 스트림` |
| `core/export` | md/txt/docx/json 생성 | `export(meeting, format) → Blob` |
| `ui/*` | 화면 (아래 §8) | — |

각 `core/*` 모듈은 UI 없이 단독 테스트 가능해야 한다.

## 4. 전사 엔진 (3계층)

**공통 원칙: 실시간 전사 중에도 항상 MediaRecorder로 원본을 병행 녹음한다.** 어떤 엔진이 실패해도 원본이 남아 ②/③으로 재전사할 수 있다 — 이것이 전체 설계의 안전망이다.

### ① Web Speech API — 즉시 시작 (기본 실시간)

- `webkitSpeechRecognition` + `SpeechRecognition` 폴백, `lang=ko-KR`(설정에서 변경), `continuous=true`, `interimResults=true`
- **재시작 루프**: `onend`에서 즉시 `start()` 재호출 (무음 7~10초/60초 타임아웃 대응). 재시작 경계의 발화 누락·중복은 `isFinal` 세그먼트만 확정 저장하는 버퍼링으로 완화
- Page Visibility로 탭 비활성 감지 → "탭을 앞에 유지하세요" 경고
- Chrome 139+에서는 설정에 **온디바이스 모드** 토글: `available()` 조회 → 필요 시 `install()`로 언어 모델 다운로드 → `processLocally=true`. 프라이버시 배지 표시("음성이 기기 밖으로 나가지 않음")
- 기본(클라우드) 모드에서는 "음성이 Google 서버로 전송됩니다" 고지 배너
- 미지원 브라우저(Edge 포함): 실시간 자막 없이 녹음만 진행하고 종료 후 ②/③ 전사 안내

### ② transformers.js Whisper — 로컬 고품질 (파일·재전사)

- Web Worker에서 실행 (메인 스레드 블로킹 방지), 진행률 이벤트로 UI 갱신
- 모델 선택 (설정 화면에서 다운로드 관리):
  - **WebGPU 지원 시 기본: `whisper-large-v3-turbo` q4f16 (~563MB)** — 한국어 실용 품질
  - 경량 옵션: `whisper-base` 하이브리드 (~206MB) — 빠른 초안용
  - WebGPU 미지원(WASM 폴백): base 이하만 허용하고 "느림 — Groq 키 사용 권장" 안내
- 30초 창 단위 순차 처리, 타임스탬프 포함 세그먼트 산출. 처리 중 탭 이탈 대비 진행 상태를 IndexedDB에 체크포인트
- 모델 파일은 HF CDN에서 받고 Cache API에 캐시 → 이후 오프라인 전사 가능

### ③ Groq Whisper API — BYOK 고속 (파일)

- `whisper-large-v3-turbo`, 브라우저에서 직접 `audio/transcriptions` 호출
- 25MB 제한 대응: 녹음 청크 경계 기준 약 20분 단위로 분할해 순차 전송, 세그먼트 타임스탬프를 오프셋 보정 후 병합
- 무료 한도(일 8시간 오디오) 초과(429) 시: 지수 백오프 재시도 → 계속 실패하면 ②로 전환 제안

## 5. 요약·회의록 생성 (BYOK, 선택)

- **Gemini Flash 네이티브 REST를 raw fetch로 호출** (`x-goog-api-key` 헤더). OpenAI SDK·호환 엔드포인트는 브라우저에서 프리플라이트가 막히므로 사용 금지
- 1M 컨텍스트 → 전사문 전체를 청킹 없이 한 번에 요약
- 템플릿 3종: **회의록**(안건·논의 요지·결정사항·액션아이템), **짧은 요약**, **타임라인**. 프롬프트 빌더는 순수 함수로 분리(테스트 대상)
- 폴백: 사용자가 OpenRouter 키를 추가 등록하면 무료 모델로 대체 호출 가능 (v1은 Gemini만, 인터페이스는 provider 추상화)
- **키가 없을 때**: 요약 버튼 대신 "AI 프롬프트 복사" 버튼 — 템플릿+전사문을 클립보드에 복사해 ChatGPT 등에 수동 붙여넣기
- 키 등록 UI: 발급 절차 링크(Google AI Studio), "키는 이 브라우저에만 저장되며 서버가 없어 어디로도 전송되지 않습니다" 명시

## 6. 녹음 파이프라인

- `getUserMedia`(마이크) → `MediaRecorder.start(timeslice=10_000)` — 10초 청크를 **즉시 IndexedDB append**. 메모리에 누적하지 않음
- 코덱: `isTypeSupported` 폴백 체인 `audio/webm;codecs=opus` → `audio/mp4`(Safari)
- **워치독**: 마지막 청크 수신 시각을 감시, 25초(청크 2.5개분) 초과 시 조용한 크래시로 판단 → MediaRecorder 재생성·재개 + 사용자 경고. 세그먼트 경계에 갭 타임스탬프 기록
- **Wake Lock**: 녹음 시작 시 획득, `visibilitychange`에서 재획득. 모바일 첫 녹음 시 "화면을 켠 채 유지하세요" 안내
- **크래시 복구**: 녹음 세션에 `status=recording` 플래그. 앱 시작 시 미종료 세션 발견 → "복구할 녹음이 있습니다" 배너 → 저장된 청크까지 복원
- **화상회의 캡처 옵션** (Chromium 데스크톱 전용): `getDisplayMedia({audio:true})` 탭 오디오 + 마이크를 Web Audio(`AudioContext` 믹서)로 합성해 단일 트랙 녹음. 공유 다이얼로그에서 "오디오 공유" 체크 안내. 미지원 환경은 옵션 자체를 숨김

## 7. 파일 업로드 처리 (2026-07-07 개정 — 리서치 반영)

- 지원 입력: m4a/mp3/wav/webm/ogg (브라우저 디코딩 가능 포맷)
- **16kHz 컨텍스트 통디코딩** (whisper-web 레퍼런스 패턴): `new AudioContext({sampleRate:16000})` + `decodeAudioData(전체 ArrayBuffer)` — 디코딩 결과가 컨텍스트 레이트로 자동 리샘플되어 1시간 오디오도 상주 메모리 ~230MB (기본 레이트로 디코딩 후 리샘플하면 피크 1GB+). ~~구간 반복 디코딩~~은 **불가로 판명** — `decodeAudioData`는 완전한 파일만 받는다(MDN 명시). 방어 코드: 디코딩 후 `sampleRate !== 16000`이면 `OfflineAudioContext`로 재리샘플
- 스테레오→모노: `(L+R)×√2/2` (파워 보존, whisper-web/FFmpeg 호환)
- MediaRecorder 녹음물: 청크 전체를 순서대로 결합한 하나의 Blob으로만 디코딩 (개별 청크는 헤더가 없어 단독 디코딩 실패)
- 디코딩 불가 파일(드문 코덱)은 명확한 에러 + "Groq 경로는 원본 그대로 전송 가능" 안내 (Groq는 서버에서 디코딩)
- Groq 경로: 25MB 이하 원본은 그대로 업로드. 초과 시 **16kHz mono로 통디코딩 → 16-bit WAV 세그먼트(약 13분 = 25MB 미만)로 인코딩 → 순차 업로드 → 타임스탬프 오프셋 보정 병합** (WAV 인코딩은 순수 JS로 단순·무손실)
- 모바일 등 저메모리 기기에서 대용량 파일은 "Groq 경로(원본 직송) 권장" 안내

## 8. 데이터 모델 & UI

### IndexedDB (Dexie)

```
meetings:            id, title, createdAt, durationSec, status(recording|done), language
audioChunks:         id, meetingId, seq, blob, mimeType, startedAt
transcriptSegments:  id, meetingId, startSec, endSec, text, source(webspeech|whisper|groq), isFinal
summaries:           id, meetingId, template, markdown, provider, createdAt
```

설정·API 키는 localStorage. 앱 시작 시 `navigator.storage.persist()` 요청, `estimate()`로 사용량/여유를 홈에 표시. Safari에서는 "7일 미사용 시 브라우저가 데이터를 지울 수 있음 — 중요한 회의록은 내보내세요" 경고.

### 화면 구성

1. **홈**: 회의 목록(제목·날짜·길이·상태), 저장 용량 게이지, [녹음 시작] [파일 업로드]
2. **녹음**: 실시간 자막 스트림(interim 회색/final 검정), 경과 시간, 오디오 레벨 미터, 소스 선택(마이크/+탭 오디오), 일시정지/종료
3. **업로드**: 드래그앤드롭, 엔진 선택(로컬 Whisper/Groq), 진행률 바
4. **회의록 뷰**: 전사문(타임스탬프별 세그먼트, 인라인 편집 가능) + [요약 생성](템플릿 선택) + 요약 결과 + 내보내기(md/txt/docx/json/오디오)
5. **설정**: API 키(Gemini/Groq), Whisper 모델 다운로드 관리(크기·삭제), 언어, 온디바이스 인식 토글

PWA: manifest + service worker(앱 셸 프리캐시). 모델 캐시 후에는 오프라인에서도 ② 전사 동작.

## 9. 에러 처리

- **기능 감지 매트릭스** (앱 시작 시 1회): Web Speech 동작 여부(객체 존재만으론 불충분 — Edge no-op 대응으로 실제 이벤트 발생까지 확인), WebGPU, `getDisplayMedia` audio, storage persist → 기능별 배너로 "이 브라우저에서는 X가 제한됩니다 + 대안"
- 실시간 전사 중단 → 재시작 루프가 흡수, 연속 실패 시 "녹음은 계속되고 있음, 종료 후 파일 전사 가능" 안내
- BYOK 401 → "키 확인" 안내, 429 → 백오프 재시도 후 다른 엔진 제안
- HF CDN 다운로드 실패 → 재시도 + Groq 경로 안내
- 원칙: **원본 오디오가 항상 보존되므로 모든 실패는 재시도 가능** — 파괴적 에러가 구조적으로 없음

## 10. 테스트

- **vitest 유닛**: 세그먼트 병합·타임스탬프 오프셋 보정, Groq 분할 크기 계산, 재시작 루프 상태머신, 프롬프트 빌더, 워치독 타이머, 복구 로직(fake-indexeddb)
- **Playwright e2e**: fake media stream(`--use-fake-device-for-media-stream`)으로 녹음→청크 저장→강제 리로드→복구 플로우, whisper-tiny 실전사 스모크(CI에서 고정 fixture 오디오 → 기대 키워드 포함 검증)
- API 호출부는 provider 인터페이스 뒤로 격리해 mock 테스트

## 11. 배포

- `gum798/MinuteFlow`(public) → Cloudflare Pages GitHub 연동, main 푸시 자동 배포, `*.pages.dev` 도메인
- 빌드: `vite build` (월 500회 한도 대비 여유 큼)
- 순수 정적 확인 체크: Functions 디렉터리 없음, 개별 파일 25MiB 미만

## 12. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 실시간 전사의 Chrome 의존 | 원본 병행 녹음 → 어떤 브라우저든 사후 전사 가능. 기능 감지 배너로 기대치 관리 |
| 무료 티어 정책 변경 | 앱 내 한도 표기는 대략치 + 공식 문서 링크. provider 추상화로 대체 용이 |
| HF CDN 장애/차단 | Cache API 캐시로 재방문자 무영향. Groq 경로 대안 안내 |
| 브라우저 저장소 축출 | persist() 요청 + 내보내기 유도 UX |
| WebGPU 미지원 기기에서 로컬 전사 체감 저하 | base 모델 제한 + BYOK 안내로 기대치 관리 |

## 13. 화자 분리 (2026-07-07 범위 편입 — Plan 3, 구현 경로 확정)

리서치 결론(2026-07-07 1차): Gemini BYOK 경로 탈락 — 라벨 일관성·Files API CORS 문제. 2차 구현 정찰 결과 **sherpa-onnx WASM도 탈락** — 모델 데이터(.data) ~43.5MiB로 Pages 25MiB 파일 한도 초과(최소 임베딩 CAM++ 단독도 27.9MiB), 공식 HF Space 접근 불가(401), 브라우저용 npm 패키지 부재, pthread 빌드라 COOP/COEP 헤더 필요.

**확정 경로: transformers.js 조립** (모두 transformers.js 네이티브 지원, HF CDN 런타임 로드 → Pages 한도 무관):

- **세그멘테이션**: `onnx-community/pyannote-segmentation-3.0` (MIT, q8 ~1.5MB) — `AutoModelForAudioFrameClassification` + `post_process_speaker_diarization`. **10초 윈도우 전용 모델이므로 슬라이딩 윈도우를 직접 구현** (자동 청킹 없음 — HF 디스커션 확인)
- **임베딩**: `onnx-community/wespeaker-voxceleb-resnet34-LM` (cc-by-4.0, fp16 ~13.3MB, 256-dim) — transformers.js 네이티브 `WeSpeakerResNetModel` + `WeSpeakerFeatureExtractor`(raw 16k → fbank 자동). 출력 키는 런타임 방어(`embeddings ?? embs ?? 첫 출력`)
- **클러스터링**: 순수 JS agglomerative (average-linkage cosine, 유사도 임계 ~0.75, 화자 수 자동; ml-hclust 불필요 — 직접 구현 ~60줄)
- **전사 병합**: WhisperX `assign_word_speakers` 로직 이식 — 전사 세그먼트별로 화자 구간 교집합을 **화자별 합산** 후 최대 화자 배정, 무교집합 시 최근접(midpoint 거리)
- **파이프라인**: 10초 윈도우 세그멘테이션(로컬 id) → 0.4초 이상 구간별 임베딩 → 전역 클러스터링 → 화자 타임라인 → 전사 세그먼트에 배정. Web Worker에서 실행 (whisper.worker 패턴)
- **데이터**: `TranscriptSegment.speaker?: string`(비인덱스 — Dexie 마이그레이션 불필요), `Meeting.speakerNames?: Record<string,string>`(라벨→실명)
- **UI**: 회의록 뷰 [화자 구분] 버튼(오디오 있을 때) → 화자 8색 팔레트 배지 + 이름 편집. 화자 수 자동(수동 지정은 후순위)
- **제약 고지**: 겹치는 발화는 단일 라벨(손실적). 임베딩이 영어(VoxCeleb) 학습 — 한국어 화자 정확도 실측 필요. 내보내기에 화자 반영

## 14. UI 디자인 언어 (2026-07-07 확정)

`minutelog` 프로젝트의 디자인 언어를 이식한다. 토큰 전체는 **`docs/design/design-tokens.md`** 참조 (이 문서가 단일 출처).

- Pretendard Variable 폰트(jsDelivr CDN), 브랜드 블루 `#1E43B8`, 앱 배경 `#F4F5F9`, 카드 기반 레이아웃(radius 12, border `#E4E7EE`)
- 구조: 사이드바(228px, ≤880px에서는 상단 바) + 중앙 콘텐츠(max-width 1080~1160)
- minutelog는 인라인 스타일 하드코딩이지만 MinuteFlow는 **CSS 커스텀 프로퍼티**(`src/ui/theme.css`)로 토큰화. 다크모드는 후순위(변수화로 확장 여지만 확보)
- 상태 배지·진행률 바·드롭존·파이프라인 스테퍼·토스트는 design-tokens.md의 스타일 명세대로

## 15. 구현 로드맵 (개정)

| 플랜 | 범위 | 상태 |
|---|---|---|
| Plan 1 | 녹음 + Web Speech 실시간 + 저장/복구 + md/txt 내보내기 | ✅ 완료·배포 |
| Plan 2 | **UI 리스타일(테마+사이드바)** + 파일 업로드 + 브라우저 Whisper + Groq BYOK + 설정 화면 | 작성 중 |
| Plan 3 | **화자 분리** (transformers.js 조립: pyannote+WeSpeaker+클러스터링) | 구현 완료 |
| Plan 4 | Gemini BYOK 요약 + DOCX + PWA + 기능감지 배너 + Playwright e2e | 대기 |

## 16. v2 후보 (이번 범위 아님)

- OpenRouter 등 요약 provider 추가
- 다국어 UI
- 회의록 공유 링크 (서버리스 제약 내 방법 검토 필요)
- 다크모드
