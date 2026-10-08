/** Inline visual delivery copy. */

/** Locale namespace for the presented-visual node. */
export const NS = 'visuals'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'visual.expand': '放大查看',
  'visual.download': '下载原始文件',
  'visual.close': '关闭视觉预览',
  'visual.failed': '无法显示此视觉内容，请下载原始文件查看。',
  'visual.isolated': '隔离的交互原型',
}

/** Locale keys the presented-visual node renders. */
export type VisualsKey = keyof typeof zh

/** English dictionary (same key set). */
export const en: Record<VisualsKey, string> = {
  'visual.expand': 'Expand view',
  'visual.download': 'Download original',
  'visual.close': 'Close visual preview',
  'visual.failed': 'This visual could not be displayed. Download the original to inspect it.',
  'visual.isolated': 'Isolated interactive mockup',
}
