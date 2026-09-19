# DSH 适配中台 · 索引（一页找齐）

> 铁律：本表是**入口索引**，不是规则正文。正文有变 → 先改正文，再回来刷本表（防索引漂移）。

## 一、我要做什么 → 去哪

| 我的处境 | 去哪里 |
|---|---|
| 我想让我的插件适配 DSH（新旧版都要） | `docs/ADAPTER_GUIDE.md`（5 分钟接入） |
| 我想知道这中台怎么设计的 | `docs/ARCHITECTURE.md` |
| 我的验收失败了，不知道是谁的问题 | `docs/ADAPTER_GUIDE.md` §4「归因怎么读」 |
| 我想知道有哪些风险 | `docs/RISKS.md` |
| 我想知道「报告凭什么可信」 | `docs/RISKS.md` **R26（架构前提：插件为可信代码）** + `docs/REDO-PROPOSAL.md`（结构性重做一页方案） |
| 我想改通道钉版（bump 上游版本） | `registry/channels.json` |
| 上游新增了一个契约字段，我想让它参与漂移归因 | `src/triage/index.mjs` 的 `DRIFT_IMPACT`（**唯一事实源**，只改这一处） |
| 我想看上游有没有发新版 | `node src/cli.mjs watch` 或页面按钮「上游漂移侦测」 |
| 上游发版后，我想知道「漂移到哪、影响谁、我该改哪一处」 | `node src/cli.mjs watch --markdown`（**影响面自动归因**：契约字段 → 受影响检查 → 中台改哪个文件 → 插件要不要动） |
| 我想清理宿主依赖缓存（历史残留） | `node src/cli.mjs cache`（保留当前三通道指纹） |
| 契约基线（遗留）什么时候会被改写 | **只有 `settle` 会写**（默认一天一个基线，10:00 结算）；`verify` 只读，push/PR 段不写。同周期取**相对早**的候选 |
| 基线为什么不是一个滚动的 `latest.json` | 旧语义每次运行都改写它 ⇒ 基线自己一直在动、累积偏移被静默吸收。现在按**周期分片**，`latest` 是链式合并的**派生**结果 |
| 我想手动结算一次基线 | `node src/cli.mjs settle --from ./.ci/verify.json`（`--dry-run` 只看不写） |
| 我想看当前基线链 / 迁遗留 | `node src/cli.mjs baseline`（`--migrate` 把历史遗留 `latest.json` 迁成分片） |
| 我想按上游版本（而不是按天）切基线 | `node src/cli.mjs settle --mode release --release dsh-tools@0.1.6-alpha.3 --from ...` |
| 我想手动跑一次双通道验收 | 页面按钮「双通道验收」或 `node src/cli.mjs verify --channel all --plugin ... --tools ...` |
| 我想加一个新的通道（如 beta） | 在 `registry/channels.json` 的 `channels` 加一项，其余全自动 |
| 我的验收失败了，但上游刚好在发版 | 先看 `attributionReasons`：命中「插件侧硬证据」就是你的问题，漂移不背锅 |

## 二、产物索引

| 产物 | 位置 | 类型 | 说明 |
|---|---|---|---|
| 通道钉版表 | `registry/channels.json` | 机器可读 | ★ 唯一事实源：stable / dev / legacy |
| 契约基线（遗留）分片 | `registry/contract-snapshots/segments/<周期>.json` | 机器可读 | ★ 每周期**独立**基线（一天一个 / 一版一个）；同周期取**最早**候选 |
| 契约基线（遗留）（派生） | `registry/contract-snapshots/latest.json` | 机器可读 | **历史遗留**（v0.3.0 起不再由 verify 写）；可由 `baseline --migrate` 迁成分片 |
| ★ 基线周期与链式合并 | `src/watch/baseline.mjs` | 代码 | 周期键（10:00 结算）/ `first-wins` / 分片存储 / **顺序链式合并**（早→晚） |
| 基线「分段 + 只读」守卫 | `tests/test_baseline_guard.mjs` | 测试 | B1 `verify` 只读 / B2 `settle` 唯一写入点 / B3 CI 接线 / B4 链式来源 / B5 结算语义 + 守卫自证 |
| 上游漂移影响面 | `src/triage/index.mjs` | 代码 | ★ 唯一事实源：漂移字段 → 受影响检查 → 责任方 → 中台改哪一处 |
| 版本线探测 | `src/detect/flavor.mjs` | 代码 | `ptc`→modern / `code`→legacy / unknown 不抛错 |
| Schema 兼容 | `src/compat/schema.mjs` | 代码 | 压平 + 校验（与宿主同构） |
| 工具契约适配 | `src/compat/tool.mjs` | 代码 | 保留名护栏 / 默认 render / 取消语义 |
| 一站式适配器 | `src/adapter.mjs` | 代码 | 插件侧唯一 import 面 |
| 隔离宿主装配 | `src/harness/host.mjs` | 代码 | 真宿主 + 缓存 + 离线 |
| 验收探针 | `src/harness/probe-template.mjs` | 代码 | 17 项检查 + **9 项条件检查**（临时目录内执行；**按相位**归因：宿主装配段信号落结构化 `hostFatal[]`，插件集成段一律落 check；**四条出口**逐条闭合——同步 `catch` / `uncaughtException`+`unhandledRejection` / `process.on('exit')`+信号 / **无条件**看门狗；**完成位** `runCompleted` 使「未跑完」绝不假绿；另打相位信标供不可捕获终止归因） |
| 契约指纹采集 | `src/harness/contract.mjs` | 代码 | 探测后**立即卸载**（可离线单测；防残留污染工具清单）；★ 归因判据表唯一事实源（`HOST_FATAL_FIELD` / 三张 check 表 / `PROBE_CHECK_ORDER` / `CONDITIONAL_PROBE_CHECKS` / 相位路由） |
| 双通道验收 | `src/verify/runner.mjs` | 代码 | 判决 + 归因（漂移相关性表**从 `triage` import**，不在此硬编码） |
| 上游侦测 | `src/watch/upstream.mjs` | 代码 | dist-tag 漂移 + 契约 diff |
| ★ 契约基线分段与链 | `src/watch/baseline.mjs` | 代码 | **唯一事实源**：周期键（`settleHour` 默认 10）/ `first-wins` / 分片 `segments/` / `composeChain()` 顺序合并 |
| ★ 漂移影响面归因 | `src/triage/index.mjs` | 代码 | **唯一事实源**：`DRIFT_IMPACT`（漂移字段 → 受影响检查 → 责任方 → 中台改哪一处 → 插件义务）+ `triageUpstream()` |
| 二级信息汇报 | `src/report/secondary.mjs` | 代码 | JSON + Markdown 双视图 |
| ★ 架构前提（信任边界） | `docs/RISKS.md` R26 | 文档 | **显式前提：插件为可信代码**；前提被打破 ⇒ 结论不可信（本中台是验收工具，不是沙箱） |
| 结构性重做一页方案 | `docs/REDO-PROPOSAL.md` | 文档 | 批 1（fd3 + nonce）**已落地** / 批 2（进程隔离）**已立项在办**（总师裁定；R29 证逐点补不可穷尽） |
| CLI | `src/cli.mjs` | 命令 | matrix / verify / watch（含影响面） / **settle（唯一写基线）** / **baseline（看链 + 迁移）** / report / detect / cache |
| 接入模板 | `templates/adapter/` | 模板 | 拷贝即用 |
| 离线单测 | `tests/test_offline.sh` | 测试 | 229 项，无网可跑（含 `summarize()` verdict 优先级 [13]、nonce 侧信道 [13]、🔴-D 相位化兜底（同步 + **异步**）、漂移相关性表唯一事实源 [14]、watch 影响面 [15]、**🔴 四条出口离线探针回归 + 🔴-A 无 nonce 不硬崩 [16]**、**🔴-1 占死事件循环有界返回 [17]**、**nonce 侧信道 + v0.1.9d 三形态 [18]**、**批 1.5 通道可见化/降级不放行/§3 反例/exit 台账 [19]**、**🔴 必修-4 同族假绿 [20]**、**🔴-R3′ 通道重定向 + 压退出码 [21]**、**🔴-R3③ 自报降级甩锅（宿主侧 fd3 能力实测）[21]**、**🔴-R3 宿主侧观测主判据 + §三 自报降级 [22]**、**契约基线分段：取最早 / 分片独立 / 顺序链式合并 / 迁移幂等 [23]**） |
| 归因离线回归 | `tests/test_attribution.mjs` | 测试 | 654 项：契约采集无残留 + 判据只读结构化字段 + 硬证据优先 + 🔴-D 相位路由（同步 [9] + **异步 [9.8]**）+ **🔴 四条出口 / 完成位 / 相位信标 [9.9]** + §四 反向护栏 + 判据表完备性 + ARCHITECTURE 判据表守卫 [7b] + 漂移相关性表唯一事实源 [7c] + triage 影响面 [9] + **[9.10]-[9.17] R28/R26/R24/🔴 必修-4/R26 残留② fail-open/🔴-R3′ 通道重定向/🔴-R3③ 自报降级甩锅/🔴-R3 宿主侧观测**（无网可跑） |
| 归因端到端回归 | `tests/test_e2e_regression.mjs` | 测试 | 191 项：真宿主复现 🔴-A / 🔴-B / 🔴-C / 🔴-D（漂移吞硬违规 + 自由文本翻案 + 插件侧**同步/异步**异常写进判据字段）+ **🔴 必修-2/3（进程 exit / `run()` 被拖住 / SIGKILL）** + **[8d]-[8i] 侧信道 / R28+R26 / R24 / §3 反例 / 🔴 必修-4 / 🔴-R3′ 通道重定向 / 🔴-R3③ 自报降级甩锅 / 🔴-R3 §三 自报降级** 场景，含 attribution + verdict + **完成位**三重断言 |
| 双通道验收编排 | `tests/test_hub.sh` | 测试 | 真宿主全流程（含第 4b 步插件侧闸门 / 第 7 步「文档计数防漂移」） |
| 插件侧闸门 | `tests/gate_plugin_side.sh` | 测试 | ★ 唯一事实源：四条出口 + SIGKILL 边界 + **§3 反例固化** + **exit 钩子台账** + **防过度修正**（健康插件 17/17）；`.cnb.yml` push/PR 两段共用同一份 |
| 离线探针回归台 | `tests/offline-probe-harness.mjs` | 测试 | 最小假宿主 + 真实探针子进程 + **装配器真实实现**解释输出（秒级覆盖四条出口；边界：假宿主通过 ≠ 真宿主适配通过） |
| 发布面自检 | `tests/test_exports.mjs` | 测试 | exports 全解析 + 模板拷贝可用 + 文档清单顺序/结构一致 + 文档版本一致 + **文档条件项计数 = `CONDITIONAL_PROBE_CHECKS` 长度** + 防线编号自述可检索 + **产物索引表完整性 [2d]**（51 项） |
| 示例插件 | `tests/fixtures/demo-plugin.mjs` | 测试 | 同时是接入模板 |
| 负例插件 | `tests/fixtures/broken-plugin.mjs` | 测试 | 验证护栏不静默失效（声明保留名 → 插件侧硬证据） |
| 负例插件（🔴-D 同步） | `tests/fixtures/plugin-side-throw-plugin.mjs` / `plugin-registry-throw-plugin.mjs` | 测试 | 插件侧**同步**异常（抛错 getter / 未初始化字段）→ `PLUGIN_REGRESSION` 且 `hostFatal=[]` |
| 负例插件（🔴-D 异步） | `tests/fixtures/plugin-async-throw-plugin.mjs` / `plugin-async-reject-plugin.mjs` | 测试 | 插件侧**异步**异常（后台微任务抛错 / 预取 promise 拒绝）→ `PLUGIN_REGRESSION` 且 `hostFatal=[]`、`checks` 不丢 |
| 负例插件（🔴 出口③④） | `tests/fixtures/plugin-exit-plugin.mjs` / `plugin-hang-plugin.mjs` | 测试 | 进程 `exit`（`process.exit(0)`）/ `run()` 被拖住（永不 resolve）→ `PLUGIN_REGRESSION`/RED、`hostFatal=[]`、`runCompleted=false` |
| 负例插件（🔴 边界） | `tests/fixtures/plugin-sigkill-plugin.mjs` | 测试 | **不可捕获**终止（`SIGKILL`）→ 按相位信标落 `plugin.abnormal_termination`、`hostFatal=[]` |
| 负例插件（H1/R28 防线干预） | `tests/fixtures/plugin-defense-tamper-plugin.mjs` | 测试 | 摘掉探针 handler 后装**自己的**（计数判据假阳性形态）→ `plugin.process_defense_tampered`、`hostFatal=[]` |
| 负例插件（R24 同步死循环） | `tests/fixtures/plugin-sync-loop-plugin.mjs` | 测试 | `apply()` 内**同步**死循环（3s）→ 宿主 `killSignal:'SIGKILL'` 二次终止收口，`plugin.abnormal_termination`（信标）/ `hostFatal=[]` |
| 负例插件（🆕 侧信道） | `tests/fixtures/plugin-forged-result-plugin.mjs` / `plugin-event-loop-hog-plugin.mjs` | 测试 | 伪造裸 marker 绿卡 → `plugin.probe_result_forged`；永久占死事件循环 → timeoutMs **有界**（SIGKILL） |
| 负例插件（🆕 🔴-R3′ 通道重定向） | `tests/fixtures/plugin-channel-redirect-plugin.mjs` | 测试 | `closeSync(3)` + `openSync(<file>)` 把 **fd3 换成文件** ⇒ 从探针写进文件的**真报告**里抄 nonce 前缀 ⇒ 把绿卡写进 stdout + 压 `process.exitCode = 0`（旧实现 **GREEN 放行**）→ 现判 `plugin.protocol_injection`（**宿主侧通道观测**）、不采信任何一条、**不得** GREEN |
| 负例插件（🆕 §3 反例固化） | `tests/fixtures/plugin-host-tamper-poc-plugin.mjs` | 测试 | 反读 nonce + 写 fd3 绿卡 + 摘 `exit` 钩子 + `exit(0)` 抢跑（原始 PoC 曾判 GREEN）→ 现判 `plugin.probe_result_forged` + `plugin.abnormal_termination`、**不得** GREEN |
| 负例插件（🆕 批 1.5 出口钩子） | `tests/fixtures/plugin-exit-hook-tamper-plugin.mjs` | 测试 | **只摘**出口③ 的 `exit` 钩子（其余健康）→ `plugin.process_defense_tampered`、`hostFatal=[]`（原先**不可判定**） |
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

**另有 9 项条件检查**（不计入上表 17 项，仅在异常路径出现；唯一事实源 = `src/harness/contract.mjs` 的 `CONDITIONAL_PROBE_CHECKS`）：

| 条件检查 | 出口 | 触发场景 |
|---|---|---|
| `plugin.unexpected_exception` | ① 同步 | 探针读插件侧数据时**同步**抛错（逃到顶层 `catch`） |
| `plugin.async_uncaught_exception` | ② 异步 | 插件在 `apply()` 里排的后台任务**异步**抛错（不在探针调用栈上，由进程级兜底接住） |
| `plugin.early_exit` | ③ 进程 exit | 插件在验收完成前调 `process.exit()` / 自杀式信号（`process.on('exit')` 钩子接住） |
| `plugin.run_incomplete` | ④ `run()` 被拖住 | 插件挂住事件循环 / `apply()` 返回永不 resolve 的 Promise（**无条件**看门狗接住） |
| `plugin.abnormal_termination` | 边界 | **不可捕获**终止（`SIGKILL` / OOM）——探针来不及写报告，装配器按**相位信标**归因 |
| `plugin.process_defense_tampered` | ⑤ 防线被静音 / 出口钩子被摘 | 插件抢占 `setUncaughtExceptionCaptureCallback`（Sentry / APM / 日志库常见）、`removeAllListeners`，或**摘掉出口③ 的 `exit` 钩子**（批 1.5：钩子具名登记 + 身份检查覆盖 `'exit'`）⇒ 探针进程级兜底被**静音** / 提前退出的记账能力被撤销 → 探针收尾自检判本项（**防放行级假绿**） |
| `plugin.protocol_injection` | ⑥ 结果通道被注入 / 被关闭 / **被重定向** | 插件向探针的结果通道**注入伪造结果**（抢首位 / 多结果行 / 走错通道）；**在插件代码运行期间关闭 fd3**（早探测可写 → 收尾不可写）；或**把 fd3 换成普通文件**（`closeSync(3)` + `openSync(<file>)`）后用从真报告抄到的 nonce 前缀把绿卡写进 stdout（🔴-R3′：报告**自称**走 fd3 而**宿主侧该通道无内容** ⇒ **宿主侧通道观测**命中）⇒ 真报告被顶替 / 降级 → 装配器 `interpretProbeStdout()` 判本项（**防放行级假绿**） |
| `plugin.probe_result_forged` | 🆕 侧信道 | 探针输出面出现**无 nonce / nonce 不匹配**的结构化结果行（插件自造绿卡 / 甩锅上游）⇒ 装配器只认带 nonce 的报告，伪造即判本项（与 ⑥ 是**两条独立证据链**） |
| `plugin.exit_code_mismatch` | 🔴 必修-4 退出码交叉 | 报告自称通过（`ok=true`）但探针**进程退出码非 0**（或带终止信号）⇒ **两个独立产物互相矛盾**即篡改（退出码由探针内存算出、不经序列化；报告字节可被插件的 `JSON.stringify` 替换）⇒ 装配器判本项（**防放行级假绿**） |

> 本表项数由 `tests/test_exports.mjs` 断言与 `CONDITIONAL_PROBE_CHECKS.length` 相等（改一处漏一处即红）。
> 「17 项 ∪ 条件项 == 三张 check 表并集」与「`PROBE_CHECK_ORDER` == 探针实际输出顺序」由
> `tests/test_attribution.mjs` [9.8e] 守住；四条出口 + **完成位**由 [9.9] 守住（漂移即红）。
