import { Routes, Route } from 'react-router-dom'
import Home from './ui/pages/Home'
import Record from './ui/pages/Record'
import MeetingPage from './ui/pages/Meeting'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/record" element={<Record />} />
      <Route path="/meeting/:id" element={<MeetingPage />} />
    </Routes>
  )
}
