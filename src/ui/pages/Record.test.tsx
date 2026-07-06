import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Record from './Record'

function renderRecord() {
  return render(
    <MemoryRouter initialEntries={['/record']}>
      <Routes>
        <Route path="/record" element={<Record />} />
        <Route path="/meeting/:id" element={<div>회의록 페이지</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => vi.unstubAllGlobals())

test('마이크 권한 거부 시 에러 메시지를 보여준다', async () => {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
  })
  renderRecord()
  await userEvent.click(screen.getByRole('button', { name: /녹음 시작/ }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/마이크/))
})

test('Web Speech 미지원 브라우저 안내가 보인다', () => {
  // jsdom에는 SpeechRecognition이 없으므로 기본 상태가 미지원
  renderRecord()
  expect(screen.getByText(/실시간 자막을 지원하지 않습니다/)).toBeInTheDocument()
})

test('시작 전에는 종료 버튼이 없다', () => {
  renderRecord()
  expect(screen.queryByRole('button', { name: /종료/ })).not.toBeInTheDocument()
})
