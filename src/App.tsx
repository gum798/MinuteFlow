import { Routes, Route } from 'react-router-dom'
import Home from './ui/pages/Home'
import Record from './ui/pages/Record'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/record" element={<Record />} />
    </Routes>
  )
}
