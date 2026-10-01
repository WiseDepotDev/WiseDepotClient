# spike/ 只剩证据数据

V1 期这里放过一整套一次性验证脚手架（Naive 主题覆盖、虚拟滚动、打包体积探针，以及它们的
CDP 驱动与运行脚本）。**代码已于 V6 删除** —— 它们依赖的 `naive-ui` 与 React 都不在树上了，
留着一堆跑不起来的代码只会让人以为它还能用。

留下的三个 JSON 是**当时真跑出来的结果**，被
`docs/superpowers/plans/2026-10-02-v1-spikes.md` 直接引用：

| 文件 | 证明了什么 |
| --- | --- |
| `results/spike-a-ssr.json` | 主题覆盖必须连 `*Inverted` 键一起给，否则侧栏深色不生效 |
| `results/spike-b-virtual-scroll.json` | 1000 行 → 22 个 DOM 行，p50/p95 = 16.7/16.8ms |
| `results/spike-c-bundle.json` | 各方案的首屏体积（选型依据） |

它们**是数据，不是代码**，所以留着；也正因为留着，任何"当初为什么这么选"的追问都能被复核。

> 顺带：浏览器冒烟用的 CDP 客户端**不是** spike 遗留，已移到 `apps/web/smoke/lib/cdp.mjs`
> （它唯一的消费者就是那份冒烟脚本）。
