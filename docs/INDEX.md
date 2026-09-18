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
| 上游新增了一个契约字段，我想让它参与漂移归因 | `src/triage/index.mjs` 的 `DRIFT_IMPACT`（**唯一事实源**，只改这一处） |
| 我想看上游有没有发新版 | `node src/cli.mjs watch` 或页面按钮「上游漂移侦测」 |
| 上游发版后，我想知道「漂移到哪、影响谁、我该改哪一处」 | `node src/cli.mjs watch --markdown`（**影响面自动归因**：契约字段 → 受影响检查 → 中台改哪个文件 → 插件要不要动） |
| 我想清理宿主依赖缓存（历史残留） | `node src/cli.mjs cache`（保留当前三通道指纹） |
| 契约基线什么时候会被改写 | 只在通道 `ok` 时更新该通道基线；失败运行**不覆盖**、不产生假漂移 |
| 我想手动跑一次双通道验收 | 页面按钮「双通道验收」或 `node src/cli.mjs verify --channel all --plugin ... --tools ...` |
| 我想加一个新的通道（如 beta） | 在 `registry/channels.json` 的 `channels` 加一项，其余全自动 |
| 我的验收失败了，但上游刚好在发版 | 先看 `attributionReasons`：命中「插件侧硬证据」就是你的问题，漂移不背锅 |

## 二、产物索引

| 产物 | 位置 | 类型 | 说明 |
|---|---|---|---|
| 通道钉版表 | `registry/channels.json` | 机器可读 | ★ 唯一事实源：stable / dev / legacy |
| 契约指纹基线 | `registry/contract-snapshots/latest.json` | 机器可读 | 上游契约漂移对比基线 |
| 上游漂移影响面 | `src/triage/index.mjs` | 代码 | ★ 唯一事实源：漂移字段 → 受影响检查 → 责任方 → 中台改哪一处 |
| 版本线探测 | `src/detect/flavor.mjs` | 代码 | `ptc`→modern / `code`→legacy / unknown 不抛错 |
| Schema 兼容 | `src/compat/schema.mjs` | 代码 | 压平 + 校验（与宿主同构） |
| 工具契约适配 | `src/compat/tool.mjs` | 代码 | 保留名护栏 / 默认 render / 取消语义 |
| 一站式适配器 | `src/adapter.mjs` | 代码 | 插件侧唯一 import 面 |
| 隔离宿主装配 | `src/harness/host.mjs` | 代码 | 真宿主 + 缓存 + 离线 |
| 验收探针 | `src/harness/probe-template.mjs` | 代码 | 17 项检查 + 3 项条件检查（临时目录内执行；**按相位**归因：宿主装配段信号落结构化 `hostFatal[]`，插件集成段一律落 check；另挂 `uncaughtException` / `unhandledRejection` 进程级兜底 + **保持 ref** 的看门狗，插件侧**异步**异常也不进判据字段；每次切相位把相位**落盘**到侧信道 `probe-phase.txt`，供装配器在探针被杀时归因） |
| 契约指纹采集 | `src/harness/contract.mjs` | 代码 | 探测后**立即卸载**（可离线单测；防残留污染工具清单）；★ 归因判据表唯一事实源（`HOST_FATAL_FIELD` / 三张 check 表 / `PROBE_CHECK_ORDER` / `CONDITIONAL_PROBE_CHECKS` / 相位路由） |
| 双通道验收 | `src/verify/runner.mjs` | 代码 | 判决 + 归因（漂移相关性表**从 `triage` import**，不在此硬编码） |
| 上游侦测 | `src/watch/upstream.mjs` | 代码 | dist-tag 漂移 + 契约 diff |
| ★ 漂移影响面归因 | `src/triage/index.mjs` | 代码 | **唯一事实源**：`DRIFT_IMPACT`（漂移字段 → 受影响检查 → 责任方 → 中台改哪一处 → 插件义务）+ `triageUpstream()` |
| 二级信息汇报 | `src/report/secondary.mjs` | 代码 | JSON + Markdown 双视图 |
| CLI | `src/cli.mjs` | 命令 | matrix / verify / watch（含影响面） / report / detect / cache |
| 接入模板 | `templates/adapter/` | 模板 | 拷贝即用 |
| 离线单测 | `tests/test_offline.sh` | 测试 | 95 项，无网可跑（含 `summarize()` verdict 优先级 [13]、🔴-D 相位化兜底（同步 + **异步**）+ 🔴-D′ 装配器侧带外相位分流、漂移相关性表唯一事实源 [14]、watch 影响面 [15]） |
| 归因离线回归 | `tests/test_attribution.mjs` | 测试 | 236 项：契约采集无残留 + 判据只读结构化字段 + 硬证据优先 + 🔴-D 相位路由（同步 [9] + **异步 [9.8]**）+ 🔴-D′ 看门狗能红守卫 [9.8g] / 装配器侧带外相位分流源码守卫 [9.8h] + 🟡-3 兜底区切片守卫 + §四 反向护栏 + 判据表完备性 + ARCHITECTURE 判据表守卫 [7b] + 漂移相关性表唯一事实源 [7c] + triage 影响面 [9]（无网可跑） |
| 归因端到端回归 | `tests/test_e2e_regression.mjs` | 测试 | 144 项：真宿主复现 🔴-A / 🔴-B / 🔴-C / 🔴-D / **🔴-D′**（漂移吞硬违规 + 自由文本翻案 + 插件侧**同步/异步**异常写进判据字段 + **探针被插件杀掉**）场景，含 attribution + verdict 双断言 |
| 双通道验收编排 | `tests/test_hub.sh` | 测试 | 真宿主全流程（含第 7 步「文档计数防漂移」） |
| 发布面自检 | `tests/test_exports.mjs` | 测试 | exports 全解析 + 模板拷贝可用 + 文档清单顺序/结构一致 + 文档版本一致 + 防线编号自述可检索 + **「另有 N 项条件检查」N 由唯一事实源反推**（36 项） |
| 示例插件 | `tests/fixtures/demo-plugin.mjs` | 测试 | 同时是接入模板 |
| 负例插件 | `tests/fixtures/broken-plugin.mjs` | 测试 | 验证护栏不静默失效（声明保留名 → 插件侧硬证据） |
| 负例插件（🔴-D 同步） | `tests/fixtures/plugin-side-throw-plugin.mjs` / `plugin-registry-throw-plugin.mjs` | 测试 | 插件侧**同步**异常（抛错 getter / 未初始化字段）→ `PLUGIN_REGRESSION` 且 `hostFatal=[]` |
| 负例插件（🔴-D 异步） | `tests/fixtures/plugin-async-throw-plugin.mjs` / `plugin-async-reject-plugin.mjs` | 测试 | 插件侧**异步**异常（后台微任务抛错 / 预取 promise 拒绝）→ `PLUGIN_REGRESSION` 且 `hostFatal=[]`、`checks` 不丢 |
| 负例插件（🔴-D′ 探针被杀） | `tests/fixtures/plugin-hang-plugin.mjs` / `plugin-process-exit-plugin.mjs` / `plugin-detach-handlers-plugin.mjs` / `plugin-busy-loop-plugin.mjs` | 测试 | 探针被插件**杀掉**（挂起 / `process.exit` / 摘处理器 / 占死事件循环）→ 探针内兜底全失效，由**装配器**读带外侧信道相位（`probe-phase.txt`）归因：`PLUGIN_REGRESSION` / `hostFatal=[]` / 17 项按序补 `skip` |
| 🔴-D / 🔴-D′ 闸门 | `tests/gate_plugin_side.mjs` | 测试 | 8 份夹具 × 6 条断言（归因 / `hostFatal` 为空 / verdict≠AMBER / 17 项不缺 / 失败项全在插件侧 / 期望失败项出现）——push 与 PR 段**共用同一脚本**，口径只有一处 |
| CI 流水线 | `.cnb.yml` | 配置 | push/PR/crontab/web_trigger |
| 页面按钮 | `.cnb/web_trigger.yml` | 配置 | 人不用记命令 |

## 三、通道索引

| 通道 | 版本线 | npmTag | 钉版（dsh-tools） | 跑在哪 | 失败含义 |
|---|---|---|---|---|---|
| `stable` | 0.1.5 | `next` | `0.1.5-rc.2` | push / PR | 插件回归，必须修 |
| `dev` | 0.1.6 | `alpha` | `0.1.6-alpha.2` | push / PR | 归因：上游漂移 / 插件回归 |
| `legacy` | 0.1.1 | — | `0.1.1-rc.2` | PR + 周日 crontab | 为适配新版把旧版装崩 |

> `--channel all` = 三通道全跑（stable + dev + legacy），与页面按钮「三通道」同义。

## 四、17 项验收检查索引（按探针实际输出顺序）

| # | 检查名 | 验的是什么 |
|---|---|---|
| 1 | `host.tools_ready` | 宿主 ToolRuntime 就绪 |
| 2 | `detect.flavor_known` | 版本线可判定 |
| 3 | `contract.probe_disposed` | 契约探测采集后**已全部卸载**（无残留；残留即宿主 register 语义变了） |
| 4 | `guard.reserved_name` | 中台保留名护栏可用（run_code 被插件侧拒绝）**——中台自检，非插件违规** |
| 5 | `compat.schema_flatten` | schema 压平后无违规 |
| 6 | `plugin.loaded` | 插件导出 `apply(ctx)`（import 失败/未导出 → 插件侧失败，不是上游漂移） |
| 7 | `plugin.apply_ok` | 插件 `apply(ctx)` 执行成功（抛错 → 插件侧失败） |
| 8 | `registry.exact` | 注册工具清单精确匹配 |
| 9 | `dispatch.execute_ok` | 真实 dispatch 成功 |
| 10 | `dispatch.render_projected` | `output.render` 投影正确 |
| 11 | `dispatch.echo_payload` | 业务返回值正确 |
| 12 | `dispatch.abort_semantics` | `exec.signal` 取消语义生效 |
| 13 | `plugin.definitions_ok` | 插件导出可用的 `definitions` 数组 |
| 14 | `lifecycle.disposer_count` | disposer 数量正确 |
| 15 | `lifecycle.registered` | 独立上下文注册成功 |
| 16 | `lifecycle.dispose` | 卸载后无残留 |
| 17 | `guard.reserved_rejected` | 插件声明的保留名被拒绝并上报（声明即判失败，不静默丢弃）**——插件侧硬证据，优先于漂移相关性** |

> 序号 = **探针实际输出顺序**（`guard.reserved_rejected` 在**末尾**，依赖插件 `definitions()`）。
> 本清单顺序由 `tests/test_exports.mjs` [2b] 守住：与探针 `check()` 调用顺序不一致即红。

**另有 3 项条件检查**（不计入上表 17 项，仅在异常路径出现；唯一事实源 = `src/harness/contract.mjs` 的 `CONDITIONAL_PROBE_CHECKS`）：

| 条件检查 | 触发场景 |
|---|---|
| `plugin.unexpected_exception` | 探针读插件侧数据时**同步**抛错（逃到顶层 `catch`） |
| `plugin.async_uncaught_exception` | 插件在 `apply()` 里排的后台任务**异步**抛错（不在探针调用栈上，由进程级兜底接住） |
| `plugin.probe_aborted` | **探针被插件杀掉**（挂起 / `process.exit` / 摘掉进程级处理器 / 占死事件循环）→ 探针内兜底来不及跑，由**装配器**读带外侧信道相位（`probe-phase.txt`）归因 |

> 「17 项 ∪ 条件项 == 三张 check 表并集」与「`PROBE_CHECK_ORDER` == 探针实际输出顺序」由
> `tests/test_attribution.mjs` [9.8e] 守住（漂移即红）。
> 「另有 N 项」的 N 由 `tests/test_exports.mjs` [2b'''] 按 `CONDITIONAL_PROBE_CHECKS.length`
> 反推并与本文断言一致（改文档不改代码、或反之，都即红）。
