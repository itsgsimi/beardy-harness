/** Research report row and research settings copy. */

/** Locale namespace for every research surface. */
export const NS = 'research'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '深度研究',
  'row.running': '研究中',
  'row.ok': '已完成',
  'row.error': '失败',
  'row.stopped': '已停止',
  'row.inspect': '查看调用',
  'report.open': '打开研究报告',
  'report.title': '研究报告',
  'report.close': '关闭报告',
  'report.download': '下载 Markdown',
  'report.sources': '来源',
  'report.evidence': '模型生成的研究内容。请根据来源核实重要结论。',
  'report.copy': '复制代码',
  'report.copied': '已复制',
  'report.footnotes': '脚注',
  'settings.title': '深度研究',
  'settings.description': '选择新研究任务使用的工作模型。',
  'settings.model': '研究模型',
  'settings.hint': '现有任务继续使用原来的工作模型。',
  'settings.loading': '正在加载研究设置…',
  'settings.unavailable': '此配置未启用研究功能。',
  'settings.saveFailed': '无法保存研究模型。',
}

/** Locale keys the research surfaces render. */
export type ResearchKey = keyof typeof zh

/** English dictionary (same key set). */
export const en: Record<ResearchKey, string> = {
  'row.title': 'Deep research',
  'row.running': 'Researching',
  'row.ok': 'Done',
  'row.error': 'Failed',
  'row.stopped': 'Stopped',
  'row.inspect': 'Inspect call',
  'report.open': 'Open research report',
  'report.title': 'Research report',
  'report.close': 'Close report',
  'report.download': 'Download Markdown',
  'report.sources': 'Sources',
  'report.evidence': 'Model-generated research. Verify important claims against the sources.',
  'report.copy': 'Copy code',
  'report.copied': 'Copied',
  'report.footnotes': 'Footnotes',
  'settings.title': 'Deep research',
  'settings.description': 'Choose the worker for new research jobs.',
  'settings.model': 'Research model',
  'settings.hint': 'Existing jobs keep their original worker.',
  'settings.loading': 'Loading research settings…',
  'settings.unavailable': 'Research is not configured for this profile.',
  'settings.saveFailed': 'Could not save the research model.',
}
