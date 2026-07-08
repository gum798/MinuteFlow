import { type JSX, type ReactNode } from 'react'

// 의존성 없는 서브셋 마크다운 파서 + 렌더러.
// Gemini 요약 출력 패턴(#/##/### 헤딩, -/* 리스트, --- 구분선, **bold**, 빈 줄 문단)만 지원.
// dangerouslySetInnerHTML을 쓰지 않고 React 엘리먼트로만 렌더하므로 XSS가 원천 차단된다.

type Block =
  | { type: 'heading'; level: 2 | 3 | 4; text: string }
  | { type: 'hr' }
  | { type: 'list'; items: string[] }
  | { type: 'p'; text: string }

const HEADING_RE = /^(#{1,3})\s+(.*)$/
const LIST_RE = /^[-*]\s+(.+)$/
const BOLD_RE = /\*\*([^*]+?)\*\*/g

/** 줄 단위 순수 파서. 빈 줄로 문단·리스트를 끊고, 들여쓴 2단계 리스트는 1단계로 평탄화한다. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  let list: string[] | null = null

  const flushPara = (): void => {
    if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = [] }
  }
  const flushList = (): void => {
    if (list) { blocks.push({ type: 'list', items: list }); list = null }
  }

  for (const raw of lines) {
    const line = raw.trim() // 들여쓰기 제거 → 2단계 리스트 평탄화
    if (line === '') { flushList(); flushPara(); continue }
    if (line === '---') { flushList(); flushPara(); blocks.push({ type: 'hr' }); continue }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushList(); flushPara()
      const level = (heading[1].length + 1) as 2 | 3 | 4 // # → h2, ## → h3, ### → h4
      blocks.push({ type: 'heading', level, text: heading[2].trim() })
      continue
    }

    const item = LIST_RE.exec(line)
    if (item) {
      flushPara()
      if (!list) list = []
      list.push(item[1].trim())
      continue
    }

    // 그 외: 일반 텍스트 → 문단에 누적(빈 줄 전까지 한 문단)
    flushList()
    para.push(line)
  }
  flushList(); flushPara()
  return blocks
}

/** 인라인 **bold** 만 <strong>으로. 미닫힘 `**`는 매칭되지 않아 원문 그대로 남는다. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let i = 0
  BOLD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BOLD_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[1]}</strong>)
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const HEADING_STYLE: Record<2 | 3 | 4, { fontSize: number; fontWeight: number }> = {
  2: { fontSize: 18, fontWeight: 800 },
  3: { fontSize: 15, fontWeight: 700 },
  4: { fontSize: 13.5, fontWeight: 700 },
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = parseBlocks(text)
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': {
            const Tag = (`h${b.level}`) as 'h2' | 'h3' | 'h4'
            return <Tag key={i} style={HEADING_STYLE[b.level]}>{renderInline(b.text, `h${i}`)}</Tag>
          }
          case 'hr':
            return <hr key={i} className="md-hr" />
          case 'list':
            return (
              <ul key={i}>
                {b.items.map((it, j) => <li key={j}>{renderInline(it, `l${i}-${j}`)}</li>)}
              </ul>
            )
          case 'p':
            return <p key={i}>{renderInline(b.text, `p${i}`)}</p>
        }
      })}
    </>
  )
}
