const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

export function pickMimeType(
  isSupported: (t: string) => boolean = t => MediaRecorder.isTypeSupported(t),
): string | undefined {
  return CANDIDATES.find(isSupported)
}
