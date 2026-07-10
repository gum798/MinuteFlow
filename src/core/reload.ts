/** 페이지를 새로고침한다. 테스트에서 모킹 가능하도록 별도 모듈로 분리(window.location.reload는 직접 스파이 불가). */
export function reloadPage(): void {
  window.location.reload()
}
