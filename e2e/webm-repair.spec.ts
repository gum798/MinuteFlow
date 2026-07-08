import { test, expect } from '@playwright/test'

// page.evaluate는 사용자 제스처가 없어 AudioContext가 suspended로 시작한다 → 무음 그래프가
// 렌더링되지 않아 도너에 Cluster가 안 생긴다. 자동재생 정책을 풀어 제스처 없이도 그래프를 돌린다.
// (실앱은 버튼 클릭 흐름이라 이 플래그가 불필요.) launchOptions는 통째로 대체되므로 기존
// 가짜 장치 인자도 함께 명시한다.
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
})

// 헤더 잃은 WebM 자동 수선을 실제 chromium(가짜 오디오 장치)에서 검증한다.
//
// 시나리오:
//  1) MediaRecorder로 3초 녹음(timeslice 500ms) → 청크 배열 확보
//  2) 첫 청크(=WebM 초기화 세그먼트 포함)를 버리고 나머지 concat = "고아" blob
//  3) 고아는 decodeAudioData 실패(헤더 없음) 확인
//  4) 무음 스트림으로 도너 헤더 캡처 → 첫 Cluster 이전 바이트 이식
//  5) 수선본은 decodeAudioData 성공 + duration > 1.5초
//
// 앱 번들을 window에 노출하지 않으므로 repairHeaderlessWebm과 동일한 알고리즘을 spec 안에
// 인라인 재현해 "접근법 자체"가 실환경에서 성립함을 검증한다.
test('헤더 잃은 WebM 고아 오디오를 도너 헤더 이식으로 수선한다', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(async () => {
    const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]
    const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75]
    const startsWithEbml = (b: Uint8Array) => EBML_MAGIC.every((v, i) => b[i] === v)
    const findClusterOffset = (b: Uint8Array, from = 0) => {
      const [x, y, z, w] = CLUSTER_ID
      for (let i = Math.max(0, from); i + 3 < b.length; i++) {
        if (b[i] === x && b[i + 1] === y && b[i + 2] === z && b[i + 3] === w) return i
      }
      return -1
    }
    const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())
    const decodeOk = async (blob: Blob): Promise<{ ok: boolean; duration: number }> => {
      const ac = new AudioContext()
      try {
        const buf = await ac.decodeAudioData(await blob.arrayBuffer())
        return { ok: true, duration: buf.duration }
      } catch {
        return { ok: false, duration: 0 }
      } finally {
        void ac.close()
      }
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : ''
    const recOpts = mimeType ? { mimeType } : undefined

    // 1) 실제 3초 녹음 (가짜 장치의 톤), timeslice 500ms
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recChunks: Blob[] = []
    const rec = new MediaRecorder(stream, recOpts)
    rec.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data) }
    rec.start(500)
    await new Promise(r => setTimeout(r, 3000))
    await new Promise<void>(r => { rec.onstop = () => r(); rec.stop() })
    stream.getTracks().forEach(t => t.stop())

    // 2) 첫 청크 버리고 나머지 concat = 고아
    const orphanBlob = new Blob(recChunks.slice(1), { type: mimeType || 'audio/webm' })
    const orphanBytes = await bytesOf(orphanBlob)
    const orphanHasEbml = startsWithEbml(orphanBytes)

    // 3) 고아 decode 실패
    const orphanDecode = await decodeOk(orphanBlob)

    // 4) 도너 헤더 캡처 (마이크 불필요, 무음: 오실레이터 → gain 0 → destination)
    //    소스를 아예 안 연결하면 Chrome이 프레임을 안 내보내 dataavailable이 발화하지 않는다.
    const dctx = new AudioContext()
    await dctx.resume()
    const dest = dctx.createMediaStreamDestination()
    const osc = dctx.createOscillator()
    const silent = dctx.createGain()
    silent.gain.value = 0
    osc.connect(silent).connect(dest)
    osc.start()
    const drec = new MediaRecorder(dest.stream, recOpts)
    const dChunks: Blob[] = []
    await new Promise<void>(resolve => {
      let n = 0
      const timer = setTimeout(resolve, 3000)
      drec.ondataavailable = e => {
        if (e.data.size > 0) { dChunks.push(e.data); n++ }
        if (n >= 2) { clearTimeout(timer); resolve() }
      }
      drec.start(200)
    })
    await new Promise<void>(r => { drec.onstop = () => r(); drec.stop() })
    void dctx.close()
    const donorBytes = await bytesOf(new Blob(dChunks))
    const donorClusterOffset = findClusterOffset(donorBytes)
    const donorHeader = donorBytes.slice(0, donorClusterOffset)

    // 5) 이식: donorHeader + orphan(첫 Cluster부터)
    const orphanClusterOffset = findClusterOffset(orphanBytes)
    const body = orphanBytes.subarray(Math.max(0, orphanClusterOffset))
    const repaired = new Blob([donorHeader, body], { type: mimeType || 'audio/webm' })
    const repairedDecode = await decodeOk(repaired)

    return {
      numRecChunks: recChunks.length,
      orphanHasEbml,
      orphanDecodeOk: orphanDecode.ok,
      donorClusterOffset,
      orphanClusterOffset,
      repairedDecodeOk: repairedDecode.ok,
      repairedDuration: repairedDecode.duration,
    }
  })

  // 여러 청크가 생겨야 "첫 청크 버리기"가 유의미하다
  expect(result.numRecChunks).toBeGreaterThan(1)
  // 도너/고아 모두 Cluster를 찾았고, 도너는 헤더(오프셋>0)를 가진다
  expect(result.donorClusterOffset).toBeGreaterThan(0)
  expect(result.orphanClusterOffset).toBeGreaterThanOrEqual(0)
  // 고아는 헤더가 없어 decode 실패
  expect(result.orphanHasEbml).toBe(false)
  expect(result.orphanDecodeOk).toBe(false)
  // 수선본은 decode 성공 + 유의미한 길이
  expect(result.repairedDecodeOk).toBe(true)
  expect(result.repairedDuration).toBeGreaterThan(1.5)
})
