import { render, screen } from '@testing-library/react'
import { Markdown } from './Markdown'

test('헤딩 3레벨을 h2/h3/h4로 렌더한다', () => {
  render(<Markdown text={'# 회의록\n## 안건\n### 세부'} />)
  expect(screen.getByRole('heading', { level: 2, name: '회의록' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { level: 3, name: '안건' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { level: 4, name: '세부' })).toBeInTheDocument()
})

test('연속된 -/* 줄을 하나의 ul로 묶는다 (2단계 들여쓰기는 평탄화)', () => {
  const { container } = render(<Markdown text={'- 하나\n* 둘\n  - 셋'} />)
  expect(container.querySelectorAll('ul')).toHaveLength(1)
  expect(container.querySelectorAll('li')).toHaveLength(3)
})

test('빈 줄로 끊긴 리스트는 별개의 ul이 된다', () => {
  const { container } = render(<Markdown text={'- 하나\n\n- 둘'} />)
  expect(container.querySelectorAll('ul')).toHaveLength(2)
})

test('**bold**는 strong으로, 미닫힘 **는 원문 그대로 남는다', () => {
  const { container } = render(<Markdown text={'이건 **굵게** 표시. 미닫힘 **열림'} />)
  const strongs = container.querySelectorAll('strong')
  expect(strongs).toHaveLength(1)
  expect(strongs[0]?.textContent).toBe('굵게')
  expect(container.textContent).toContain('미닫힘 **열림')
})

test('--- 단독 줄은 hr(.md-hr)로 렌더한다', () => {
  const { container } = render(<Markdown text={'위\n\n---\n\n아래'} />)
  const hr = container.querySelector('hr.md-hr')
  expect(hr).not.toBeNull()
})

test('XSS: HTML 문자열은 텍스트로만 보이고 실제 엘리먼트가 생기지 않는다', () => {
  const { container } = render(<Markdown text={'<script>alert(1)</script> 그리고 <b>진하게</b>'} />)
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('b')).toBeNull()
  expect(container.textContent).toContain('<script>alert(1)</script>')
  expect(container.textContent).toContain('<b>진하게</b>')
})
