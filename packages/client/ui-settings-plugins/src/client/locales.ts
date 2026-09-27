/** Locale bundles for the built-in plugins settings section. */

/** Locale keys the section renders. */
export type PluginsSettingsLocaleKey = 'nav' | 'title' | 'intro' | 'tabs' | 'empty'
  | 'researchTitle' | 'researchDescription' | 'researchModel' | 'researchHint'
  | 'researchLoading' | 'researchUnavailable' | 'researchSaveFailed'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Built-in plugins',
  title: 'Built-in plugins',
  intro: 'Inspect the plugins this deployment ships.',
  tabs: 'Plugin views',
  empty: 'This deployment exposes no plugin views.',
  researchTitle: 'Deep research', researchDescription: 'Choose the worker for new research jobs.',
  researchModel: 'Research model', researchHint: 'Existing jobs keep their original worker.',
  researchLoading: 'Loading research settings…', researchUnavailable: 'Research is not configured for this profile.',
  researchSaveFailed: 'Could not save the research model.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '内置插件',
  title: '内置插件',
  intro: '查看内置部署的插件列表',
  tabs: '插件视图',
  empty: '本部署没有开放任何插件视图。',
  researchTitle: '深度研究', researchDescription: '选择新研究任务使用的工作模型。',
  researchModel: '研究模型', researchHint: '现有任务继续使用原来的工作模型。',
  researchLoading: '正在加载研究设置…', researchUnavailable: '此配置未启用研究功能。',
  researchSaveFailed: '无法保存研究模型。',
}
