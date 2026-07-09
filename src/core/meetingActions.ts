// 재전사·화자 구분·요약의 UI 무관 로직. Meeting 화면과 자동 파이프라인이 공유한다.
// 각 함수는 내부에서 runJob(meetingId, kind, ...)으로 전역 작업 스토어에 진행 상태를 싣고,
// 결과를 반환한다(성공/빈결과/오디오없음). 작업 중 던진 예외는 runJob이 job-done(error)로
// 표면화하므로 여기서 별도 알림을 하지 않는다 — 안내(alert)는 호출부(Meeting)가 반환값으로 판단.

import { getMeetingAudio, getMeeting, getSegments, replaceAudio, replaceSegments, applySpeakers, updateSpeakerNames, saveSummary, updateMeetingTitle } from './store/meetings'
import { runJob } from './jobs'
import { loadSettings } from './settings'
import { decodeTo16kMono } from './audio/decode'
import { repairHeaderlessWebm } from './audio/webmRepair'
import { detectWebGPU, WhisperLocalEngine } from './stt/whisperLocal'
import { DiarizeEngine } from './diarize/diarizeLocal'
import { transcribeSamplesWithGroq } from './stt/groq'
import { GROQ_ENABLED } from './features'
import { buildSummaryPrompt, extractSuggestedTitle, isDefaultTitle, withDateSuffix, type SummaryTemplate } from './summarize/prompts'
import { summarizeWithGemini } from './summarize/gemini'

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
 * 오디오가 없으면 'no-audio', 전사 결과가 비면 'empty'(기존 유지), 그 외 'done'.
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
    if (segs.length === 0) { result = 'empty'; return } // 빈 결과 — 기존 전사 보존
    await replaceSegments(meetingId, segs.map(s => ({ ...s, source, isFinal: true })))
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
 * AI 요약(Gemini). 키가 없으면 'no-key', 전사 세그먼트가 없으면 'no-segments', 그 외 'done'.
 * 기본 제목이면 AI가 제안한 제목으로 갱신한다(사용자 지정 제목·요약 도중 변경은 건드리지 않음).
 */
export async function summarizeMeeting(meetingId: string, template: SummaryTemplate): Promise<'done' | 'no-key' | 'no-segments'> {
  const apiKey = loadSettings().geminiApiKey
  if (!apiKey.trim()) return 'no-key'
  const meeting = await getMeeting(meetingId)
  if (!meeting) return 'no-segments'
  const segments = (await getSegments(meetingId)).filter(s => s.isFinal)
  if (segments.length === 0) return 'no-segments'
  await runJob(meetingId, 'summarize', async setStatus => {
    setStatus('요약 중…')
    // 제목이 자동 생성 기본값이면 AI에게 내용 기반 제목을 함께 요청한다(사용자 지정 제목은 불변).
    const wantTitle = isDefaultTitle(meeting.title)
    const prompt = buildSummaryPrompt(template, meeting, segments, { suggestTitle: wantTitle })
    const raw = await summarizeWithGemini(prompt, apiKey)
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
