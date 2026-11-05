// lib/extras.js — 可以叠在桥上的插件
//
// 桥只负责调工具。要做有固定流程的任务，或者只想要某个现成功能，再装这里列的。
// 桥不依赖它们，只看 dsh-cli-flow 留下的全局表，判断装没装。
// published 为假表示还没发布：界面只说明情况，不给跑不通的安装命令，也不告诉模型。

const PACKS_KEY = Symbol.for('dsh-cli-flow.packs')

export const EXTRAS = [
  {
    name: 'dsh-cli-flow',
    title: { zh: '固定流程', en: 'Flows' },
    description: {
      zh: '做短剧、PPT、短视频、商品上架这类多步骤的工作：每一步选工具、比稿、随时导出。每次请求多约 400 token。',
      en: 'Multi-step work such as short dramas, slides, short videos and product listings: pick a tool for each step, compare results, export any time. Adds about 400 tokens per request.',
    },
    published: true,
  },
  {
    name: 'dsh-cli-flow-audio',
    title: { zh: '音频和字幕', en: 'Audio and subtitles' },
    description: {
      zh: '只想把文字变成配音和对应的字幕，装这一个就够。不再增加 token。',
      en: 'Turn text into a voiceover with matching subtitles. This is all you need for that, and it adds no further tokens.',
    },
    packId: 'audio',
    published: true,
  },
]

export function extrasStatus({ list = EXTRAS, scope = globalThis } = {}) {
  const packs = scope[PACKS_KEY]
  return list.map(({ packId, ...extra }) => ({
    ...extra,
    installed: packId ? Boolean(packs?.has?.(packId)) : Boolean(packs),
    command: extra.published ? `dsh plugin --profile desktop add ${extra.name}` : null,
  }))
}

/** 给模型看的：只有 cli_list 的结果里才带，平时不占 token */
export function extrasForModel(options) {
  const rows = extrasStatus(options).filter((extra) => extra.published && !extra.installed)
  return rows.map(({ name, title, command }) => ({ name, for: title.zh, command }))
}
