# 긴 녹음 통합 처리 (Long-Recording Unified Processing) — 설계

**작성일:** 2026-07-10
**상태:** 승인됨 (사용자 검토 대기)

## 배경 / 문제

브라우저는 녹음 전체를 한 번에 `decodeAudioData`로 디코딩한다. 16시간 녹음이면 16kHz 모노 PCM ≈ 3.7GB로 메모리 한계를 넘어 디코딩이 무한 대기/OOM에 빠지고, "자동 정리"가 재전사 단계에서 아무 피드백 없이 멈춘다. (이미 임시로 `MAX_PROCESS_SEC=2시간` 가드를 넣어 2시간 초과는 재전사·화자 구분을 건너뛰고 요약만 하도록 해 둠 — 이 스펙은 그 상한을 없애는 것이 목표.)

## 목표

- **길이와 무관하게** 재전사·화자 구분·요약이 동작한다.
- 사용자는 **하나의 연속된 회의**를 본다 — "부 1/부 2" 탭·분리 항목 없음.
- 화자 번호는 녹음 전체에서 **같은 사람 = 같은 번호** (부 경계를 넘어 일관).
- Chrome·Safari 모두 동작 (특정 컨테이너 포맷 demux에 의존하지 않음).

## 비목표 (YAGNI)

- **기존 16시간 단일 회의(파트 없음)의 소급 수정**: 파트가 없어 단일 연속 블롭이므로 그대로 **요약만**. (사용자가 "녹음 시점에 쪼개기" 방식을 선택 → 앞으로의 녹음에만 적용.)
- 디코딩-시점 컨테이너 windowing(WebM/MP4 demux). Safari 신뢰성 문제로 제외.
- 실시간(녹음 중) 통합 화자 클러스터링. 통합 화자 구분은 종료 후/수동 실행 시에만.

## 핵심 아이디어

**녹음 시점에 쪼갠다.** 녹음은 이미 주기적으로 새 `MediaRecorder`로 로테이션해 **각 부(part)를 독립적으로 디코딩 가능한 블롭**으로 만든다(현행 분할 녹음). 이 구조를 그대로 재사용하되:

- 내부 구간을 **기본 30분**으로 (메모리·모바일 안전: 30분 ≈ 230MB 디코딩).
- **처리·표시를 그룹 단위로 통합**해 사용자에겐 부가 보이지 않게 한다.
- 처리 시 **한 번에 한 부만 디코딩**하고 버리므로 총 길이는 무관.

즉 "쪼개기"는 디코딩 가능성을 위해 **내부적으로 유지**되고, 사라지는 것은 **화면의 파트 구분**뿐이다.

## 아키텍처 — 기존 "그룹(부들의 묶음)" 모델 재사용

이미 존재하는 것: `getMeetingGroup`(그룹의 전 부), Home 그룹 카드(그룹당 1개), `summarizeGroup`(통합 요약), 그룹 soft-delete/복구, 그리고 화자 워커의 **windowed 구간분석 + 임베딩 추출 + 전역 클러스터링**(순수 모듈 `cluster.ts`/`assign.ts`로 분리돼 있음).

### 구성요소

1. **화자 워커 `extract` 모드 (`diarize.worker.ts`)**
   - 현재: 한 오디오에서 `구간분석 → 임베딩 → clusterEmbeddings → labelClusters → assign`을 워커 안에서 통째로 수행.
   - 변경: 워커는 한 버퍼의 `{ regions, embeddings }`만 반환(**클러스터링 제거**). 클러스터링/라벨링/assign은 메인 스레드로 이동(순수 모듈 재사용). 임베딩은 `Float32Array[]`로 postMessage(구조적 복제; 256-d × 구간 수, 작음).
   - 단일 회의 diarize는 이 위에 재구현: `extract` 1회 → `clusterEmbeddings` → `labelClusters` → `assign`.

2. **`diarizeGroup(partIds)` (신규, `meetingActions.ts` 또는 `diarize/` 하위)**
   - `DiarizeEngine` **1개**만 로드해 전 부에 재사용(부마다 모델 재로딩 방지).
   - 각 부: 오디오 로드 → 디코딩(한 번에 하나, 끝나면 해제) → `extract` → 그 부의 `{regions, embeddings}` 수집. 부별 임베딩의 소속(부 index, region)을 기록.
   - **전 부의 임베딩을 모아 한 번에 `clusterEmbeddings`** → `labelClusters` → 전역 라벨.
   - 각 부의 region+전역 라벨로 `assign`을 부-상대 시각 기준으로 수행 → 각 부 세그먼트에 `speaker` 기록(부 경계를 넘어 **일관된 SPK 라벨**).

3. **`retranscribeGroup(partIds)` (신규)**
   - `WhisperLocalEngine` **1개**만 로드해 전 부 순차 재전사(부마다 모델 재로딩 방지).
   - 각 부: 디코딩(한 번에 하나) → 전사 → 후처리(collapse/의미필터/환각제거/보정) → 그 부 세그먼트 교체. 세그먼트는 **부-상대 시각으로 각 부에 저장**(현행 유지 — 통합은 뷰 레이어에서).
   - 한 부 디코딩/전사 실패 시 그 부만 건너뛰고 다음 부로(부분 결과 보존).

4. **자동 정리(파이프라인) 그룹화 (`pipeline.ts`)**
   - "자동 정리"가 그룹이면 `retranscribeGroup → diarizeGroup → summarizeGroup` 순. 각 단계 실패해도 다음 단계로(이미 견고화된 흐름 재사용).
   - 진행 상태(runJob)는 **마지막 부 id**에 싣는다(기존 `summarizeGroup`·`pipeline-done`과 일관). 진행 문구는 부 진척 포함: 예 "재전사 중 (3/8)".

5. **통합 전사 뷰 (`Meeting.tsx`)**
   - 그룹의 **모든 부 세그먼트를 이어 하나의 스크롤**로 렌더. 부 k의 세그먼트는 `startSec + cumulativeOffset[k]`로 표시(`cumulativeOffset[k] = Σ parts[0..k-1].durationSec`).
   - **부 탭 제거.** 배지는 전역 화자 라벨 색.
   - 화면의 job은 그룹 어느 부의 job이든 잡아 진행 표시: `job = jobs.find(j => group.some(p => p.id === j.meetingId))`.
   - 파트 경계선은 **표시하지 않음**(연속 회의로 보이게). (추후 옵션.)
   - **화자 이름·병합은 그룹 전체 일관**: 전역 라벨(SPK1…)이 전 부에 공통이므로, 통합 뷰에서 이름 변경/기존 이름 선택 병합은 **그룹의 모든 부에 반영**한다(각 부의 `speakerNames` 동일하게 갱신, 병합은 각 부의 세그먼트 라벨을 재지정). 기존 단일 회의 동작은 그룹 크기 1의 특수 케이스로 그대로 성립.

6. **내부 구간 기본값 (`settings.ts`, `recorder/session.ts`)**
   - `splitMinutes` 기본 **60 → 30**. 설정은 유지하되 "처리 구간(내부)"으로 의미 재정의(사용자에겐 파트가 안 보이므로 고급/내부 값). `0`(끄기)이면 긴 녹음이 단일 블롭이 되어 요약만 가능 — 문서화된 다운사이드.

7. **디버그 로그 (`core/debug.ts`, 신규)**
   - `dlog(scope, ...args)` — `console.debug('[MF:'+scope+']', ...)` 프리픽스 + 경과시간. 기본 **켜짐**(사용자 요청). `localStorage['mf-debug']='0'`으로 끄기 가능.
   - 로그 지점(긴 녹음 추적용):
     - 녹음: 로테이션(부 생성), `part-complete` 발화.
     - 디코딩: 시작/완료 + 샘플 수 + 초 + 대략 MB.
     - 재전사: 부 시작/완료 + 세그먼트 수.
     - 화자: 부별 region/embedding 수, **전역 클러스터 = 화자 수**, assign 결과.
     - 요약: outcome, 파이프라인 done(outcome/메시지).
     - 각 주요 단계 소요시간(ms).

## 데이터 흐름 (자동 정리, 그룹)

```
자동 정리(그룹)
 └ retranscribeGroup(parts)         [Whisper 엔진 1회 로드]
     for part in parts:  decode(part) → transcribe → 후처리 → replaceSegments(part)   (한 번에 한 부 디코딩)
 └ diarizeGroup(parts)              [Diarize 엔진 1회 로드]
     for part in parts: decode(part) → worker.extract → {regions, embeddings} 수집
     clusterEmbeddings(모든 embeddings) → labelClusters → 전역 라벨
     for part in parts: assign(part.regions, 전역라벨) → 각 부 세그먼트 speaker 기록
 └ summarizeGroup(parts)            [기존]
 → pipeline-done (마지막 부 id, outcome, 메시지)

통합 뷰: getMeetingGroup → 모든 부 세그먼트 concat(offset 적용) → 연속 전사 + 그룹 요약(마지막 부)
```

## 에러 처리 / 엣지

- **한 부 디코딩/전사/추출 실패**: 그 부만 건너뛰고 진행. 화자 임베딩이 하나도 없으면 화자 구분은 결과 없음('empty')로 두고 재전사·요약은 진행.
- **파트 없는 단일 회의(기존 16h 등)**: `getMeetingGroup`이 자기 1개만 반환 → `diarizeGroup`/`retranscribeGroup`은 1개 부로 동작하지만, 그 1개가 상한 초과면 재전사·화자 구분은 `too-long`으로 건너뛰고 요약만(기존 가드 유지). 즉 소급 수정 없음(설계 목표대로).
- **soft-delete/복구/내보내기**: 그룹 단위 기존 동작 유지. 통합 뷰는 삭제되지 않은 부만 이어붙임.
- **진행 중 재진입**: 그룹 job 존재 시 자동 정리 버튼 비활성(기존 autoBusy + job 가드 확장).

## 테스트 전략

- **`diarizeGroup` 전역 클러스터링**: 2개 부, 각 부에서 같은 화자의 임베딩이 부 경계를 넘어 **동일 SPK 라벨**로 묶이는지(워커 `extract`는 목으로 임베딩 주입, `clusterEmbeddings`/`assign`는 실제).
- **엔진 1회 로드**: `retranscribeGroup`/`diarizeGroup`이 부 수와 무관하게 엔진 생성 1회.
- **한 부 실패 시 나머지 진행**: 중간 부 디코딩이 throw해도 다른 부는 처리되고 요약 진행.
- **통합 뷰 offset**: 부 durations로 누적 offset이 세그먼트 표시 시각에 정확히 반영.
- **워커 `extract` 계약**: `{regions, embeddings}` 형태·길이 일치.
- **디버그 로그**: `mf-debug` 플래그로 on/off, 프리픽스 형식(순수 함수로 포맷 검증).
- 기존 회귀(단일 회의 diarize/retranscribe, pipeline-done, too-long 가드)는 그대로 통과.

## 구현 범위 (플랜에서 태스크화, 6–8개 예상)

1. `core/debug.ts` — `dlog` + 플래그 + 포맷 (+테스트).
2. 화자 워커 `extract` 모드 + 단일 diarize를 메인스레드 cluster+assign로 재구현 (+테스트).
3. `diarizeGroup` — 부별 extract 수집 → 전역 클러스터 → 부별 assign, 엔진 1회 (+테스트).
4. `retranscribeGroup` — 엔진 1회, 부별 순차, 한 부 실패 격리 (+테스트).
5. `pipeline.ts` 자동 정리 그룹화 + 진행 문구 + 로그 (+테스트).
6. `Meeting.tsx` 통합 전사 뷰(offset) + 부 탭 제거 + 그룹 job 표시.
7. `settings.ts`/recorder 기본 30분 + 설정 카피 재정의.
8. 통합 회귀 확인 + 디버그 로그 지점 부착.
