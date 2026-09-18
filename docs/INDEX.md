# DSH 适配中台 · 索引（一页找齐）

> 铁律：本表是**入口索引**，不是规则正文。正文有变 → 先改正文，再回来刷本表（防索引漂移）。

## 一、我要做什么 → 去哪

| 我的处境 | 去哪里 |
|---|---|
| 我想让我的插件适配 DSH（新旧版都要） | `docs/ADAPTER_GUIDE.md`（5 分钟接入） |
| 我想知道这中台怎么设计的 | `docs/ARCHITECTURE.md` |
| 我的验收失败了，不知道是谁的问题 | `docs/ADAPTER_GUIDE.md` §4「归因怎么读」 |
| 我想知道有哪些风险 | `docs/RISKS.md` |
| 我想改通道钉版（bump 上游版本） | `registry/channels.json` |
| 我想看上游有没有发新版 | `node src/cli.mjs watch` 或页面按钮「上游漂移侦测」 |
| 我想清理宿主依赖缓存（历史残留） | `node src/cli.mjs cache`（保留当前三通道指纹） |
| 契约基线什么时候会被改写 | 只在通道 `ok` 时更新该通道基线；失败运行**不覆盖**、不产生假漂移 |
| 我想手动跑一次双通道验收 | 页面按钮「双通道验收」或 `node src/cli.mjs verify --channel all --plugin ... --tools ...` |
| 我想加一个新的通道（如 beta） | 在 `registry/channels.json` 的 `channels` 加一项，其余全自动 |

## 二、产物索引

| 产物 | 位置 | 类型 | 说明 |
|---|---|---|---|
| 通道钉版表 | `registry/channels.json` | 机器可读 | ★ 唯一事实源：stable / dev / legacy |
| 契约指纹基线 | `registry/contract-snapshots/latest.json` | 机器可读 | 上游契约漂移对比基线 |
| 版本线探测 | `src/detect/flavor.mjs` | 代码 | `ptc`→modern / `code`→legacy / unknown 不抛错 |
| Schema 兼容 | `src/compat/schema.mjs` | 代码 | 压平 + 校验（与宿主同构） |
| 工具契约适配 | `src/compat/tool.mjs` | 代码 | 保留名护栏 / 默认 render / 取消语义 |
| 一站式适配器 | `src/adapter.mjs` | 代码 | 插件侧唯一 import 面 |
| 隔离宿主装配 | `src/harness/host.mjs` | 代码 | 真宿主 + 缓存 + 离线 |
| 验收探针 | `src/harness/probe-template.mjs` | 代码 | 17 项检查（临时目录内执行；错误分级 `fatal(host)` / 插件侧 check） |
| 契约指纹采集 | `src/harness/contract.mjs` | 代码 | 探测后**立即卸载**（可离线单测；防残留污染工具清单） |
| 双通道验收 | `src/verify/runner.mjs` | 代码 | 判决 + 归因 |
| 上游侦测 | `src/watch/upstream.mjs` | 代码 | dist-tag 漂移 + 契约 diff |
| 二级信息汇报 | `src/report/secondary.mjs` | 代码 | JSON + Markdown 双视图 |
| CLI | `src/cli.mjs` | 命令 | matrix / verify / watch / report / detect / cache |
| 接入模板 | `templates/adapter/` | 模板 | 拷贝即用 |
| 离线单测 | `tests/test_offline.sh` | 测试 | 59 项，无网可跑 |
| 归因离线回归 | `tests/test_attribution.mjs` | 测试 | 48 项：契约采集无残留 + 归因判据结构化 + 判据表完备性（无网可跑） |
| 归因端到端回归 | `tests/test_e2e_regression.mjs` | 测试 | 34 项：真宿主复现 🔴-A / 🔴-B 场景 |
| 双通道验收编排 | `tests/test_hub.sh` | 测试 | 真宿主全流程 |
| 发布面自检 | `tests/test_exports.mjs` | 测试 | exports 全解析 + 模板拷贝可用（16 项） |
| 示例插件 | `tests/fixtures/demo-plugin.mjs` | 测试 | 同时是接入模板 |
| 负例插件 | `tests/fixtures/broken-plugin.mjs` | 测试 | 验证护栏不静默失效 |
| CI 流水线 | `.cnb.yml` | 配置 | push/PR/crontab/web_trigger |
| 页面按钮 | `.cnb/web_trigger.yml` | 配置 | 人不用记命令 |

## 三、通道索引

| 通道 | 版本线 | npmTag | 钉版（dsh-tools） | 跑在哪 | 失败含义 |
|---|---|---|---|---|---|
| `stable` | 0.1.5 | `next` | `0.1.5-rc.2` | push / PR | 插件回归，必须修 |
| `dev` | 0.1.6 | `alpha` | `0.1.6-alpha.2` | push / PR | 归因：上游漂移 / 插件回归 |
| `legacy` | 0.1.1 | — | `0.1.1-rc.2` | PR + 周日 crontab | 为适配新版把旧版装崩 |

> `--channel all` = 三通道全跑（stable + dev + legacy），与页面按钮「三通道」同义。

## 四、17 项验收检查索引

| 检查名 | 验的是什么 |
|---|---|
| `host.tools_ready` | 宿主 ToolRuntime 就绪 |
| `detect.flavor_known` | 版本线可判定 |
| `contract.probe_disposed` | 契约探测采集后**已全部卸载**（无残留；残留即宿主 register 语义变了） |
| `guard.reserved_name` | 中台保留名护栏可用（run_code 被插件侧拒绝）**——中台自检，非插件违规** |
| `compat.schema_flatten` | schema 压平后无违规 |
| `plugin.loaded` | 插件导出 `apply(ctx)`（import 失败/未导出 → 插件侧失败，不是上游漂移） |
| `plugin.apply_ok` | 插件 `apply(ctx)` 执行成功（抛错 → 插件侧失败） |
| `registry.exact` | 注册工具清单精确匹配 |
| `dispatch.execute_ok` | 真实 dispatch 成功 |
| `dispatch.render_projected` | `output.render` 投影正确 |
| `dispatch.echo_payload` | 业务返回值正确 |
| `dispatch.abort_semantics` | `exec.signal` 取消语义生效 |
| `plugin.definitions_ok` | 插件导出可用的 `definitions` 数组 |
| `lifecycle.disposer_count` | disposer 数量正确 |
| `lifecycle.registered` | 独立上下文注册成功 |
| `lifecycle.dispose` | 卸载后无残留 |
| `guard.reserved_rejected` | 插件声明的保留名被拒绝并上报（声明即判失败，不静默丢弃）**——插件侧硬证据，优先于漂移相关性** |

> 顺序即探针实际执行顺序（`guard.reserved_rejected` 在**末尾**，依赖插件 `definitions()`）。
