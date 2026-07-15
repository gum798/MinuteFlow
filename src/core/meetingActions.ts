// 재전사·화자 구분·요약의 UI 무관 로직. Meeting 화면과 자동 파이프라인이 공유한다.
// 각 함수는 내부에서 runJob(meetingId, kind, ...)으로 전역 작업 스토어에 진행 상태를 싣고,
// 결과를 반환한다(성공/빈결과/오디오없음). 작업 중 던진 예외는 runJob이 job-done(error)로
// 표면화하므로 여기서 별도 알림을 하지 않는다 — 안내(alert)는 호출부(Meeting)가 반환값으로 판단.

import { getMeetingAudio, getMeeting, getSegments, replaceAudio, replaceSegments, applySpeakers, updateSpeakerNames, saveSummary, updateMeetingTitle, deleteSummaries } from './store/meetings'
import { runJob } from './jobs'
import { loadSettings } from './settings'
import { applyCorrections } from './corrections'
import { decodeTo16kMono } from './audio/decode'
import { repairHeaderlessWebm } from './audio/webmRepair'
import { detectWebGPU, WhisperLocalEngine } from './stt/whisperLocal'
import { DiarizeEngine } from './diarize/diarizeLocal'
import { globalSpeakerRegions } from './diarize/globalSpeakers'
import { dlog, dtimer } from './debug'
import { transcribeSamplesWithGroq } from './stt/groq'
import { GROQ_ENABLED } from './features'
import { buildSummaryPrompt, buildGroupSummaryPrompt, extractSuggestedTitle, isDefaultTitle, withDateSuffix, type SummaryTemplate } from './summarize/prompts'
import { summarizeWithGemini } from './summarize/gemini'
import type { Meeting, TranscriptSegment } from './types'

// 공백·대시·구두점만 있는 텍스트는 무의미로 간주한다(제거 후 의미 문자가 하나도 없음).
const MEANINGLESS_RE = /[\s\-–—_.,·…!?~*]+/g

/** 공백·구두점·대시를 제거하고 의미 있는 글자가 하나라도 남으면 true. */
export function isMeaningfulText(text: string): boolean {
  return text.replace(MEANINGLESS_RE, '').length > 0
}

/** 모든 세그먼트의 의미 문자 합이 minChars 이상이면 요약할 만한 전사로 본다. */
export function hasMeaningfulTranscript(segments: { text: string }[], minChars = 10): boolean {
  const chars = segments.reduce((n, s) => n + s.text.replace(MEANINGLESS_RE, '').length, 0)
  return chars >= minChars
}

// 재전사·화자 구분은 녹음 전체를 16kHz 모노 PCM으로 한 번에 디코딩한다(초당 64KB).
// 리샘플 사본·처리 버퍼까지 감안하면 이 정도가 브라우저가 한 번에 디코딩할 수 있는 안전 상한이다.
// 이 이상(예: 16시간 녹음 ≈ 3.7GB)은 메모리 한계로 디코딩이 무한 대기/OOM에 빠져 파이프라인이
// 통째로 멈춘다. 그래서 시도하지 않고 건너뛴다 — 요약은 오디오 없이 기존 자막으로 계속 가능하다.
export const MAX_PROCESS_SEC = 2 * 60 * 60 // 2시간

/** 이 길이를 넘으면 브라우저에서 오디오를 한 번에 디코딩할 수 없어 재전사·화자 구분을 건너뛴다. */
export function isTooLongToProcess(durationSec: number): boolean {
  return durationSec > MAX_PROCESS_SEC
}

// Whisper는 무음·잡음 구간에서 같은 문구를 규칙적으로 반복 출력하는 환각을 낸다("지금 지금 지금…").
// 정규화한 텍스트가 같은 세그먼트가 REPEAT_RUN회 이상 연달아 나오면:
//  - 짧은(≤6자) 조각은 실제 발화일 가능성이 낮아 그 연속을 통째로 제거하고,
//  - 긴 문장("3을 호출하면 이것만 줘요" 등)은 첫 발화는 실제일 수 있으니 첫 1개만 남긴다.
// 실제 대화의 자연스러운 반복(예: "네 네", 같은 문장 2~3회)까지 지우지 않도록 임계를 보수적으로(4회) 둔다.
const REPEAT_RUN = 4
const SHORT_LEN = 6
const norm = (t: string): string => t.replace(MEANINGLESS_RE, '')

export function dropHallucinatedRepeats<T extends { text: string }>(segments: T[]): T[] {
  const out: T[] = []
  let i = 0
  while (i < segments.length) {
    const key = norm(segments[i].text)
    // 같은 정규화 텍스트가 몇 개 연속인지 센다.
    let j = i + 1
    while (j < segments.length && norm(segments[j].text) === key) j++
    const runLen = j - i
    // 4회 이상 반복 → 환각: 짧은 조각은 전부, 긴 문장은 첫 1개만 남기고 버린다. 그 외에는 보존.
    if (key.length > 0 && runLen >= REPEAT_RUN) {
      if (key.length > SHORT_LEN) out.push(segments[i])
      i = j
      continue
    }
    for (let k = i; k < j; k++) out.push(segments[k])
    i = j
  }
  return out
}

// 한 세그먼트 text 안에서 같은 토큰·구절이 수십~수백 번 이어지는 환각
// ("15, 15, 15, …", "삼, 삼, 삼, …", "이것만 줘요 이것만 줘요 …").
// 문장 구두점이 없어 collapseRepeatedPhrases(문장 단위)로는 잡히지 않는다. 공백으로 토큰을 나눠,
// 정규화(공백·구두점 제거)한 토큰열에서 길이 1~MAX_CYCLE_LEN의 주기가 임계 이상 반복되면
// 앞 2주기+마지막 1주기만 남긴다(마지막 주기를 남겨 반복 끝의 구두점을 보존).
// 실제 반복은 단일 토큰이 4~5회("10, 10, 10, 10" 점수 낭독), 구절이 2~3회를 넘지 않으므로
// 임계를 그 위(토큰 6회, 구절 4회)에 둔다. 축약이 없으면 원문을 그대로 반환한다.
const TOKEN_REPEAT_RUN = 6
const CYCLE_REPEAT_RUN = 4
const MAX_CYCLE_LEN = 5

// keys[start..]에서 길이 cycleLen의 주기가 몇 번 연속 반복되는지 센다(첫 주기 포함).
function countCycleRepeats(keys: string[], start: number, cycleLen: number): number {
  let repeats = 1
  while (start + (repeats + 1) * cycleLen <= keys.length) {
    let same = true
    for (let m = 0; m < cycleLen; m++) {
      if (keys[start + repeats * cycleLen + m] !== keys[start + m]) { same = false; break }
    }
    if (!same) break
    repeats++
  }
  return repeats
}

export function collapseRepeatedTokenRuns(text: string): string {
  const tokens = text.split(/\s+/).filter(t => t.length > 0)
  if (tokens.length < TOKEN_REPEAT_RUN) return text
  const keys = tokens.map(norm)
  const out: string[] = []
  let changed = false
  let i = 0
  while (i < tokens.length) {
    let collapsed = false
    for (let cycleLen = 1; cycleLen <= MAX_CYCLE_LEN && i + cycleLen <= tokens.length; cycleLen++) {
      const minRepeats = cycleLen === 1 ? TOKEN_REPEAT_RUN : CYCLE_REPEAT_RUN
      const repeats = countCycleRepeats(keys, i, cycleLen)
      if (repeats < minRepeats) continue
      // 주기가 전부 구두점뿐이면(빈 키) 실제 텍스트가 아니므로 건드리지 않는다.
      if (!keys.slice(i, i + cycleLen).some(k => k.length > 0)) continue
      for (let m = 0; m < cycleLen; m++) out.push(tokens[i + m])
      for (let m = 0; m < cycleLen; m++) out.push(tokens[i + cycleLen + m])
      for (let m = 0; m < cycleLen; m++) out.push(tokens[i + (repeats - 1) * cycleLen + m])
      i += repeats * cycleLen
      changed = true
      collapsed = true
      break
    }
    if (!collapsed) { out.push(tokens[i]); i++ }
  }
  return changed ? out.join(' ') : text
}

// 한 세그먼트 text 안에서 같은 문장이 연달아 붙는 환각("다음 영상에서 만나요. 다음 영상에서 만나요. …").
// 위 dropHallucinatedRepeats가 세그먼트 사이(inter) 반복을 잡는다면, 이건 세그먼트 내부(intra) 반복을 잡는다.
// 문장은 마침표·물음표·느낌표로 나누고, 공백·구두점을 무시한 정규화가 같은 문장이 3회 이상 연속되면 첫 1회만 남긴다.
// 자연스러운 2회 반복("네. 네.")은 보존하도록 임계를 3회로 둔다.
const PHRASE_REPEAT_RUN = 3
// 문장 = 구두점 아닌 글자들 + 뒤따르는 구두점·공백. 마지막 구두점 없는 꼬리도 하나의 문장으로 잡는다.
const SENTENCE_RE = /[^.!?]*[.!?]+\s*|[^.!?]+$/g

export function collapseRepeatedPhrases(text: string): string {
  const parts = text.match(SENTENCE_RE)
  if (!parts || parts.length < PHRASE_REPEAT_RUN) return text
  const out: string[] = []
  let i = 0
  while (i < parts.length) {
    const key = norm(parts[i])
    let j = i + 1
    while (j < parts.length && norm(parts[j]) === key) j++
    const runLen = j - i
    // 같은 문장이 3회 이상 연속 → 첫 1회만 남긴다. 그 외에는 원문 그대로 보존.
    if (key.length > 0 && runLen >= PHRASE_REPEAT_RUN) {
      out.push(parts[i])
    } else {
      for (let k = i; k < j; k++) out.push(parts[k])
    }
    i = j
  }
  return out.join('')
}

// Whisper가 무음·잡음 구간에서 뱉는 대표적 환각 문구(유튜브 아웃트로 등). 정규화(공백·구두점 제거) 후
// 이 코어 문자열을 포함하는 문장은 통째로 제거한다. 회의 대화엔 실질적으로 등장하지 않는 문구만 보수적으로 선정.
// "감사합니다"/"네" 같은 실제 발화와 겹치는 짧은 말은 넣지 않는다(오제거 방지).
// 실제 회의 발화와 겹칠 위험이 있는 문구는 넣지 않는다(오제거가 환각 잔존보다 나쁨).
// 예: '알림설정까지'("알림 설정까지 지원")·'유료광고를포함'("유료 광고를 포함한 예산")·
//     '다음시간에만나'("다음 시간에 만나서") 등은 제외. '시청'·'다음 영상에서 만나' 계열만 사용.
const HALLUCINATION_CORES = [
  '다음영상에서만나',
  '시청해주셔서감사',
  '시청해주셔서정말감사',
  '오늘도시청해주셔서',
  '영상을시청해주셔서',
  '구독과좋아요',
  '많은시청부탁',
  '한글자막by',
]

/**
 * 한 세그먼트 text에서 알려진 Whisper 환각 문구가 든 문장을 제거한다.
 * 문장 단위로 나눠, 정규화한 문장이 HALLUCINATION_CORES 중 하나를 포함하면 그 문장을 버린다.
 * 남은 문장만 이어 반환한다(전부 환각이면 빈 문자열 → 이후 isMeaningfulText가 걸러냄).
 */
export function stripHallucinationPhrases(text: string): string {
  const parts = text.match(SENTENCE_RE)
  if (!parts) return text
  const kept = parts.filter(p => {
    const n = norm(p)
    return n.length === 0 || !HALLUCINATION_CORES.some(core => n.includes(core))
  })
  return kept.join('').trim()
}

/**
 * Whisper/Groq 전사 결과의 반복·환각 후처리 체인(재전사·업로드 공용):
 * 환각 문구 제거 → 토큰 반복 축약 → 세그먼트 내부 문장 반복 축약 → 무의미 조각 필터 → 세그먼트 간 반복 제거.
 */
export function cleanTranscriptSegments<T extends { text: string }>(segs: T[]): T[] {
  const collapsed = segs.map(s => {
    const text = collapseRepeatedPhrases(collapseRepeatedTokenRuns(stripHallucinationPhrases(s.text)))
    return text === s.text ? s : { ...s, text }
  })
  return dropHallucinatedRepeats(collapsed.filter(s => isMeaningfulText(s.text)))
}

// 오디오를 디코딩하되, 실패하면 헤더 잃은 WebM으로 보고 1회 자동 수선을 시도한다.
// 수선 성공 시 수선본을 스토어에 저장해 이후 다운로드/재생/전사도 정상화한다.
async function decodeMeetingAudioWithRepair(meetingId: string, blob: Blob): Promise<Float32Array> {
  try {
    return await decodeTo16kMono(await blob.arrayBuffer())
  } catch (e) {
    const repaired = await repairHeaderlessWebm(blob)
    if (!repaired) throw e
    const samples = await decodeTo16kMono(await repaired.arrayBuffer())
    await replaceAudio(meetingId, repaired) // 수선본을 저장 — 조용히 성공
    return samples
  }
}

/**
 * 한 부를 주어진 Whisper 엔진으로 재전사해 세그먼트를 교체한다(엔진 소유는 호출부).
 * 오디오 없으면 'no-audio', 결과가 무의미하면 'empty'(기존 유지), 그 외 'done'.
 */
async function transcribeOnePart(
  engine: WhisperLocalEngine, meetingId: string, settings: ReturnType<typeof loadSettings>,
  webgpu: boolean, setStatus: (s: string) => void,
): Promise<'done' | 'empty' | 'no-audio'> {
  const blob = await getMeetingAudio(meetingId)
  if (!blob) return 'no-audio'
  const endDecode = dtimer('retranscribe', '디코딩')
  const samples = await decodeMeetingAudioWithRepair(meetingId, blob)
  endDecode()
  dlog('retranscribe', `디코딩 완료`, { sec: (samples.length / 16000).toFixed(1), mb: (samples.length * 4 / 1048576).toFixed(1) })
  let segs
  let source: 'whisper' | 'groq'
  if (GROQ_ENABLED && settings.groqApiKey) {
    source = 'groq'
    setStatus('Groq로 전사 중…')
    segs = await transcribeSamplesWithGroq(samples, {
      apiKey: settings.groqApiKey, language: settings.language,
      onPart: (d, t) => setStatus(`Groq 분할 전사 중 (${d}/${t})`),
    })
  } else {
    source = 'whisper'
    setStatus('브라우저 Whisper로 전사 중… (모델 다운로드가 필요할 수 있어요)')
    segs = await engine.transcribe(samples, {
      model: webgpu ? settings.whisperModel : 'onnx-community/whisper-base',
      device: webgpu ? 'webgpu' : 'wasm',
      language: settings.language,
    }, p => { if (p.kind === 'status') setStatus(p.message) })
  }
  const meaningful = cleanTranscriptSegments(segs)
  dlog('retranscribe', `세그먼트 ${meaningful.length}개(원본 ${segs.length})`)
  if (meaningful.length === 0) return 'empty'
  await replaceSegments(meetingId, meaningful.map(s => ({
    ...s, text: applyCorrections(s.text, settings.corrections), source, isFinal: true,
  })))
  await updateSpeakerNames(meetingId, {})
  // 재전사로 전사 내용이 바뀌었으므로 옛 전사로 만든 요약은 무효 — 삭제한다(자동 정리면 이후 재요약됨).
  await deleteSummaries(meetingId)
  return 'done'
}

/**
 * 고품질 재전사. 성공 시 세그먼트를 교체하고 화자 이름 맵을 초기화한다.
 * 오디오가 없으면 'no-audio', 전사 결과가 비거나 의미 없는 조각(무음 → '-' 등)뿐이면 'empty'(기존 유지), 그 외 'done'.
 */
export async function retranscribeMeeting(meetingId: string): Promise<'done' | 'empty' | 'no-audio' | 'too-long'> {
  const meeting = await getMeeting(meetingId)
  if (meeting && isTooLongToProcess(meeting.durationSec)) return 'too-long'
  const settings = loadSettings()
  let result: 'done' | 'empty' | 'no-audio' = 'no-audio'
  await runJob(meetingId, 'retranscribe', async setStatus => {
    setStatus('오디오 준비 중…')
    const webgpu = (GROQ_ENABLED && settings.groqApiKey) ? false : await detectWebGPU()
    const eng = new WhisperLocalEngine()
    try {
      result = await transcribeOnePart(eng, meetingId, settings, webgpu, setStatus)
    } finally { eng.dispose() }
  })
  return result
}

/**
 * 그룹(여러 부) 통합 재전사. Whisper 엔진 1개로 각 부를 순차 재전사한다(부마다 모델 재로딩 방지).
 * 한 부 디코딩/전사 실패는 그 부만 건너뛴다. 반환: 오디오 있는 부가 하나도 없으면 'no-audio',
 * 하나라도 재전사에 성공하면 'done', 오디오는 있었으나 전부 무의미/실패면 'empty'.
 */
export async function retranscribeGroup(partIds: string[]): Promise<'done' | 'empty' | 'no-audio'> {
  const lastId = partIds[partIds.length - 1]
  const settings = loadSettings()
  let anyAudio = false
  let anyDone = false
  await runJob(lastId, 'retranscribe', async setStatus => {
    setStatus('오디오 준비 중…')
    const webgpu = (GROQ_ENABLED && settings.groqApiKey) ? false : await detectWebGPU()
    const eng = new WhisperLocalEngine()
    try {
      for (let i = 0; i < partIds.length; i++) {
        setStatus(`재전사 중… (${i + 1}/${partIds.length})`)
        // 방어: 분할 간격을 매우 크게 잡아 한 부가 상한을 넘으면 디코딩 불가 → 그 부만 건너뛴다.
        const m = await getMeeting(partIds[i])
        if (m && isTooLongToProcess(m.durationSec)) { dlog('retranscribeGroup', `부 ${i + 1} 건너뜀(너무 김)`); continue }
        try {
          const r = await transcribeOnePart(eng, partIds[i], settings, webgpu, setStatus)
          if (r !== 'no-audio') anyAudio = true
          if (r === 'done') anyDone = true
        } catch (e) {
          anyAudio = true
          dlog('retranscribeGroup', `부 ${i + 1} 건너뜀(실패)`, e instanceof Error ? e.message : e)
        }
      }
    } finally { eng.dispose() }
  })
  return anyDone ? 'done' : anyAudio ? 'empty' : 'no-audio'
}

/**
 * 화자 구분. 성공 시 세그먼트에 speaker를 입힌다.
 * 오디오가 없으면 'no-audio', 화자 결과가 비면 'empty', 그 외 'done'.
 */
export async function diarizeMeeting(meetingId: string): Promise<'done' | 'empty' | 'no-audio' | 'too-long'> {
  // 재전사와 동일하게 너무 긴 녹음은 디코딩 불가 → 화자 구분도 건너뛴다.
  const meeting = await getMeeting(meetingId)
  if (meeting && isTooLongToProcess(meeting.durationSec)) return 'too-long'
  let result: 'done' | 'empty' | 'no-audio' = 'no-audio'
  await runJob(meetingId, 'diarize', async setStatus => {
    setStatus('오디오 준비 중…')
    const engine = new DiarizeEngine()
    try {
      const blob = await getMeetingAudio(meetingId)
      if (!blob) { result = 'no-audio'; return }
      const samples = await decodeMeetingAudioWithRepair(meetingId, blob)
      setStatus('화자 구분 중…')
      const regions = await engine.diarize(samples, p => { if (p.kind === 'status') setStatus(p.message) })
      if (regions.length === 0) { result = 'empty'; return }
      await applySpeakers(meetingId, regions)
      result = 'done'
    } finally {
      engine.dispose()
    }
  })
  return result
}

/**
 * 그룹(여러 부) 통합 화자 구분. 각 부에서 임베딩만 추출하고, 전 부의 임베딩을 모아
 * 한 번에 클러스터링해 부 경계를 넘어 일관된 화자 라벨을 각 부 세그먼트에 부여한다.
 * 엔진은 1회만 로드. 한 부 디코딩/추출 실패는 그 부만 건너뛴다.
 * 반환: 'done' | 'empty'(임베딩 없음) | 'no-audio'(오디오 있는 부가 없음).
 */
export async function diarizeGroup(partIds: string[]): Promise<'done' | 'empty' | 'no-audio'> {
  const lastId = partIds[partIds.length - 1]
  let result: 'done' | 'empty' | 'no-audio' = 'no-audio'
  await runJob(lastId, 'diarize', async setStatus => {
    const engine = new DiarizeEngine()
    try {
      const parts: { partId: string; targets: { start: number; end: number }[]; embeddings: Float32Array[]; offsetSec: number }[] = []
      let offsetSec = 0
      let anyAudio = false
      for (let i = 0; i < partIds.length; i++) {
        const id = partIds[i]
        const meeting = await getMeeting(id)
        const partDur = meeting?.durationSec ?? 0
        setStatus(`화자 구분 중… (${i + 1}/${partIds.length})`)
        // 방어: 한 부가 상한을 넘으면 디코딩 불가 → 그 부만 건너뛴다(offset은 유지).
        if (isTooLongToProcess(partDur)) { dlog('diarizeGroup', `부 ${i + 1} 건너뜀(너무 김)`); offsetSec += partDur; continue }
        const blob = await getMeetingAudio(id)
        if (!blob) { offsetSec += partDur; continue }
        anyAudio = true
        try {
          const endDecode = dtimer('diarizeGroup', `부 ${i + 1} 디코딩`)
          const samples = await decodeMeetingAudioWithRepair(id, blob)
          endDecode()
          dlog('diarizeGroup', `부 ${i + 1}/${partIds.length} 디코딩 완료`, { sec: (samples.length / 16000).toFixed(1), mb: (samples.length * 4 / 1048576).toFixed(1) })
          const { targets, embeddings } = await engine.extract(samples, p => { if (p.kind === 'status') setStatus(p.message) })
          dlog('diarizeGroup', `부 ${i + 1} 발화 ${targets.length}개, 임베딩 ${embeddings.length}개`)
          parts.push({ partId: id, targets, embeddings, offsetSec })
        } catch (e) {
          dlog('diarizeGroup', `부 ${i + 1} 건너뜀(실패)`, e instanceof Error ? e.message : e)
        }
        offsetSec += partDur
      }
      if (!anyAudio) { result = 'no-audio'; return }
      const total = parts.reduce((n, p) => n + p.embeddings.length, 0)
      if (total === 0) { result = 'empty'; return }
      setStatus('화자 묶는 중…')
      const endCluster = dtimer('diarizeGroup', '전역 클러스터링')
      const perPartRegions = globalSpeakerRegions(parts.map(p => ({ targets: p.targets, embeddings: p.embeddings, offsetSec: p.offsetSec })))
      endCluster()
      const speakerCount = new Set(perPartRegions.flat().map(r => r.speaker)).size
      dlog('diarizeGroup', `전역 화자 ${speakerCount}명 (임베딩 ${total}개)`)
      for (let i = 0; i < parts.length; i++) {
        await applySpeakers(parts[i].partId, perPartRegions[i])
      }
      result = 'done'
    } finally {
      engine.dispose()
    }
  })
  return result
}

/**
 * AI 요약(Gemini). 키가 없으면 'no-key', 회의가 없으면 'no-segments',
 * 요약할 만한 실제 대화가 없으면(무음·'-'뿐) 'no-content', 그 외 'done'.
 * 기본 제목이면 AI가 제안한 제목으로 갱신한다(사용자 지정 제목·요약 도중 변경은 건드리지 않음).
 */
export async function summarizeMeeting(meetingId: string, template: SummaryTemplate): Promise<'done' | 'no-key' | 'no-segments' | 'no-content'> {
  const apiKey = loadSettings().geminiApiKey
  if (!apiKey.trim()) return 'no-key'
  const meeting = await getMeeting(meetingId)
  if (!meeting) return 'no-segments'
  const segments = (await getSegments(meetingId)).filter(s => s.isFinal)
  // 무의미 전사 가드: 세그먼트가 없거나 의미 문자가 부족하면 요약·제목 생성을 하지 않는다(잡도 안 뜸).
  if (!hasMeaningfulTranscript(segments)) return 'no-content'
  await runJob(meetingId, 'summarize', async setStatus => {
    setStatus('요약 중…')
    // 제목이 자동 생성 기본값이면 AI에게 내용 기반 제목을 함께 요청한다(사용자 지정 제목은 불변).
    const wantTitle = isDefaultTitle(meeting.title)
    const prompt = buildSummaryPrompt(template, meeting, segments, { suggestTitle: wantTitle })
    // 스트리밍 누적 길이를 진행 표시로 — 긴 회의도 멈춘 듯 보이지 않게.
    const raw = await summarizeWithGemini(prompt, apiKey, { onDelta: acc => setStatus(`요약 생성 중… (${acc.length}자)`) })
    const { title: aiTitle, body } = wantTitle ? extractSuggestedTitle(raw) : { title: null, body: raw }
    await saveSummary(meetingId, template, body, 'gemini-3.5-flash')
    // AI가 형식을 지켜 제목을 냈을 때만 반영 — 요약 도중 사용자가 제목을 고쳤으면(기본값 아님) 건드리지 않음.
    if (wantTitle && aiTitle) {
      const fresh = await getMeeting(meetingId)
      if (fresh && isDefaultTitle(fresh.title)) {
        await updateMeetingTitle(meetingId, withDateSuffix(aiTitle, meeting.createdAt))
      }
    }
  })
  return 'done'
}

/**
 * 여러 부(part)를 통합해 하나의 회의록으로 요약한다(Gemini). 키가 없으면 'no-key',
 * 모든 부를 합쳐도 요약할 만한 실제 대화가 없으면 'no-content', 그 외 'done'.
 * 진행 상태와 결과(요약·AI 제목)는 모두 **마지막 부**에 싣는다 — 종료 후 도착하는 화면이 마지막 부이므로.
 */
export async function summarizeGroup(
  partIds: string[], template: SummaryTemplate,
): Promise<'done' | 'no-key' | 'no-content'> {
  const apiKey = loadSettings().geminiApiKey
  if (!apiKey.trim()) return 'no-key'
  // 모든 부의 meeting + 확정 세그먼트를 순서대로 로드한다(없는 부는 건너뛴다).
  const parts: { meeting: Meeting; segments: TranscriptSegment[] }[] = []
  for (const id of partIds) {
    const meeting = await getMeeting(id)
    if (!meeting) continue
    const segments = (await getSegments(id)).filter(s => s.isFinal)
    parts.push({ meeting, segments })
  }
  if (parts.length === 0) return 'no-content'
  // 합산 무의미 전사 가드 — 전 부를 합쳐도 대화가 부족하면 요약하지 않는다.
  if (!hasMeaningfulTranscript(parts.flatMap(p => p.segments))) return 'no-content'

  const last = parts[parts.length - 1].meeting
  await runJob(last.id, 'summarize', async setStatus => {
    setStatus('통합 요약 중…')
    const wantTitle = isDefaultTitle(last.title)
    const prompt = buildGroupSummaryPrompt(template, parts, { suggestTitle: wantTitle })
    const raw = await summarizeWithGemini(prompt, apiKey, { onDelta: acc => setStatus(`통합 요약 생성 중… (${acc.length}자)`) })
    const { title: aiTitle, body } = wantTitle ? extractSuggestedTitle(raw) : { title: null, body: raw }
    await saveSummary(last.id, template, body, 'gemini-3.5-flash')
    if (wantTitle && aiTitle) {
      const fresh = await getMeeting(last.id)
      if (fresh && isDefaultTitle(fresh.title)) {
        await updateMeetingTitle(last.id, withDateSuffix(aiTitle, last.createdAt))
      }
    }
  })
  return 'done'
}
