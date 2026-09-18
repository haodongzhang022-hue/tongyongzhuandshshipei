# 风险清单（DSH 适配中台）

> 纪律：**风险显式暴露 + 给规避方案 + 标注触发条件**；不确定的一律标风险，绝不默认「应该没问题」。
> 承担风险的是人，所以每条都写清「什么时候会爆、爆了怎么办」。

| # | 等级 | 风险 | 触发条件 | 影响 | 规避方案 | 兜底 |
|---|---|---|---|---|---|---|
| R1 | **HIGH** | 上游 alpha 线出现**破坏性变更**，双通道同时红 | `dsh-tools` alpha 发新版且改了注册契约 | 所有接入插件无法加载 | 中台兼容层按契约指纹 diff 定向修；插件侧零改动 | `dev` 失败归因 `UPSTREAM_DRIFT`，不误伤插件；`stable` 通道仍绿即业务可用 |
| R2 | **HIGH** | 跨仓授权不足，其他仓库拉不到中台 | 中台仓库私有 / 未声明 `allow_slugs` | 接入方 CI 拉不到 hub | 中台保持 Public；模板文件声明 `allow_slugs: "dongdongxiaozu/**"` | 退化为 `git clone` 直取（本指南默认写法） |
| R3 | **MEDIUM** | 钉版表过期，验收跑在旧宿主上「假绿」 | 上游发版但无人 bump pins | 以为适配好了，实际新版已崩 | crontab 每日扫 dist-tag（退出码 1 显式可见）+ 契约指纹 diff | `watch` 报告写入 `.ci/watch.json` 留痕 |
| R4 | **MEDIUM** | 真宿主验收需要网络装包，离线/内网失败 | CI 无外网 / npm 不可达 | 验收无法执行（非插件问题） | 宿主依赖缓存目录 `$TMPDIR/dsh-adapt-host-cache`；`--offline` 模式 | `verify` 归因 `UPSTREAM_DRIFT` 并附「离线缺缓存」原因，不静默通过 |
| R5 | **MEDIUM** | `latest` dist-tag 是历史残留，误当稳定线 | 直接读 `dist-tags.latest` | 把 0.0.1 当稳定版验收，结论错 | 通道显式声明 `npmTag`（stable→`next`）+ `line` 双约束 | `watch` 对比钉版与 tag，不一致即报警 |
| R6 | **MEDIUM** | 额度消耗：每通道一次真宿主安装 | 每次 push/PR 跑多通道 | 构建额度上升 | legacy 走 crontab 周检；stable+dev 走 push/PR；依赖缓存复用 | 本地 `--offline` 复跑不消耗额度 |
| R7 | **LOW** | 归因误判（把插件 bug 报成上游漂移） | 失败措辞同时命中多类关键词 | 修复责任被推给中台 | 归因策略保守（宁可报漂移让人确认）；报告含原始 `errors` 全文 | 人可依 `failedChecks[].detail` 人工改判 |
| R8 | **LOW** | 版本线探测失配（上游改 `Config` 形状） | 上游重构 `tools.Config` | 探测返回 `unknown` | 三级兜底：Config 投影 → 保留名措辞 → `unknown`（**不抛错、不阻断加载**） | `unknown` 走兼容路径，插件仍可加载 |
| R9 | **LOW** | Schema 子集收窄 | 上游新增/收紧 keyword 白名单 | 部分 schema 被拒 | `normalizeSchema` 白名单化 + 注册前 `issues` 上报 | 违规清单进报告，不静默丢字段 |
| R10 | **LOW** | 同层重复注册同名工具 | 插件多次 `apply` | `is already registered` 抛错 | `adapter.disposeAll()` / 独立 `Context` | 探针含 `lifecycle.*` 检查，CI 可发现 |

## 待人类拍板项（不拍板则按现状执行）

| 项 | 现状 | 建议 | 影响面 |
|---|---|---|---|
| 稳定线基准取 `next`（0.1.5-rc.2）而非 `latest`（0.0.1-rc.1 残留） | 已按 `next` 执行 | 确认 | 验收结论正确性 |
| legacy（0.1.1 线）通道是否长期保留 | 保留（周检） | 若官方确认弃用则改为「冻结不跑」 | 构建额度 |
| 是否发布 npm 包 `@dongdongxiaozu/dsh-adapt-hub` | 未发布（用 `git clone` 接入） | CP2 后决定 | 接入便捷性 |
| 是否开「组织级跨仓操作」做批量体检 N 个插件 | 未开 | CP2 后决定 | 授权范围 |
