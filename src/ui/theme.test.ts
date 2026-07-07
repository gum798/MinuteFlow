import fs from 'node:fs'
import path from 'node:path'

const css = fs.readFileSync(path.resolve(__dirname, 'theme.css'), 'utf-8')

test('디자인 토큰 CSS 변수가 정의되어 있다', () => {
  for (const v of ['--bg: #F4F5F9', '--surface: #FFFFFF', '--accent: #1E43B8',
    '--accent-hover: #16359B', '--accent-soft: #EEF2FD', '--text-strong: #1A2033',
    '--border: #E4E7EE', '--input-border: #D8DDE8']) {
    expect(css).toContain(v)
  }
})

test('컴포넌트 클래스 계약이 존재한다', () => {
  for (const cls of ['.btn-primary', '.btn-outline', '.btn-ghost', '.card',
    '.badge', '.input', '.progress', '.dropzone', '.sidebar', '.nav-item', '.content', '.toast']) {
    expect(css).toContain(cls)
  }
})

test('색상 하드코딩 대신 변수 사용 — accent 원색이 변수 정의 외에 재등장하지 않는다', () => {
  const defs = css.split('\n').filter(l => l.includes('#1E43B8'))
  // :root 변수 정의 줄에서만 허용
  expect(defs.every(l => l.trim().startsWith('--'))).toBe(true)
})
