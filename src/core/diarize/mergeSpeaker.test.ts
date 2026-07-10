import { canonicalSpeakerLabel, relabelSpeaker } from './mergeSpeaker'

describe('canonicalSpeakerLabel — 이름으로 병합 대상 라벨 찾기', () => {
  test('그 이름을 가진 다른 라벨을 돌려준다', () => {
    const names = { SPK1: '서', SPK7: '이' }
    expect(canonicalSpeakerLabel(names, '서', 'SPK7')).toBe('SPK1')
  })

  test('여러 라벨이 같은 이름이면 가장 낮은 SPK 번호(색 안정)를 고른다', () => {
    const names = { SPK3: '서', SPK1: '서', SPK9: '서' }
    expect(canonicalSpeakerLabel(names, '서', 'SPK12')).toBe('SPK1')
  })

  test('자기 자신(exclude)은 대상에서 제외한다', () => {
    const names = { SPK1: '서' }
    expect(canonicalSpeakerLabel(names, '서', 'SPK1')).toBeNull()
  })

  test('그 이름을 가진 기존 라벨이 없으면 null (합칠 상대 없음)', () => {
    const names = { SPK1: '서' }
    expect(canonicalSpeakerLabel(names, '박', 'SPK2')).toBeNull()
  })

  test('공백 이름은 null', () => {
    expect(canonicalSpeakerLabel({ SPK1: '서' }, '   ', 'SPK2')).toBeNull()
  })
})

describe('relabelSpeaker — 세그먼트 라벨 재지정', () => {
  test('from 라벨만 to로 바꾸고 나머지는 보존한다', () => {
    const segs = [
      { id: 'a', speaker: 'SPK7', text: 'x' },
      { id: 'b', speaker: 'SPK1', text: 'y' },
      { id: 'c', speaker: 'SPK7', text: 'z' },
    ]
    expect(relabelSpeaker(segs, 'SPK7', 'SPK1')).toEqual([
      { id: 'a', speaker: 'SPK1', text: 'x' },
      { id: 'b', speaker: 'SPK1', text: 'y' },
      { id: 'c', speaker: 'SPK1', text: 'z' },
    ])
  })

  test('from === to면 원본을 그대로 반환한다', () => {
    const segs = [{ id: 'a', speaker: 'SPK1' }]
    expect(relabelSpeaker(segs, 'SPK1', 'SPK1')).toBe(segs)
  })
})
