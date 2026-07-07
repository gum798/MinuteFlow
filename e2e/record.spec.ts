import { test, expect } from '@playwright/test'

// HashRouter 라우팅 + 전역 녹음 세션(src/core/recorder/session.ts) 기준 실셀렉터.
// 가짜 마이크(--use-fake-device-for-media-stream)로 실제 MediaRecorder 청크가 생성된다.
// 청크 타임슬라이스는 10초(chunkedRecorder)이므로 최소 1개 확보를 위해 12초 녹음한다.
const CHUNK_WAIT_MS = 12_000

test('녹음 → 종료 → 회의록에서 오디오 다운로드', async ({ page }) => {
  await page.goto('/#/record?autostart=1')

  // 자동 시작 → 녹음 중이면 [종료] 버튼이 노출된다(녹음 상태의 유일한 신호).
  // nav rec-chip과 p.sub 둘 다 "녹음 중"을 담으므로 텍스트 대신 버튼으로 판별.
  const stopBtn = page.getByRole('button', { name: '종료' })
  await expect(stopBtn).toBeVisible({ timeout: 15_000 })
  // 녹음 중 경과시간 표시도 함께 확인
  await expect(page.locator('p.sub')).toContainText('녹음 중')

  // 청크 1개 이상 확보
  await page.waitForTimeout(CHUNK_WAIT_MS)

  // 종료 → 회의 상세로 이동
  await stopBtn.click()
  await expect(page).toHaveURL(/#\/meeting\//, { timeout: 20_000 })

  // 오디오가 저장되어 다운로드 버튼이 보인다
  await expect(page.getByRole('button', { name: '오디오 다운로드' })).toBeVisible()
})

test('크래시 복구: 녹음 중 새로고침 후 홈 배너에서 복구', async ({ page }) => {
  await page.goto('/#/record?autostart=1')
  await expect(page.getByRole('button', { name: '종료' })).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(CHUNK_WAIT_MS)

  // 크래시 시뮬레이션: 해시만 홈으로 바꿔(세션은 아직 살아있음) 자동시작 URL을 벗어난 뒤
  // 전체 새로고침으로 인메모리 세션을 파괴한다. 미완료 회의(status:'recording')는 IndexedDB에 남는다.
  // (녹음 URL을 그대로 reload하면 autostart가 두 번째 녹음을 만들어 배너가 중복되므로 이렇게 분리한다.)
  await page.evaluate(() => { window.location.hash = '#/' })
  await page.reload()

  // 홈에서 복구 배너 노출 → [복구] → 회의록 도달
  await expect(page.getByText('복구할 녹음이 있습니다')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '복구' }).click()
  await expect(page).toHaveURL(/#\/meeting\//, { timeout: 15_000 })
})
