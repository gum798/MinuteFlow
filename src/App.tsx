import { Routes, Route } from 'react-router-dom'
import AppShell from './ui/AppShell'
import Home from './ui/pages/Home'
import Record from './ui/pages/Record'
import MeetingPage from './ui/pages/Meeting'

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/record" element={<Record />} />
        <Route path="/meeting/:id" element={<MeetingPage />} />
        <Route path="/upload" element={<div />} />
        <Route path="/settings" element={<div />} />
      </Route>
    </Routes>
  )
}
