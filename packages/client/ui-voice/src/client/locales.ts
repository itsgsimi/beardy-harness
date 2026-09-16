/** Voice control copy. */
export const en = {
  start: 'Dictate a message', stop: 'Stop recording', cancel: 'Cancel recording',
  recording: 'Recording', transcribing: 'Transcribing…', requesting: 'Allow microphone access…',
  unsupported: 'Microphone access requires HTTPS or localhost and a supported browser.',
  failed: 'Could not transcribe. Check microphone access and try again.',
  empty: 'No speech detected. Try again.', insert: 'Insert transcript',
} as const
export type VoiceKey = keyof typeof en
export const zh: Record<VoiceKey, string> = {
  start: '语音输入', stop: '停止录音', cancel: '取消录音', recording: '正在录音',
  transcribing: '正在转录…', requesting: '请允许访问麦克风…',
  unsupported: '麦克风需要 HTTPS 或 localhost 以及受支持的浏览器。',
  failed: '无法转录。请检查麦克风权限后重试。', empty: '未检测到语音，请重试。', insert: '插入转录文本',
}
