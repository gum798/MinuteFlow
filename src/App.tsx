import { Routes, Route } from 'react-router-dom'
import AppShell from './ui/AppShell'
import Home from './ui/pages/Home'
import Record from './ui/pages/Record'
import MeetingPage from './ui/pages/Meeting'
import Settings from './ui/pages/Settings'
import Upload from './ui/pages/Upload'

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/record" element={<Record />} />
        <Route path="/meeting/:id" element={<MeetingPage />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
