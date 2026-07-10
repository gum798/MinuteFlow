import { applyCorrections, upsertCorrection } from './corrections'

describe('applyCorrections', () => {
  test('빈 사전이면 원문 그대로', () => {
    expect(applyCorrections('오늘 회의를 시작합니다', [])).toBe('오늘 회의를 시작합니다')
  })

  test('단일 치환', () => {
    expect(applyCorrections('머신런닝 세미나', [{ from: '머신런닝', to: '머신러닝' }])).toBe('머신러닝 세미나')
  })

  test('한글 from은 정확 부분 일치로 전역 치환된다', () => {
    expect(applyCorrections('머신런닝과 또 머신런닝', [{ from: '머신런닝', to: '머신러닝' }]))
      .toBe('머신러닝과 또 머신러닝')
  })

  test('ASCII from은 대소문자를 무시해 매칭하고 등록된 to 케이스로 출력한다', () => {
    expect(applyCorrections('data collected. Data Collected.', [{ from: 'Collected', to: 'collected' }]))
      .toBe('data collected. Data collected.')
  })

  test('ASCII from은 단어 경계로만 매칭한다(부분어 미치환)', () => {
    expect(applyCorrections('AI 는 RAIN 과 다르다', [{ from: 'AI', to: '인공지능' }]))
      .toBe('인공지능 는 RAIN 과 다르다')
  })

  test('부분문자열 오치환 방지: 더 긴 from을 먼저 적용한다', () => {
    const dict = [{ from: '회의', to: '미팅' }, { from: '회의록', to: '미팅기록' }]
    expect(applyCorrections('회의록 그리고 회의', dict)).toBe('미팅기록 그리고 미팅')
  })

  test('여러 항목을 모두 적용한다', () => {
    const dict = [{ from: 'ai', to: 'AI' }, { from: '머신런닝', to: '머신러닝' }]
    expect(applyCorrections('ai 머신런닝', dict)).toBe('AI 머신러닝')
  })

  test('정규식 특수문자가 든 from(한글 포함)도 리터럴로 안전 치환한다', () => {
    expect(applyCorrections('(주)미래 인사', [{ from: '(주)미래', to: '미래컴퍼니' }]))
      .toBe('미래컴퍼니 인사')
  })
})

describe('upsertCorrection', () => {
  test('새 항목을 추가한다', () => {
    expect(upsertCorrection([], 'a', 'b')).toEqual([{ from: 'a', to: 'b' }])
  })

  test('중복 from은 최신 to로 갱신한다', () => {
    expect(upsertCorrection([{ from: 'a', to: 'b' }], 'a', 'c')).toEqual([{ from: 'a', to: 'c' }])
  })

  test('빈 from·from===to는 제외해 사전이 그대로다', () => {
    const dict = [{ from: 'a', to: 'b' }]
    expect(upsertCorrection(dict, '', 'x')).toEqual(dict)
    expect(upsertCorrection(dict, '   ', 'x')).toEqual(dict)
    expect(upsertCorrection(dict, 'z', 'z')).toEqual(dict)
  })
})
