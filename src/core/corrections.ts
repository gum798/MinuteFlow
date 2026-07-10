// 후처리 보정 사전(find-replace). Whisper 전사 출력에 등록 어휘를 자동 적용해
// 반복되는 오전사(오탈자·고유명사)를 사용자가 등록한 표기로 교정한다.
// 순수 함수 — UI·저장소와 무관하며 전사 파이프라인과 회의 화면이 공유한다.

export interface Correction {
  from: string
  to: string
}

// 정규식 메타문자를 리터럴로 이스케이프한다.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ASCII로만 된 문자열인지(영문·숫자·기호). 한글 등 비ASCII가 하나라도 있으면 false.
function isAscii(s: string): boolean {
  return /^[\x00-\x7F]+$/.test(s)
}

/**
 * 등록된 보정을 텍스트에 적용한다.
 * - from 길이 내림차순으로 적용해 부분문자열 오치환을 막는다(예: '회의록'을 '회의'보다 먼저).
 * - from은 정규식 이스케이프 후 전역 치환한다.
 *   · ASCII만으로 된 from은 대소문자 무시(gi) + 단어 경계(\b)로 부분어 오치환을 막는다.
 *   · 한글 등 비ASCII from은 단어 경계 개념이 약하므로 정확 부분 일치로 전역 치환한다.
 * - to는 등록된 케이스 그대로 출력한다.
 */
export function applyCorrections(text: string, dict: Correction[]): string {
  const sorted = dict.filter(c => c.from).sort((a, b) => b.from.length - a.from.length)
  let out = text
  for (const { from, to } of sorted) {
    const esc = escapeRegExp(from)
    const re = isAscii(from) ? new RegExp(`\\b${esc}\\b`, 'gi') : new RegExp(esc, 'g')
    out = out.replace(re, () => to) // 함수 replacer로 to 안의 $& 등 치환 패턴 무력화
  }
  return out
}

/**
 * 사전에 보정을 추가·갱신한다.
 * - 빈 from(공백뿐 포함)이거나 from===to면 무의미하므로 사전을 그대로 반환한다.
 * - 이미 있는 from이면 최신 to로 갱신하고, 없으면 끝에 추가한다.
 */
export function upsertCorrection(dict: Correction[], from: string, to: string): Correction[] {
  if (!from.trim() || from === to) return dict
  const idx = dict.findIndex(c => c.from === from)
  if (idx >= 0) {
    const next = [...dict]
    next[idx] = { from, to }
    return next
  }
  return [...dict, { from, to }]
}
