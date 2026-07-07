import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'

test('앱 타이틀이 렌더링된다', () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  )
  expect(screen.getAllByText(/MinuteFlow/).length).toBeGreaterThanOrEqual(1)
})
