// 재전사·화자 구분·요약의 UI 무관 로직. Meeting 화면과 자동 파이프라인이 공유한다.
// 각 함수는 내부에서 runJob(meetingId, kind, ...)으로 전역 작업 스토어에 진행 상태를 싣고,
// 결과를 반환한다(성공/빈결과/오디오없음). 작업 중 던진 예외는 runJob이 job-done(error)로
// 표면화하므로 여기서 별도 알림을 하지 않는다 — 안내(alert)는 호출부(Meeting)가 반환값으로 판단.

import { getMeetingAudio, getMeeting, getSegments, replaceAudio, replaceSegments, applySpeakers, updateSpeakerNames, saveSummary, updateMeetingTitle } from './store/meetings'
import { runJob } from './jobs'
import { loadSettings } from './settings'
import { applyCorrections } from './corrections'
import { decodeTo16kMono } from './audio/decode'
import { repairHeaderlessWebm } from './audio/webmRepair'
import { detectWebGPU, WhisperLocalEngine } from './stt/whisperLocal'
import { DiarizeEngine } from './diarize/diarizeLocal'
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

// Whisper는 무음·잡음 구간에서 같은 짧은 문구를 규칙적으로 반복 출력하는 환각을 낸다("지금 지금 지금…").
// 정규화한 텍스트가 직전과 같은 짧은(≤6자) 조각이 REPEAT_RUN회 이상 연달아 나오면 그 연속을 통째로 제거한다.
// 실제 대화의 자연스러운 반복(예: "네 네")까지 지우지 않도록 임계를 보수적으로(4회) 둔다.
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
    // 짧은 조각이 4회 이상 반복 → 환각으로 보고 전부 버린다. 그 외에는 보존.
    if (key.length > 0 && key.length <= SHORT_LEN && runLen >= REPEAT_RUN) {
      i = j
      continue
    }
    for (let k = i; k < j; k++) out.push(segments[k])
    i = j
  }
  return out
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
 * 고품질 재전사. 성공 시 세그먼트를 교체하고 화자 이름 맵을 초기화한다.
 * 오디오가 없으면 'no-audio', 전사 결과가 비거나 의미 없는 조각(무음 → '-' 등)뿐이면 'empty'(기존 유지), 그 외 'done'.
 */
export async function retranscribeMeeting(meetingId: string): Promise<'done' | 'empty' | 'no-audio'> {
  const settings = loadSettings()
  let result: 'done' | 'empty' | 'no-audio' = 'no-audio'
  await runJob(meetingId, 'retranscribe', async setStatus => {
    setStatus('오디오 준비 중…')
    const blob = await getMeetingAudio(meetingId)
    if (!blob) { result = 'no-audio'; return }
    const samples = await decodeMeetingAudioWithRepair(meetingId, blob)
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
      const webgpu = await detectWebGPU()
      const eng = new WhisperLocalEngine()
      try {
        setStatus('브라우저 Whisper로 전사 중… (모델 다운로드가 필요할 수 있어요)')
        segs = await eng.transcribe(samples, {
          model: webgpu ? settings.whisperModel : 'onnx-community/whisper-base',
          device: webgpu ? 'webgpu' : 'wasm',
          language: settings.language,
        }, p => { if (p.kind === 'status') setStatus(p.message) })
      } finally { eng.dispose() }
    }
    // 무의미 조각('-', 공백)을 먼저 걸러 반복이 이어지게 한 뒤 환각("지금 지금…")을 제거한다.
    const meaningful = dropHallucinatedRepeats(segs.filter(s => isMeaningfulText(s.text)))
    if (meaningful.length === 0) { result = 'empty'; return } // 빈/무의미 결과 — 기존 전사 보존
    // 등록된 보정 사전을 전사 출력에 자동 적용해 반복 오전사를 교정한다.
    await replaceSegments(meetingId, meaningful.map(s => ({
      ...s, text: applyCorrections(s.text, settings.corrections), source, isFinal: true,
    })))
    // 재전사로 기존 speaker가 사라지므로 화자 이름 맵도 초기화 — 재-화자구분 시 옛 이름 오염 방지.
    await updateSpeakerNames(meetingId, {})
    result = 'done'
  })
  return result
}

/**
 * 화자 구분. 성공 시 세그먼트에 speaker를 입힌다.
 * 오디오가 없으면 'no-audio', 화자 결과가 비면 'empty', 그 외 'done'.
 */
export async function diarizeMeeting(meetingId: string): Promise<'done' | 'empty' | 'no-audio'> {
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
