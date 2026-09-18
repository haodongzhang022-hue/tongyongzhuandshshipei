# 变更记录（dsh-adapt-hub）

## v0.1.9 — 🔴-D′ 同族活口·第二轮：装配器侧**带外相位信号**分流 + 删看门狗 `unref` + 🟡 四项收口

> 承接 v0.1.8。评审 @ `c8965b9` 判**不放行**：同步路径与两份夹具「真的修对了」（评审独立复现
> A/B：父提交 + `plugin-async-throw` → `UPSTREAM_DRIFT`/`checks=0`；`c8965b9` 同夹具 →
> `PLUGIN_REGRESSION`/`hostFatal=[]`/`checks=18`），但**清零口径未达成**——同族活口从
> 「异步异常处理器」搬到了**「探针未输出结构化结果」分支**：`src/harness/host.mjs` 仍**无条件**
> `pushHostFatal()`，只要探针没吐出 `__DSH_PROBE__`，无论死在哪个相位，插件侧 bug 一律被写成宿主信号。

### 🔴 必修（同族活口·第二轮：探针被杀）

| # | 问题（评审实测，四条插件可造成的路径） | 修复 | 回归防线 |
|---|---|---|---|
| 🔴-D′-a | **`apply()` 返回永不 settle 的 promise + 后台任务抛错** → `UPSTREAM_DRIFT` / `hostFatal` 非空 / `checks=0` / `probeExit.status=13`。**根因是一行**：`probe-template.mjs` 的 `watchdog.unref?.()`——`run()` 被挂住时事件循环已空 → Node 以「unsettled top-level await」退出（exit 13），**unref 的看门狗永不触发**（注释里「看门狗兜住 `run()` 被拖住」这条声明，在它被写出来的那个场景里**不可达**）；且全仓 `watchdog|unref|ASYNC_WATCHDOG` 在 `tests/` 与 `.cnb.yml` **0 命中**（声明无防线 = 下一轮必被搬回来） | **删掉 `watchdog.unref?.()`**（定时器保持 ref → run() 被拖住时 10s 后强制收尾并输出结构化结果）；并在原处写明「绝不可 unref」的理由与防线编号 | 源码级 `test_attribution.mjs` [9.8g]（**能红**：把 `watchdog.unref?.()` 写回即红；附守卫自证 + 注释不误报反证 + 「看门狗存在且窗口为正」）；行为级 `test_e2e_regression.mjs` [8c]（挂起夹具的失败项必须是**探针侧** `plugin.async_uncaught_exception`，若 unref 写回则变成装配器兜底 `plugin.probe_aborted` → 红）+ 闸门同款断言 |
| 🔴-D′-b | **插件后台任务 `process.exit(0)`** → 同族误判（探针当场消失，探针内处理器来不及跑） | 见下「带外相位信号」 | 真宿主 [8c] + 闸门 `tests/gate_plugin_side.mjs`（`plugin-process-exit-plugin.mjs`） |
| 🔴-D′-c | **插件 `removeAllListeners('uncaughtException'/'unhandledRejection')` 后再抛** → 同族误判（**针对性摘除**：探针兜底只在它自己还挂着时有效） | 同上 | 真宿主 [8c] + 闸门（`plugin-detach-handlers-plugin.mjs`） |
| 🔴-D′-d | **后台任务占死事件循环** → 只能等外层 timeout，仍 `UPSTREAM_DRIFT` / `checks=0` | 同上 | 真宿主 [8c] + 闸门（`plugin-busy-loop-plugin.mjs`） |

**统一修法（评审原型已验证可行，本轮落地）**：探针侧两条兜底（进程级 handler / 看门狗）**都跑在探针进程内**——
插件能把探针整个弄死，那时探针内的任何处理器都救不了自己，「异常归属」也随之丢失。故改用**带外信号**：

1. **探针每次切相位把相位落盘**（`writeFileSync('probe-phase.txt', phase)`，失败静默）——探针被杀也不影响**已经写下**的相位；
2. **装配器读侧信道分流**（`host.mjs` 的「marker 缺失」分支）：侧信道 = `plugin-integration` →
   落**插件侧 check** `plugin.probe_aborted`（登记进 `PLUGIN_SIDE_CHECKS` + `CONDITIONAL_PROBE_CHECKS`），
   **绝不**写 `hostFatal[]`；其余（含读不到侧信道 / `host-assembly`）→ 保持 `pushHostFatal()`（**真漂移不得被收窄**）；
3. **报告不丢**：探针被杀时 `checks` 会从 17 掉到 0——装配器按 `PROBE_CHECK_ORDER` 补 17 条 `skip`
   （**只补 skip**：装配器没有资格替探针宣布 pass/fail），报告形态与「探针正常跑完但全挂」一致；
4. 归属路由唯一事实源：`contract.mjs` 的 `probeAbortRoute()` / `recordProbeAbort()` / `skipPendingProbeChecks()`；
5. **跑探针前先删侧信道文件**（`rmSync`）：`workDir` 路径含 channel + 指纹 + pid，同进程重复跑同一通道会复用目录——
   遗留的 `probe-phase.txt`（写着 `plugin-integration`）会让**这一次**的「探针没起来」被误判成插件侧
   （真漂移被收窄）。删掉后语义干净：读不到 = 本次探针没写下 = 按宿主侧保守处理。

**顺手发现并修的同类报告漏洞**：探针第 10 段（生命周期）的 `catch` 只标了 `lifecycle.registered` / `lifecycle.dispose`，
而 `lifecycle.disposer_count` 的 `check()` 在抛错点**之前** → 报告里少一项（17 → 16，人分不清「没验」与「验过了」）。
现改为 `skipAll([...])` 补全三项（新增闸门的「17 项一项不缺」断言把它抓了出来）。

### 🟡 建议（同批修）

| # | 问题（评审实测） | 处置 |
|---|---|---|
| 🟡-3 | **`[9.4]` 源码守卫有切片盲区**：从 `try {\n  await run();` 起切 → **兜底处理器区域不在视野内**。评审用「保留 `recordProbeAsyncException` 诱饵 + 另加一行 `pushHostFatal`」变异，源码守卫**漏检**（行为级 E2E 抓到 → 主防线仍在，故列 🟡） | **已修**：切片起点上移到兜底区段标记（`// ---- 进程级兜底`），覆盖「进程级 handler + 顶层 catch + finish」整块崩溃路径；补守卫自证（诱饵形态 / 别名 / 模板插值）与**反证**（把同一变异喂给旧切片 → 确认漏检、喂给新切片 → 确认抓到）；段标记本身也有断言（改名即红） |
| 🟡-4 | **文档口径未同步**：`contract.mjs` 的 JSDoc 仍写「`docs/ADAPTER_GUIDE.md`『另有 1 项条件检查』」——`docs/` 已改「2 项」；且「另有 N 项」这句**无守卫**（`tests/` 搜「另有」0 命中），与 🟡-2 同族 | **已修**：① JSDoc 不再写死 N；② 新增 `test_exports.mjs` **[2b''']**：把 N 从**唯一事实源**（`CONDITIONAL_PROBE_CHECKS.length`）反推，两份文档必须一致，且每条条件检查名都要在文档表里出现；附守卫自证（N 改字即红 / 名单缺一项即红 / 未变异文档不缺项）。本轮 N 由 2 → 3（新增 `plugin.probe_aborted`），守卫已自动生效 |
| 🟡-5 | **夹具噪音失败与自述不符**：两份异步夹具的 `healthy` 工具用 `render: () => []` → 额外 2 条失败（`dispatch.render_projected` / `dispatch.echo_payload`），注释却写「把失败点**精确**留在后台任务」；`test_e2e` 用 `pass>=10` 掩盖了这一点。旧同步夹具同写法（遗留） | **已修**：4 份夹具（`plugin-async-throw` / `plugin-async-reject` / `plugin-side-throw` / `plugin-registry-throw`）改为**真实 render**（走中台默认投影 `defaultRender`；`plugin-registry-throw` 直接调宿主 `ctx.tools.register()`、无兜底，故显式给 `render`）。修后失败点**精确**：异步两例仅 `plugin.async_uncaught_exception` 一条 fail、pass 17 条（原 15 pass + 2 条噪音 fail）；`test_e2e` 的 `pass>=10` 阈值一并收紧为**逐项声明期望失败项**（见闸门） |
| 🟡-6 | **`probeAsyncFailureRoute` 是 `probeFailureRoute` 的薄包装**，两处语义靠注释保证一致 | **已修**：`probeFailureRoute(phase, check = PLUGIN_PROBE_EXCEPTION_CHECK)` 带落点名，`probeAsyncFailureRoute` 改为**调用同一路由**并只传落点名——「相位 → 归属」只有一处可写错；不变量由 [9.8a] 对三个相位逐一断言等价 |

### 🟢 优化（同批顺手）

- 闸门从 `.cnb.yml` 的两段 inline `node -e`（push 段与 PR 段**各抄一份**）收敛为**单一脚本**
  `tests/gate_plugin_side.mjs`：夹具清单与断言口径只有一处，防两段漂移后其中一处静默失效。
  覆盖 8 份夹具 × 6 条断言（归因 / `hostFatal` 为空 / verdict≠AMBER / **17 项一项不缺** /
  失败项全在 `PLUGIN_SIDE_CHECKS` 内 / 期望失败项确实出现）。
- 报告新增 `probeSideChannelPhase`（侧信道相位）：与 `probePhase` 并列透出，排障时可比对
  「结构化相位 vs 侧信道相位」——不一致即说明探针在切相位后被中断。

### 兼容性

- 探针输出 / 验收报告**新增**：条件检查项 `plugin.probe_aborted`（仅在「探针被插件杀掉」路径出现，不计入 17 项）、
  报告字段 `probeSideChannelPhase`、装配器结果字段 `sideChannelPhase`。
- `contract.mjs` 新增导出：`PLUGIN_PROBE_ABORTED_CHECK` / `PROBE_PHASE_FILE` / `probeAbortRoute()` /
  `recordProbeAbort()` / `skipPendingProbeChecks()`；`probeFailureRoute()` 增加可选第二参数（默认值保持原语义，向后兼容）。
- **语义收窄（同 🔴-D / 🔴-D′ 口径）**：探针死在**插件集成相位**时不再进 `hostFatal[]`；`host-assembly` 相位与
  「读不到侧信道」保持原样（真漂移仍判 `UPSTREAM_DRIFT`）。

### 与并行尝试的差异（同族活口，两条实现并存过）

本轮期间远端另有一条**并行尝试**（`0484292` / `0b06398`，同一失效族、同一角色）。两条实现
覆盖的形态不同，已按「并集」合并，但**主干取本实现**——理由是实测，不是偏好：

| 形态 | 并行尝试（探针**进程边界**守卫） | 本实现（装配器读**带外相位**） |
|---|---|---|
| (a) `apply()` 永不 settle + 后台抛错 | ✅ 插件侧 check | ✅ 插件侧 check（看门狗保持 ref 后如期收尾） |
| (b) 后台任务 `process.exit()` | ✅ `plugin.early_exit` | ✅ `plugin.probe_aborted` |
| (c) 先摘掉进程级处理器再抛错 | ❌ **仍 `hostFatal` 非空 / `checks=0`**（守卫被插件摘掉） | ✅ `plugin.probe_aborted` |
| (d) 后台任务**占死事件循环** | ❌ **看门狗同样排不上** → 仍 `hostFatal` 非空 / `checks=0` | ✅ 占死结束后收尾 / 带外相位归因 |

结论（与评审口径一致）：**探针内的任何兜底都救不了「探针被杀」**——(c)(d) 两类形态下守卫、
看门狗、`writeSync` 全部失效，唯一还活着的是**落盘的相位**。故评审指定的方向（装配器侧带外
相位分流）是必需项，本实现按该方向落地；并行尝试中**确有价值**的部分是「完成位防假绿」
（`runCompleted`：只在 `run()` 正常返回后置真，逃逸路径不可能判 `ok`）与「单一 emit 点」，
本实现以等价方式覆盖：探针被杀 → 装配器补 17 条 `skip` + `plugin.probe_aborted`，`ok` 必为
`false`；写出点仍是探针侧单一 `emit()`（幂等）。

### 边界（不越权承诺）

- 探针仍是**有限时长验收**：50ms 排空窗口（`ASYNC_DRAIN_MS`）+ 10s 看门狗（`ASYNC_WATCHDOG_MS`，**保持 ref**）。
- 「后台任务同步占死事件循环」的边界如实声明：占死时长**短于**看门狗窗口 → 看门狗在事件循环空出后如期收尾；
  **超过**窗口 → 只能等外层 `execFileSync` 超时（`timeoutMs`，默认 600s），之后由**带外**侧信道相位归因
  （仍判插件侧、`hostFatal` 为空、报告不丢）。

### 测试项数

- `tests/test_offline.sh`：85 → **95 项**（🔴-D′ 装配器侧分流 10 条）
- `tests/test_attribution.mjs`：209 → **236 项**（[9.8g] 看门狗能红守卫 5 条 + 🟡-3 兜底区切片守卫与自证/反证 6 条 + [8] 反向护栏 3 条「探针未执行 → 侧信道为 null / checks 为空 / 仍判漂移」+ [9.8h] 装配器侧带外相位分流源码守卫 13 条）
- `tests/test_e2e_regression.mjs`：92 → **144 项**（[8c] 4 份夹具 × 14 条 + 看门狗行为级对偶 2 条 + 反向护栏 2 条）
- `tests/test_exports.mjs`：28 → **36 项**（[2b'''] 条件项计数守卫 8 条）
- 新增 `tests/gate_plugin_side.mjs`：8 份夹具 × 6 条断言（push / PR 共用）
- 新增夹具 4 份：`plugin-hang` / `plugin-process-exit` / `plugin-detach-handlers` / `plugin-busy-loop`

### 变异复测（本版自证：能红的都真的会红）

| 变异 | 修前 | 修后 |
|---|---|---|
| 写回 `watchdog.unref?.()` | 全绿 ❌ | **红** ✅（[9.8g] 源码 + [8c]/闸门行为级） |
| 兜底区内另加一行 `pushHostFatal`（保留诱饵） | 全绿 ❌ | **红** ✅（🟡-3 新切片） |
| 文档「另有 N 项」改字 / 条件项名单删一项 | 全绿 ❌ | **红** ✅（[2b''']） |
| 探针死在插件集成相位（挂起 / `exit` / 摘处理器 / 占死） | 判漂移 + `checks=0` ❌ | **红且归因正确** ✅（`PLUGIN_REGRESSION` / `hostFatal=[]` / 17 项不缺） |
| 侧信道文件被残留（同 workDir 复用） | 真漂移被收窄成插件侧 ❌ | **红**（跑探针前先 `rmSync`；离线 [8] 断言「探针未执行 → 侧信道 null → 仍判漂移」） |
| 探针未执行（离线缺缓存，读不到侧信道） | 判漂移 ✅ | 仍判漂移 ✅（反向护栏未被收窄） |

## v0.1.8 — 🔴-D 同族活口收口：插件侧**异步**异常进程级兜底 + 🟡 两处守卫加固

> 承接 v0.1.7（写入端分相位）。评审 @ `24362c7` 判 `disposition = fix_bug`：
> 🔴-D 主体修复正确且可复现，但**同族仍有活口**——异常从「同步路径」搬到了「**异步路径**」。

### 🔴 必修（同族活口）

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| 🔴-D′ | **插件侧异步异常逃逸到 `hostFatal[]`**。相位路由挂在 `try { await run() } catch` 上，但**不在 `run()` 调用栈上的异常**（进程级 `uncaughtException` / `unhandledRejection`）根本不经过那个 catch → 探针在写出 `__DSH_PROBE__` 之前就被 Node 杀掉 → 装配器看到「探针未输出结构化结果」→ 无条件 `pushHostFatal()` → 判据 1 → `UPSTREAM_DRIFT`/AMBER，且 `checks` 从 17 掉到 **0**（整份报告消失，比「盖掉一条 check」更彻底）；`probePhase` 被误报为 `host-assembly`。触发形态极常见：插件在 `apply()` 里排后台任务 / 事件回调 / 预取 promise，回调抛错 | ① **进程级兜底**：探针挂 `uncaughtException` + `unhandledRejection` 两个处理器，按**同一份相位路由**归因（`probeAsyncFailureRoute()`）——`plugin-integration` → 插件侧 check `plugin.async_uncaught_exception`（已登记 `PLUGIN_SIDE_CHECKS`），**绝不**写 `hostFatal[]`；② **照常输出结构化结果**（已跑完的检查全部保留），结果用 `writeSync` 输出（兜底后紧接着 `process.exit()`，异步 stdout 会被截断）；③ 记录后**不立即退出**（抛错时机不确定 → 立即退出会让 `checks` 随时机变化），改为让 `run()` 跑完再统一收尾 + `ASYNC_WATCHDOG_MS` 看门狗兜住「run() 被拖住」；④ 兜底处理器**自身不得抛**（`recordProbeAsyncException` 全字段归一 + 吞自身异常）；⑤ `PROBE_CHECK_ORDER` 声明规范顺序，中断时把未验项按序标 `skip`（报告里看得见「哪些没验」） | **离线** [9.8]（相位路由 5 + 写入端不变量 5 + 反向护栏 2 + 崩溃路径不抛 3 + 顺序表 4 + 夹具自检 8）；**离线** `test_offline.sh` [9] +5 条；**真宿主** [8b] 28 条 ×2 夹具（`plugin-async-throw-plugin.mjs` / `plugin-async-reject-plugin.mjs` → `PLUGIN_REGRESSION`/RED、`hostFatal.length === 0`、**`checks` 非空且 pass 项全在**、失败项 `plugin.async_uncaught_exception`、`probePhase=plugin-integration`、**重跑结论与报告形态一致**）；**闸门** `.cnb.yml` push/PR 各扩到 4 份夹具（新增异步两例 + 断言 `checks` 非空） |

### 🟡 建议（同批修）

| # | 问题 | 处置 |
|---|---|---|
| 🟡-1 | **不变量源码守卫可绕过（P2-10 同族）**：`test_attribution.mjs` [9.4] 用 `stripComments` 后正则 `pushHostFatal\(` 判顶层 catch 体内无裸调用。两处盲区（评审实测逃逸）：① 同行含 `//` 的字符串（`stripComments` 是保守实现，不区分字符串内的 `//`）——`const u = "probe:///x"; pushHostFatal(...)` 的调用**被截断出视野**；② 别名 `const pf = pushHostFatal; pf(...)` 不命中字面量 | **已修**：改用 `codeOnly`（去注释 + 去字符串/模板**文本**、保留 `${...}` 插值代码——与 [10] 口径统一）并**按标识符**判（`\bpushHostFatal\b`）。附**守卫自证**：上一版实测逃逸的三种写法（同行含 `//` 的字符串 / 别名 / 模板插值）现在全部被抓到，注释与文案不误报；并把「旧守卫确实漏检」写成**反证断言**，防后人改回去。主防线仍是行为反证（真宿主 E2E 断言 `hostFatal` 为空） |
| 🟡-2 | **第 7 步「文档计数防漂移」对「声明被删除」静默失效**：`check_doc_count` 取不到声明时只打 `⚠️ 跳过比对` 且**不递增** `DOC_COUNT_MISMATCH`。实测删掉 `README.md` 的计数声明行 → 三条比对全部跳过、本节仍绿（对「改数」有效，对「删声明」无效） | **已修**：声明缺失即 **FAIL**（新增 `DOC_COUNT_MISSING` 计数，与 `DOC_COUNT_MISMATCH` 一起必须为 0）；并补**守卫自证**（在子 shell 里用不存在的文件调用同一函数，必须判红且计数递增——自证不污染父 shell 口径） |
| 🟡-3 | `.cnb.yml` PR 段 `attribution-e2e` **重复 stage**（新增行插在了两个同名 stage 之间） | **已修**：去重（PR 段现为 1 个 `attribution-e2e`）。重复本身是历史遗留，本轮顺手清理 |

### 🟢 优化（同批顺手）

- `probeFailureRoute()` 返回值去掉未使用的 `field`（宿主侧唯一落点由 `pushHostFatal()` 决定；回传字段名会让人以为存在「第二处落点」）。
- `SKIP_AFTER_REGISTRY` 与 `SKIP_AFTER_DEFINITIONS` 的 4 项重复改为**派生**（`...SKIP_AFTER_DEFINITIONS`），防两处清单各自漂移。

### 兼容性

- 探针输出、验收报告**新增**：条件检查项 `plugin.async_uncaught_exception`（仅在插件侧异步异常路径出现，不计入 17 项）。
- `contract.mjs` 新增导出：`PLUGIN_ASYNC_EXCEPTION_CHECK` / `probeAsyncFailureRoute()` / `recordProbeAsyncException()` / `PROBE_CHECK_ORDER` / `CONDITIONAL_PROBE_CHECKS`。
- `probeFailureRoute()` 返回值**收窄**（去掉 `field`）——仅在测试内直接断言其形状，外部按 `side` 判分支不受影响。
- **语义收窄（同 🔴-D 口径）**：插件集成相位的**异步**异常同样不再进 `hostFatal[]`。

### 边界（不越权承诺）

- 探针是**有限时长验收**，不是运行时守护：只在收尾前给已排队的微任务/宏任务一个 **50ms 排空窗口**（`ASYNC_DRAIN_MS`）。更晚的延迟抛错发生在探针退出之后，不属本防线范围。

### 测试项数

- `tests/test_offline.sh`：80 → **85 项**（🔴-D 异步路径 5 条）
- `tests/test_attribution.mjs`：169 → **209 项**（[9.8] 异步活口 40 条：[9.4] 守卫加固与自证/反证并入其中）
- `tests/test_e2e_regression.mjs`：64 → **92 项**（[8b] 异步夹具 28 条）
- `tests/test_exports.mjs`：28 项（未变）
- 新增夹具：`tests/fixtures/plugin-async-throw-plugin.mjs`、`tests/fixtures/plugin-async-reject-plugin.mjs`
- `tests/test_hub.sh`：第 7 步补「声明缺失即红」+ 守卫自证
- `.cnb.yml`：push / PR 的 `plugin-error-not-host-signal` 闸门扩到 4 份夹具（含异步两例），并断言 `checks` 非空（防「报告整份消失」）


## v0.1.7 — 🔴-D 收口：`hostFatal[]` 写入端分相位（插件侧异常永不进判据字段）+ P2-9 / P2-10

> 承接 v0.1.5（复测清单闭环）/ v0.1.6（文档守卫加固）。
> 评审 @ `f995979` 判 `disposition = fix_bug`：🔴-D 未清零——同一失效族**仍有活口**，
> 但活口从「判据读取端」搬到了「**写入端**」。

### 🔴 必修

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| 🔴-D | **探针顶层兜底把插件侧异常写进 `hostFatal[]`**（判据唯一事实字段）。探针有两条「读插件侧数据」的路径不在 try 内：`tools.schemas().map(...)`（第 6 段）与 `definitions.map((d) => d?.name)`（第 11 段）。插件写错代码（类实例未初始化字段 / 抛错 getter）→ 异常逃出 `run()` → 顶层 `catch` 一律 `pushHostFatal()` → 判据 1 命中 → `UPSTREAM_DRIFT`/AMBER，且判据 1 **优先于**判据 5 → 插件侧已失败的 check 被整条盖掉。违反本 PR 自订不变量「插件侧错误**永远**不进该字段」 | ① **相位化兜底**：探针声明执行相位（`host-assembly` / `plugin-integration`），顶层兜底按相位归因——宿主装配相位 → `hostFatal[]`，插件集成相位 → **插件侧 check** `plugin.unexpected_exception`（已登记 `PLUGIN_SIDE_CHECKS`）；未知相位**保守判插件侧**；② **插件数据读取加护栏**：`tools.schemas()` → `registry.exact`、`definitions.map()` → `guard.reserved_rejected`（异常均落插件侧 check，并 `skipAll` 后续未验项）；③ 归属路由唯一事实源 `contract.mjs` 的 `PROBE_PHASE` / `probeFailureRoute()` / `recordProbeException()`（探针与离线回归共用同一份）；④ 相位随报告透出（`probePhase`），排障看得见异常归属依据 | **离线** [9] 20 条（相位路由 / 写入端不变量 / 反向护栏 / 源码守卫）；**真宿主** [8] 18 条 ×2 夹具（`plugin-side-throw-plugin.mjs` / `plugin-registry-throw-plugin.mjs` → `PLUGIN_REGRESSION`/RED **且 `hostFatal.length === 0`**、`hostFatal` 不含夹具路径与 `at ` 帧、插件侧 stack 仍留在 `errors` 日志）；**反向** 真宿主 [9] 3 条（离线缺缓存仍判漂移、`hostFatal` 非空、`probePhase=host-assembly`） |

### 🟡 建议（同批修）

| # | 问题 | 处置 |
|---|---|---|
| P2-9 | 文档判据表与计数仍漂移：`docs/ARCHITECTURE.md` 判据 1 仍写「错误串含 `fatal(host)`」——正是 v0.1.4 已删掉的判据，留着会诱导下一个人把文本扫描写回来；`docs/ARCHITECTURE.md` / `README.md` / `docs/INDEX.md` 的 59/48/34 计数未同步（`INDEX.md:39/40` 改了、`:38` 漏了） | **已修**：判据 1 改为「**结构化字段** `hostFatal[]` 非空（**判据不读 `errors` 自由文本**）」；补「写入端纪律（🔴-D）」段；全部测试计数同步为实际值（离线 70 / 归因离线 128 / 发布面 27 / 端到端 64），并新增 `test_hub.sh` 第 7 步机器守卫；`docs/INDEX.md` 与 `docs/ADAPTER_GUIDE.md` 补「条件触发检查项」小节（`plugin.unexpected_exception` 不计入 17 项，仅在异常路径出现） |
| P2-10 | 源码守卫可被平凡绕过：`test_attribution.mjs` [7] 的正则只认 `errors.` 前缀，别名（`const logLines = probe.errors`）写回文本扫描时**不命中**；同时注释/文案里写「不读 errors」反而**误报** | **已修**：新增 `tests/source-scan.mjs`（`stripComments` / `codeOnly`——后者去注释 + 去字符串/模板字面量的**文本部分**、保留 `${...}` 插值里的代码，因为「模板插值扫描」正是最短的绕过路径）。守卫改为「判据代码不得引用 `errors` 标识符（含别名）+ 不得出现 `fatal(host)` 字面量 + 不得引用 `HOST_FATAL_PREFIX`」，并**自证**三种绕过写法全部命中、注释/文案不误报；主防线仍是行为反证（`errors` 换抛错 getter，判据无感） |

### 🟢 优化（同批顺手）

- `pushHostFatal()`：`target.errors` 缺失时不再抛 `TypeError`（写入端最不该炸——记录信号本身失败会退化成未归因异常）；`target.hostFatal` 与 `target.errors` 双向归一。
- `attributionDetail()`：`hostFatal` 读取端 `Array.isArray` 归一 + 过滤空白项（此前「非数组但 `length > 0`」如字符串会被当成漂移信号）。
- 理由链可读性：`hostFatal[]` 非空时若**同时**存在插件侧失败 check，理由链补一句说明（判据优先级不变，避免人误读成「插件没问题」）。

### 兼容性

- 探针输出、验收报告新增字段 `phase` / `probePhase`（`host-assembly` / `plugin-integration`）。
- `attributionDetail()` / `attributeFailure()` 签名不变；**写入端语义收窄**——插件集成相位的异常不再进 `hostFatal[]`。
- 新增 `contract.mjs` 导出：`PROBE_PHASE` / `probeFailureRoute()` / `recordProbeException()` / `PLUGIN_PROBE_EXCEPTION_CHECK`。

### 测试项数

- `tests/test_offline.sh`：66 → **70 项**（🔴-D 相位化兜底 4 条；承接 v0.1.6 的 66 项基线）
- `tests/test_attribution.mjs`：94 → **128 项**（承接 v0.1.6 的 94 项基线）
- `tests/test_e2e_regression.mjs`：43 → **64 项**
- `tests/test_exports.mjs`：25 → **27 项**
- 新增夹具：`tests/fixtures/plugin-side-throw-plugin.mjs`、`tests/fixtures/plugin-registry-throw-plugin.mjs`
- 新增工具：`tests/source-scan.mjs`（`stripComments` / `codeOnly`）
- `tests/test_hub.sh`：新增第 7 步「文档计数防漂移」（文档声明的项数 ≠ 实际项数即红；P2-9 同族防线）；测试项数改为**从输出取**，不再硬编码
- `.cnb.yml`：push / PR 各新增 `plugin-error-not-host-signal` 闸门（两份 🔴-D 夹具：断言 `PLUGIN_REGRESSION` + `hostFatal` 为空 + 非 AMBER）

### v0.1.7（同版本第二批）— 复测收口（漂移表唯一事实源 + 文档守卫三处活口）+ 新增 **上游漂移自动归因影响面**

> 承接本版第一批（🔴-D 写入端分相位）。本轮先**照单复跑**用户点名的 §二 14 组变异（含 2b 行下移/整行删除、INDEX 标题与序号），本轮先**照单复跑**你点名的 §二 14 组变异（含 2b 行下移/整行删除、INDEX 标题与序号），
> 并核对 `[2b'']` 的「编号可检索」是否符合 P2-新-3 的预期；再往后开发一个新能力。
> 结论：**14 组拦下 12 / 逃逸 2**（逃逸的都是真活口，已在本版堵上）；`[2b'']` 符合预期（逃逸 0）。

### ✅ 复测结果（先说结论）

| 项 | 结果 |
|---|---|
| §二 14 组变异（本批修前） | **拦下 12 / 逃逸 2**：M05（纪律③断言非定位，删条件语义仍绿）、M06（删正文唯一事实源声明句，由纪律④顶包） |
| 2b 行下移 / 整行删除 | **红 ✅**（`tests/test_attribution.mjs` [7b] 行序 + 行级断言拦下） |
| INDEX 标题后缀 / 注脚 / 序号列 / 序号全写 1 | **红 ✅ 4/4**（`tests/test_exports.mjs` [2b'] 拦下） |
| `[2b'']` 编号可检索 | **符合 P2-新-3 预期**：CHANGELOG 点名的防线编号若在对应测试文件里检索不到即红；实测逃逸 0 |
| 本批修后 14 组 | **拦下 14 / 逃逸 0**（本版自证过程中又自查出 3 个二/三轮活口并堵上，见下） |
| 新增 6 组针对新能力的变异（N01–N06） | **拦下 6 / 逃逸 0** |

### 🟠 活口一（M05 类）— 纪律③ 断言是「非定位断言」：删条件语义仍绿

| 项 | 内容 |
|---|---|
| **现象** | 断言写作 `(discText['3'] ?? '').includes('一一对应')`——只问「这两字在不在」。把纪律③从「**必须一一对应才判**上游漂移」改成「**有漂移即判**」（= 把插件 bug 甩给上游的旧口径），或删掉「才判上游漂移」这半句，断言**照样绿** |
| **危害** | 纪律③ 是中台「不把插件 bug 甩给上游」的文档侧口径；它被弱化成「有漂移即判」后，后人照文档改实现 = 🔴-C 语义反转复发 |
| **修** | 改为**成对语义断言**：纪律③ 条内必须同时出现「漂移字段」+「失败 check」+「一一对应」**且**写明判定条件（`才判上游漂移`）+ 理由（`不把插件 bug 甩给上游`），并显式禁止退回「有漂移即判」措辞 |
| **防线** | [7b] 新增 3 条（成对要件 / 条件与理由 / 禁回退措辞） |

> 说明：v0.1.6 的「纪律③定位断言」在**只改纪律③**时能拦下改字（我实测确认：改字即红）；
> 逃逸的是**不早退**写法——即同一处改字但判据表第 3 条行内的「一一对应」仍在时，靠的仍是**别处同句**。
> 本轮把「同段别处同句」这条后门一并关掉。

### 🟠 活口二（M06 类）— 文档断言**定位到错的行**：删正文声明句后由纪律④**顶包**

| 项 | 内容 |
|---|---|
| **现象** | 断言用 `lineOf(predicate)` = 段内**首个**匹配行。而「判据表**唯一事实源**在 `src/harness/contract.mjs`」这句在段内**出现两次**：正文声明句（表格下方）与纪律④。删掉**正文声明句**后由**纪律④顶包**，断言照绿（我逐行定位复现确认） |
| **危害** | 正文声明句（对人最显眼的一处）可被删/改写而无人报警；文档只剩纪律里一句，口径完整性下降 |
| **修** | ① 声明句与纪律④ **分开定位**：按「四条纪律」小节切分段落，声明句必须在**纪律小节之前**；② 三要件同句断言（`唯一事实源` + `contract.mjs` + `探针与执行器共用`）；③ 加「两处必须落在**不同行**」防单条顶包 |
| **防线** | [7b] 新增 4 条（正文声明句独立存在 / 三要件齐全 / 纪律④独立 / 两处不同行） |

> **二轮/三轮自查（把两个事实源拆行后新暴露的活口，本轮一并堵上）**：
> ① 二轮把「check 名单」与「漂移相关性表」两个事实源写在**同一行** → 删掉前一半的「探针与执行器共用」后，
> **同一行后文**的「共用」（影响面报告共用）顶包 → 逃逸；修：**两处各占一行、逐行断言**。
> ② 拆行后**总起句**（「有两处，各管一半（缺一即红）」）可被整行删除而两个子项仍在 → 逃逸；
> 修：加总起句断言。③ 两个子项各自被删也要红；修：逐子项断言。
> **教训**：拆行是必要的，但**拆出来的每一层都要有人守**——否则只是把活口挪了个位置。 |

### 🟠 顺带收口 — 漂移相关性表**三处各自维护** → 收归唯一事实源

| 项 | 内容 |
|---|---|
| **现象** | 漂移相关性在 `src/verify/runner.mjs` 是 **4 条手写 `\|\|`**，与 `docs/ARCHITECTURE.md` 判据表第 3 条、`triage` 影响面表**三处各写一份**，且有 `dispatch.` **前缀通配** |
| **危害** | 上游新增一个需参与相关性判定的契约字段时，任一处漏改即静默漏判 → 插件 bug 被归因成「上游漂移」，修复方向错（与 🔴-C 同族） |
| **修** | 相关性表**唯一事实源** = `src/triage/index.mjs` 的 `DRIFT_IMPACT`（字段 → 受影响 check 名，**精确匹配**，无前缀通配）；`runner.mjs` 只 import，不再手写；未登记字段由 triage 显式标 `known:false` 暴露（**不猜**） |
| **防线** | 离线 [14] 5 条（已 import / 无硬编码 / 无前缀通配 / 硬证据不入表 / check 名属名单）+ [7c] 5 条 |

### 🟢 新能力 — 上游漂移**自动归因影响面**（本版主要开发内容）

> 你说「继续往后开发吧」。v0.1.6 的 `watch` 只能回答「上游有没有发新版」；本轮把它推到
> **「漂移到哪 → 影响哪些检查 → 中台该改哪一处 → 插件要不要动」**——这正是本 Issue
> 「重复劳动自动化」的最后一公里：以前上游一发版，人要逐仓翻日志判断「跟我有没有关系、我改哪儿」。

| 能力 | 说明 |
|---|---|
| **漂移语义分类** | 契约字段（`reservedName` / `schemaSubset` / `configProjection` / `outputShape`）→ 受影响检查清单 → 责任方（`upstream` / `hub` / `plugin`） |
| **迁移建议（定向修）** | 直接点名**中台要改的文件**（如 `src/compat/schema.mjs`），并给出「一步动作」人话；**插件零改动** |
| **插件义务识别** | 上游**新增保留名**时显式点名（`diffReservedNames()`）：「插件**必须**改名，否则声明即判 `PLUGIN_REGRESSION`」 |
| **不猜** | 未登记的契约字段 → `known:false` + 「先补 `DRIFT_IMPACT`，**不要**据此改插件」 |
| **人机分工纪律** | 本模块产物是**人类排障建议**（`advice`），**不得**回灌进 `verify` 的归因判据（判据只读 `hostFatal[]` + check 名）——报告里显式声明，且由 [7c] 断言守住 |
| **CLI** | `watch --markdown`（人类视图）/ `watch --contract-from <verify.json>`（CI 上把验收报告喂进来，同时给出「版本漂移 + 契约漂移 + 影响面」，不必再跑真宿主） |
| **CI** | `crontab` 每日 `watch --markdown`；页面按钮「上游漂移侦测」先打人类视图再留 JSON |

示例输出（模拟上游把保留名改成 `run_script` + schema 子集白名单变化）：

```
| 契约字段 | 受影响检查 | 归因 | 责任方 | 中台要改的文件 |
| reservedName | guard.reserved_name | UPSTREAM_DRIFT | hub | src/compat/tool.mjs src/harness/contract.mjs |
| schemaSubset | compat.schema_flatten | UPSTREAM_DRIFT | hub | src/compat/schema.mjs |
- reservedName：上游放宽/收紧了保留名校验：中台保留名护栏与契约探测各改一处；插件零改动。
  - 插件影响：🔴 插件**必须**改名：上游新增保留名 run_script（声明即判 PLUGIN_REGRESSION）
```

### 测试项数

- `tests/test_offline.sh`：70 → **80 项**（+[14] 漂移表唯一事实源 5 条，+[15] watch 影响面 5 条）
- `tests/test_attribution.mjs`：128 → **169 项**（+[7b] 纪律③成对语义 3 + 声明句逐行定位 7（含总起句子项 3 处各一行），+[7c] 漂移表唯一事实源 5，+[9] triage 影响面 24）
- `tests/test_exports.mjs`：27 → **28 项**（+`[2b'']` 登记 `[7c]` / `[9]` / `[14]`）
- `tests/test_e2e_regression.mjs`：64 项（真宿主复跑**全绿**；本批未动归因判据的输入面，无需新增真宿主用例）
- **真宿主复跑**：`stable` GREEN 17/17 ✅、`dev` GREEN 17/17 ✅、E2E 43/43 ✅

### 兼容性

- 新增导出面：`src/triage/index.mjs`（`DRIFT_IMPACT` / `DRIFT_FIELDS` / `classifyDrift` / `diffReservedNames` / `triageUpstream` / `toTriageMarkdown`），`package.json` 新增 `exports["./triage"]`。
- `watch` 报告新增字段：`triage`、`contractDrift`；`watch` 退出码语义不变（0 无漂移 / 1 有漂移 / 2 离线）。
- 新增 CLI 参数：`--contract-from <verify-json>`；`watch` 支持 `--markdown`。
- **归因结果不变**：`DRIFT_IMPACT` 与旧手写 `||` 的差异仅在 `outputShape` 由 `dispatch.` 前缀通配改为 4 个精确 check 名——这 4 名即旧通配**覆盖的全部**现有 dispatch 检查，故对现有用例判定结果无变化（E2E 64 项全绿佐证）。

---

## v0.1.6 — 复测 🟠P1-新/🟡P2-新 收口（文档守卫加固：从「关键词存在」升级到「结构 + 行序」）

> 承接 v0.1.5（续）。复测结论：文档修复本体通过，但**判据表守卫「守住了文字，没守住结构与顺序」**——
> 测试方另造 14 组变异，12 组逃逸（全绿）。P1 的闭环要件是「[7b] 守得住」，故本轮**只补防线**：
> `src/` 与 `package.json` **零改动**（`git diff c199ae8..HEAD -- src/ package.json` 为空），版本号不动。

### 🟠P1-新 — 判据表守卫拦不住「行序反转」与「整行删除」

| # | 问题（复测证据） | 处置 | 回归防线 |
|---|---|---|---|
| P1-新-1 | **2b 行下移到第 4 条之后 → [7b] 全绿**。优先级反转 = 🔴-C 语义反转（硬证据不再优先于漂移相关性），守卫静默放行 | 新增**行序断言**：按表格行顺序抽优先级键（`1,2,3,4,5,6,2b`），断言 `2b` 行索引 **<** `3` 行索引 | `tests/test_attribution.mjs` [7b] 行序断言 |
| P1-新-2 | **2b 行整行删除 → [7b] 全绿**。prose 仍提及 `guard.reserved_rejected`，段落级 `includes` 命中 → 断言空转 | 新增**行级断言**：`^\|\s*\*\*2b\*\*\s*\|` 锚定 2b 行，在**该行内**断言 `guard.reserved_rejected` + `PLUGIN_REGRESSION`；第 1 条同理在 `^\| 1 \|` 行内覆盖 `HOST_SIDE_CHECKS` 三项 + `hostFatal[]` + `HOST_FATAL_FIELD` | [7b] 行级断言 ×4 |

### 🟡P2-新 — 段落级关键词断言可被「第二处同句」或「改字」逃逸

| # | 问题（复测证据） | 处置 | 回归防线 |
|---|---|---|---|
| P2-新-1 | 表头改「任何判据不读」→「可作参考」、纪律②「优先于」→「并行判断」、纪律③「一一对应」→「有漂移即判」、删唯一事实源声明句 → 全绿（段落级 `includes` 被同段落别处命中） | 口径行 / 表头 / 唯一事实源 / 纪律①②③④ 全部改**定位断言**：口径行取「表格上方最近的非空行」，纪律正文按条目聚合后做**条内**断言，唯一事实源要求**同一行**同时出现「唯一事实源」与 `src/harness/contract.mjs` | [7b] 定位断言 ×6 |
| P2-新-2 | `INDEX.md` 标题删「（按探针实际输出顺序）」、注脚「输出顺序」→「执行顺序」、删 `#` 序号列、序号全写 1 → `[2b]` 全绿（而 CHANGELOG 自述「[2b] 守住标题/序号」） | 新增 `tests/test_exports.mjs` **[2b']**：断言 INDEX 标题带「（按探针实际输出顺序）」后缀、`#` 序号列为 `1..17` 连续、注脚写明「序号 = 探针实际输出顺序」且声明由 `[2b]` 守住 | `test_exports.mjs` [2b'] 5 条 |
| P2-新-3 | CHANGELOG「本版未落地」标注无守卫 | 本版起：CHANGELOG 对防线编号的自述必须与**实际存在的断言编号**一致（自述 `[7b]`/`[2b']` 即须在测试文件中可检索到）；对应自述已在 `[7b]`/`[2b']` 落地，逐条可检索 | [7b] + [2b']（编号可检索） |

### 变异复测（本版自证，测试方 14 组里 12 组逃逸的现在全红）

| 变异 | 修前 | 修后 |
|---|---|---|
| 2b 行下移到第 4 条后 | 全绿 ❌ | **红** ✅ |
| 2b 行整行删除 | 全绿 ❌ | **红** ✅ |
| 口径行「任何判据不读」→「可作参考」 | 全绿 ❌ | **红** ✅ |
| 纪律②「优先于」→「并行判断」 | 全绿 ❌ | **红** ✅ |
| 纪律③「一一对应」→「有漂移即判」 | 全绿 ❌ | **红** ✅ |
| 删唯一事实源声明句 | 全绿 ❌ | **红** ✅ |
| INDEX 标题删后缀 | 全绿 ❌ | **红** ✅ |
| INDEX 注脚「输出顺序」→「执行顺序」 | 全绿 ❌ | **红** ✅ |
| INDEX 删 `#` 序号列 / 序号全写 1 | 部分 ❌ | **红** ✅ |
| 删 2b 行序理由段 | 全绿 ❌ | **红** ✅ |

### 测试项数

- `tests/test_attribution.mjs`：80 → **94 项**（+[7b] 行序 1 + 行级 4 + 定位 6 + 理由段 1，共 14 项）
- `tests/test_exports.mjs`：20 → **25 项**（+[2b'] INDEX 标题/序号/注脚结构 5 项）
- `tests/test_offline.sh`：66 项（不变）
- **真宿主**三通道：本版未动 `src/`，无需重跑（离线可完整复现本轮全部变异）

---
## v0.1.5（续）— 复测 P1/P2 收口（文档即防线：判据表对齐 + 判据表守卫）

> 承接 v0.1.5。复测结论：三项清零独立复现为真、13 组变异测试验证防线有效；
> 但发现 **🟠P1 文档判据口径漂移**——`docs/ARCHITECTURE.md` 归因判据表仍是 v0.1.4 已删除的旧口径，且无测试守。
> 本轮**只改文档 + 补防线，不动归因源码**（源码已在 v0.1.4 收口）。

### 🟠P1 — `docs/ARCHITECTURE.md` §4.2 ③ 判据表第 1 条回退到已删除的自由文本口径

| # | 问题 | 处置 | 回归防线 |
|---|---|---|---|
| P1 | 判据表第 1 条写「**错误串含 `fatal(host)`**，或失败项属 `HOST_SIDE_CHECKS`」——与实现（`src/verify/runner.mjs` 判据 1 只读 `probe.hostFatal[]`）、`ADAPTER_GUIDE` 7 步表第 1 条、`RISKS` R17/R13（明写「`errors[]` 任何判据不读」）**三处矛盾**。后人照此表把自由文本判据加回去 = 🔴-C 原样复发。且 `tests/` 对 `ARCHITECTURE.md` 的引用数 = **0**（该表无任何防线） | 第 1 条改为「**结构化字段 `hostFatal[]` 非空**（`HOST_FATAL_FIELD`），或失败项属 `HOST_SIDE_CHECKS`」；表头口径改为「**只读结构化字段与 check 名**；`errors[]` 是纯人读日志，**任何判据不读**」；补 **四条纪律**（判据只认结构化证据 / 硬证据优先 / 漂移须一一对应 / 唯一事实源） | 新增 `tests/test_attribution.mjs` **[7b]**：抽取 §4.2 ③ 段落，断言①不再出现「错误串含 `fatal(host)`」、②显式引用 `hostFatal[]`+`HOST_FATAL_FIELD`、③写明 `errors[]` 不参与判据、④声明唯一事实源、⑤「四条纪律」四条齐全、⑥覆盖 `PLUGIN_HARD_EVIDENCE`/`HOST_SIDE_CHECKS` 全部条目（表一改即红） |

### 🟡P2 — 自述与落地不符 + 测试盲区

| # | 问题 | 处置 | 回归防线 |
|---|---|---|---|
| P2-1 | `docs/INDEX.md` 17 项索引表标题仍是「17 项验收检查索引」、未加序号，正文仍写「顺序即探针实际**执行**顺序」——与 CHANGELOG 自述（标题改「按探针实际输出顺序」）及 `ADAPTER_GUIDE`（已加序号）不一致 | 标题改「17 项验收检查索引（**按探针实际输出顺序**）」；表格加 **`#` 序号列**（1–17，与 `ADAPTER_GUIDE` 一一对应）；注脚改「序号 = 探针实际输出顺序」并声明由 `test_exports.mjs` [2b] 守住 | `test_exports.mjs` [2b]（原有，顺序 + 17 项覆盖）。⚠️ 复测发现该防线**只守顺序、不守标题/序号结构**（标题后缀/注脚/序号列被删仍全绿）——已在 **v0.1.6** 补 `[2b']` 结构守卫 |
| P2-2 | CHANGELOG 过度自述：v0.1.5 写「`INDEX.md` 标题改动」「ARCHITECTURE 7 步优先级 + 四条纪律」，实际均未落地（全仓搜「四条纪律」= 0 处） | v0.1.5 小节改为如实标注「本版未落地，已在本轮（v0.1.5 续）补齐」；本轮把「四条纪律」写进 `ARCHITECTURE.md` §4.2 ③、把 `INDEX.md` 标题与序号补齐（**自述 → 落地**，而非删自述） | [7b]（纪律段落存在性）+ [2b]（INDEX 顺序）。⚠️ 同 P2-1：[2b] 当时**未覆盖标题/序号结构**，本版自述曾超前；已在 **v0.1.6** 用 `[2b']` 落地 |
| P2-3 | `summarize()` 多通道 `verdict` 优先级（`RED > AMBER`）无单测 → 变异体（漂移优先于回归）逃逸，闸门层静默退化无覆盖 | 新增 `tests/test_offline.sh` **[13]** 六条断言：全绿→GREEN / 仅漂移→AMBER / 仅回归→RED / **漂移+回归混合→RED**（不得被降级）/ 混合判决与通道顺序无关 / 失败不可归因→UNKNOWN | 离线 [13] 6 条 |

### 🟢 顺带（同批）

- 新增 `tests/test_exports.mjs` **[2c]**：`docs/ARCHITECTURE.md` 头部版本声明必须 = `package.json` 版本（防「文档说 vX、实际是 vY」；本版即由该守卫抓到头部仍写 `v0.1.1`）。
- 版本号**不动**（保持 `0.1.5`；本轮只改文档 + 补防线，不触碰归因源码与版本元数据）。

### 测试项数

- `tests/test_offline.sh`：60 → **66 项**（+[13] 6 条 `summarize()` verdict 优先级）
- `tests/test_attribution.mjs`：69 → **80 项**（+[7b] 11 条 ARCHITECTURE 判据表守卫：旧口径已删 + 结构化字段 + errors 不读 + 唯一事实源 + 四条纪律四条齐全 + 名单覆盖）
- `tests/test_exports.mjs`：19 → **20 项**（+[2c] 1 条文档版本一致性）
- `tests/test_e2e_regression.mjs`：43 项（不变；本版未动归因源码，无需重跑真宿主）
## v0.1.5 — 复测遗留项收口（评审 §三/§四 清单闭环）

> 承接 v0.1.3（🔴-C + 负例闸门）与 v0.1.4（判据只读结构化字段）。本轮把复测清单里**剩余未落地项**补齐，
> 并给「修好的东西」补上**能拦住回归的断言**（不只补代码，还要补防线）。

### 🟡 复测清单收口

| # | 问题 | 处置 | 回归防线 |
|---|---|---|---|
| 复测-4 | 🔴-C 用例只断言 `attribution`，**未断言 `verdict`**——闸门层（AMBER 放行）无覆盖 | `tests/test_e2e_regression.mjs` 的 🔴-C 场景（[4] 基线一致 / [5] 漂移窗口）与 🔴-A 场景（[1] GREEN）全部补 `summary.verdict` 断言（`verify()` 返回值带上顶层 `summary`）；失败项断言由「含 `guard.reserved_rejected`」收紧为「失败项**只有** `guard.reserved_rejected`」（无噪音失败） | 真宿主 [1]/[4]/[5] 新增 4 条 verdict 断言 |
| 复测-5 | §四 **反向护栏 5 例**未全部进离线回归（只有 2 例） | 新增 `tests/test_attribution.mjs` [4c] 八条：`schemaSubset`/`outputShape`/`configProjection` 漂移 + 对应 check fail → 仍 `UPSTREAM_DRIFT`；ETARGET / 离线缺缓存（结构化 `hostFatal[]`）→ `UPSTREAM_DRIFT`；漂移窗口 + 健康插件 → 不被 `guard.*` 误伤；`guard.reserved_name` 精确性不回归；`guard.reserved_name` 与 `guard.reserved_rejected` 未合并 | 离线 [4c] 8 条 |
| 复测-6a | 文档 17 项清单**顺序**与实际输出不符（`docs/ADAPTER_GUIDE.md` 正文先出现 `guard.reserved_rejected`，顺序读起来是「硬证据在首位」） | 两份文档清单加**序号**并声明「顺序 = 探针实际输出顺序」；新增 `tests/test_exports.mjs` [2b]：从探针源码抽 `check()` 调用顺序，与 `docs/INDEX.md` / `docs/ADAPTER_GUIDE.md` 清单段落逐项比对（故意交换两项即红） | 发布面自检 [2b]（2 份文档 × 顺序 + 17 项覆盖） |
| 复测-6b | `docs/RISKS.md` 缺「**漂移窗口首跑顺序影响后续归因**」口径（评审 P2-5 要求写明） | 新增 **R18**：写清这是「仅 ok 更新基线」的必要设计（**非缺陷**）、排障/复测以**首次运行或干净副本**为准、`attributionReasons` 无「契约指纹漂移」字样时先查基线是否被上一次 ok 运行刷新；并新增 **R17** 记录「判据扫自由文本」（v0.1.4 已修）的历史风险 | `docs/RISKS.md` R17 / R18 + `docs/ADAPTER_GUIDE.md` §4 排障口径 |

### 文档

- `docs/ADAPTER_GUIDE.md` §4：17 项清单加序号；新增「归因优先级」7 步表 + 漂移窗口首跑顺序排障口径。
- `docs/INDEX.md` / `docs/ARCHITECTURE.md` 的 §4.2 ③ 两处文案在本版**未落地**（自述超前），已在本轮（v0.1.5 续）补齐 —— 见下节。

### 测试项数

- `tests/test_attribution.mjs`：61 → **69 项**
- `tests/test_e2e_regression.mjs`：40 → **43 项**
- `tests/test_exports.mjs`：16 → **19 项**
- `tests/test_offline.sh`：60 项（不变）


## v0.1.4 — 归因判据改读结构化字段（自由文本扫描清零）+ P2-6 / P2-7 / P2-8

> 对应评审结论（PR #2 / 架构·评审，复评 @ `ba30bb2`）：`disposition = fix_bug`——归因判据仍**扫自由文本**。
> 与 v0.1.3（漂移相关性吞掉插件侧硬违规）属**同一失效族的两处独立活口**：
> v0.1.3 收口「相关性过宽」，本节收口「判据读自由文本」，两处均已闭合。

### 🔴 必修

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| 🔴-C（活口二：自由文本） | **归因判据仍扫自由文本**：上轮把裸 `npm` / 裸 `fatal:` 换成 `fatal(host)` 前缀后，判据仍对拼接后的 `errors` 做**子串扫描**——插件侧 stack / 文件路径 / CI 工作目录里出现该字面量即翻案（与原 🔴-B 同族）。真宿主可触发：插件放在 `/tmp/fatal(host)-dir/` 里 `apply()` 抛错 → 误报 `UPSTREAM_DRIFT` | 判据**只读结构化字段**：新增 `HOST_FATAL_FIELD = 'hostFatal'`；探针/装配器经 `pushHostFatal()` 把宿主侧致命信号**同时**落 `hostFatal[]`（判据依据）与人读日志 `errors[]`（前缀 `fatal(host)`）；`attributionDetail()` 判据 1 改为 `probe.hostFatal.length > 0`，**删除对 `errors` 的一切读取**；报告新增字段 `hostFatal` | 离线：`tests/test_attribution.mjs` [3.1]（路径含 `fatal(host)` / 错误文本含该字面量 / CI 工作目录含该字面量 → 全判 `PLUGIN_REGRESSION`）+ [7] 源码守卫（判据代码不得出现 `errors.join`/`errors.includes`/`HOST_FATAL_PREFIX`）；真宿主：`tests/test_e2e_regression.mjs` [5]（插件目录名含 `fatal(host)` → `PLUGIN_REGRESSION`）+ [6]（真宿主离线缺缓存 → `UPSTREAM_DRIFT` 且 `hostFatal` 非空，**不因收窄判据丢掉真漂移**） |

### 🟡 建议（同批修）

| # | 问题 | 处置 |
|---|---|---|
| P2-6 | 契约漂移相关性表把**纯插件违规**甩给上游：`reservedName` 漂移 + `guard.reserved_rejected` 失败 → `UPSTREAM_DRIFT` | **已修**：`guard.reserved_rejected` 移出相关性表（其语义是「插件违反宿主硬约束」），只认 `guard.reserved_name`（中台护栏自身是否可用）。漂移 + 插件声明保留名 → 判 `PLUGIN_REGRESSION` |
| P2-7 | 文档漂移：`docs/RISKS.md` R13 称「三张表集中在 `src/verify/runner.mjs`」 | **已修**：口径改为唯一事实源 `src/harness/contract.mjs`；R7 / R13 同步「判据只读结构化字段、`errors` 不参与判据」 |
| P2-8 | 测试内复制唯一事实源：`tests/test_e2e_regression.mjs` 硬编码 12 项 `pluginSide` 集合 | **已修**：改为 `import { PLUGIN_SIDE_CHECKS }`，表一改测试立即跟随 |

### 🟢 优化（同批顺手）

- `probe-template.mjs`：三处 Context 装配样板（`ctx.plugin(SystemPrompt/ToolRuntime)` + 等待宿主就绪）抽成 `mountTools()`；`skipAll([...])` 的 4 项清单抽成常量 `SKIP_AFTER_DEFINITIONS`。
- `tests/test_e2e_regression.mjs`：清理未使用的 `readdirSync` / `symlinkSync` 导入。
- （`src/cli.mjs` 的 `readFileSync` / `verifyChannel` 未使用属**既有问题**，非本 PR 引入，本轮不动。）

### 兼容性

- 探针输出、验收报告与二级信息（`report` / `--markdown`）新增字段 `hostFatal: string[]`（结构化宿主侧信号）；`errors[]` 语义收窄为**纯人类可读日志**。
- `attributeFailure()` / `attributionDetail()` 签名不变；**判据输入变了**——不再接受「只在 `errors` 里写宿主侧文本」的调用方，必须走 `hostFatal[]`。
- 导出面新增 `HOST_FATAL_FIELD`、`pushHostFatal()`（`harness/contract.mjs`）。

### 新增/变更测试

- `tests/test_attribution.mjs`：48 → **61 项**（🔴-C 自由文本反例 4 条 + P2-6 2 条 + 源码守卫 2 条 + 装配器结构化字段 4 条 + 反向证明 1 条）。
- `tests/test_e2e_regression.mjs`：34 → **40 项**（🔴-C 真宿主 3 条 + 真漂移不丢 3 条）。
- `tests/test_offline.sh`：60 项（宿主侧信号改走结构化 `hostFatal[]` + 新增「路径含 `fatal(host)`」反例）。
- 与 v0.1.3 的 [4b]/[5]（硬证据优先）用例**共存**：[3.1]/[6] 覆盖「自由文本翻案」，[4b]/[5] 覆盖「漂移吞硬违规」。

## v0.1.3 — 评审二轮 🔴-C + 负例闸门盲区修复（归因优先级）

> 承接 v0.1.2（🔴-A / 🔴-B 已清零）。本轮清零剩余两项必修：**🔴-C** 与**负例闸门盲区**。
> 失效面一致：**漂移相关性把插件侧硬违规吞掉**。

### 🔴 必修

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| 🔴-C | 漂移相关性判据过宽：`reservedName` 漂移时把插件侧 `guard.reserved_rejected` 一起算作「相关」→ 插件硬违规被吞成 `UPSTREAM_DRIFT`/AMBER，责任甩给上游 | 新增 `PLUGIN_HARD_EVIDENCE = ['guard.reserved_rejected']`，作为**判据 2b** 插在「漂移相关性」之前：插件违反宿主硬约束与上游契约是否漂移无关，漂移窗口内也判 `PLUGIN_REGRESSION`。同时把 `reservedName` 的相关性收窄为**只对应中台自检 `guard.reserved_name`**（不用 `guard.*` 通配，避免过度修正） | 离线回归 [4b]（4 项：硬证据优先 + 理由链 + 两条反向护栏）；端到端 [5]（打补丁真宿主 + broken-plugin → `PLUGIN_REGRESSION`，且同窗口健康插件仍 `PASS`） |
| 🔴-D | 负例闸门盲区：`tests/test_hub.sh` 只断言 `*"|fail"`，AMBER 下照样 PASS ——「负例被拦下」这道防线在漂移窗口内**静默失效** | 闸门断言升级为**三条**：失败项 = `guard.reserved_rejected`、`attribution === PLUGIN_REGRESSION`、`verdict !== AMBER`；`.cnb.yml` 的 `guardrail-negative` 同步（只判退出码不够） | `tests/test_hub.sh` step 3 三条断言 |

### 兼容性

- `src/harness/contract.mjs` 新增导出 `PLUGIN_HARD_EVIDENCE`（`src/verify/runner.mjs` 同步再导出）。
- 归因结果变化：漂移窗口内的 `guard.reserved_rejected` 由 `UPSTREAM_DRIFT` 改为 `PLUGIN_REGRESSION`（**这正是修复目标**）。
- `guard.reserved_name`（中台自检）+ 漂移 仍判 `UPSTREAM_DRIFT`（未过度修正）。

### 测试

- 离线回归 43 → **48** 项；端到端回归 28 → **34** 项。

## v0.1.2 — 评审 🔴 必修项清零（归因正确性）

> 对应评审结论（PR #2 / 架构·评审）：`disposition = fix_bug`，🔴-A / 🔴-B 未清零不放行。

### 🔴 必修

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| 🔴-A | **探针契约采集残留致归因误判**：第 2 段契约采集 `register({name:'run_code'})` 未 dispose；上游一旦接受该名，残留 `run_code` 污染被测插件工具清单 → `registry.exact` 假失败 → 责任甩给插件 | 采集逻辑抽到 `src/harness/contract.mjs#collectContract()`：每次 `register()` 成功后**立即 dispose**（`finally` 保证），采集后自检残留（新 check `contract.probe_disposed`，残留即判宿主侧） | 离线：`tests/test_attribution.mjs` [1]（接受型宿主采集后无残留）；真宿主：`tests/test_e2e_regression.mjs` [1]（打补丁宿主 = 上游取消保留名 → 期望 GREEN 且契约仍记漂移） |
| 🔴-B | **归因判据用裸关键词且已在线**：`/…|npm|…/` 命中探针错误串里的**路径**、`/host\.tools_ready|fatal:/` 命中**插件侧**错误（探针把所有致命错误统一写 `fatal:`）→ 插件写坏了却被告知「上游变了，不是你的问题」 | 两侧同时收口：① 探针错误**分级**——宿主/环境侧 `fatal(host): …`，插件侧一律落 check（`plugin.loaded` / 新增 `plugin.apply_ok` / `plugin.definitions_ok`）；② `runner` 判据**结构化**（`HOST_FATAL_PREFIX` + `HOST_SIDE_CHECKS` / `PLUGIN_SIDE_CHECKS` 三张表），删除裸 `npm` / 裸 `fatal:`；③ 装配器错误措辞不再回显命令行与路径 | 离线：`tests/test_attribution.mjs` [2][3]（含「路径含 npm」「插件侧裸 `fatal:`」反例）；真宿主：`tests/test_e2e_regression.mjs` [2][3]（apply 抛错 / 语法错误 / 缺 apply / 多余工具 → 全 `PLUGIN_REGRESSION`；hub 路径含 `npm` 不翻案） |

### 🟡 建议（同批修）

| # | 问题 | 处置 |
|---|---|---|
| P2-1 | 带值参数缺值静默改语义（`--channel` 缺值跑三通道、`--json` 缺值不写文件、`--plugin` 缺值深处 TypeError） | **已修**：缺值显式报错 → exit 2；`--key=` 显式空值仍可用 |
| P2-2 | `report --channel legacy` 被忽略（硬编码 stable+dev） | **已修**：`report` 走同一 `resolveChannels`（默认 stable+dev，可显式指定） |
| P2-3 | `pruneHostCache()` 无调用点 | **已修**：新增 `dsh-adapt cache` 子命令 + `verify --prune-cache`，保留当前三通道指纹、清理历史残留 |
| P2-4 | 缺插件文件 exit=3 而 usage 只声明 0/1/2 | **已修**：缺文件 = 用法错误 exit 2；usage 显式声明 `3=运行时异常` |
| P2-5 | `ENV_ERROR` 死声明 | **已修**：移除；环境/网络问题由宿主侧信号表达（`UPSTREAM_DRIFT`），归因返回值收窄为 `UPSTREAM_DRIFT` / `PLUGIN_REGRESSION` / `UNKNOWN` |
| — | 归因只有结论、没有依据 | **已修**：新增 `attributionDetail()` 与报告字段 `attributionReasons`（判据链，进 JSON 与 Markdown） |
| — | 探针失败项与「跳过项」混在一起 | **已修**：前置失败后续检查记 `status: 'skip'`（不再制造噪音失败），报告给 `checksSkipped` |

### 兼容性

- 探针 check：14 → **17 项**（新增 `contract.probe_disposed` / `plugin.apply_ok` / `plugin.definitions_ok`）。
- 报告新增字段：`attributionReasons`、`probes`、`probeExit`、`summary.unknown`、`checksSkipped`、`cache`。
- 归因取值：移除 `ENV_ERROR`，新增 `UNKNOWN`（无法归因时不猜、不甩锅）。
- CLI：新增 `cache` 子命令与 `verify --prune-cache`；带值参数缺值由「静默」改为 exit 2。
- `attributeFailure(probe, channel, channelName, evidence)` 签名不变；`channelName` 现在真的用于生成判据链。

### 新增测试

- `tests/test_attribution.mjs`（43 项，离线，秒级）
- `tests/test_e2e_regression.mjs`（28 项，真宿主；含打补丁宿主模拟上游取消保留名）
- `tests/test_offline.sh`：46 → 59 项（归因判据结构化 + CLI 契约）

## v0.1.1 — 评审 🔴 必修项修复

> 对应评审结论（PR #2 / 架构·评审）：`disposition = fix_bug`，4 项 🔴 必修 + 7 项 🟡 建议。

### 🔴 必修

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| 🔴-1 | 契约基线被验收过程自己写坏（失败运行 `save({})` 清空基线 → 产出假漂移 + 脏工作区） | 基线**只在通道 `ok` 且契约有效时**更新；`save` 改**合并**写入；**无变化不写盘**；`diffContracts` 对空契约不产生漂移项、无基线记 `newBaselines` | `tests/test_offline.sh` [5]（失败运行后基线不变 / 不产生假漂移 / 仅 ok 通道被更新 / 跳过通道被记录） |
| 🔴-2 | 保留名冲突被静默丢弃（不进 `issues`、不回调 `onIssues`、`toJSON` 无此项） | 冲突进 `issues`（前缀 `reserved_name_conflict:`）+ 触发 `onIssues` + `toJSON().reservedRejected`；探针新增 `guard.reserved_rejected`（插件声明保留名即判失败） | `tests/test_offline.sh` [6]（上报 / 回调 / toJSON / 未注册到宿主） |
| 🔴-3 | `--channel all` 两套语义（CLI = stable+dev，页面 = +legacy） | 统一 `all = stable + dev + legacy`（CLI、`.cnb.yml`、`.cnb/web_trigger.yml`、README、指南一致）；未知通道显式报错 | `tests/test_offline.sh` [7] |
| 🔴-4 | `exports["./detect"]` 指向不存在文件；示例 import 路径不可解析 | 补 `src/detect/index.mjs`；`exports` 增 `./adapter`；修正 `src/index.mjs` 示例；模板加「拷贝后必改」提示 | `tests/test_exports.mjs`（exports 全解析 + 文档 import 路径校验 + 模板拷贝可用） |

### 🟡 建议

| # | 问题 | 处置 |
|---|---|---|
| 🟡-1 | 不支持 `--key=value` | **已修**：支持 `=` 形式；未知 token 显式报错（不再静默忽略） |
| 🟡-2 | pass 项带失败文案 | **已修**：`check()` 文案按 pass/fail 分别措辞（含 `host.tools_ready`、`dispatch.*`、`guard.*`、`compat.*`） |
| 🟡-3 | 归因判据含失效正则；真漂移被误判为插件回归 | **已修**：删除 `register.count/no_issues` 死判据；改为「契约指纹 diff + 漂移字段与失败 check 相关性」判定；无可用基线时保守判漂移 |
| 🟡-4 | 兜底探测有副作用且不清理 | **已修**：探测后立即 `dispose`，记录 `reservedProbeDisposed` |
| 🟡-5 | 负例测试名不符实 | **已修**：探针新增 `guard.reserved_rejected`；`test_hub.sh` 断言负例**必须**因该 check 失败 |
| 🟡-6 | 模板拷贝即坏 | **已修**：模板加 `TODO(拷贝后必改)` 与两种接法说明；`test_exports.mjs` 覆盖「拷贝 + 改 import 后可用」 |
| 🟡-7 | 文档 `allow_slugs` 未落地 | **已修（口径）**：文档明标「未实现，靠 Public + `git clone` 兜底」；RISKS 增 R2b |

### 🟢 优化

- 🟢-1：缓存命中改为**软链**挂载 `node_modules`（不再全量 `cpSync`）；新增 `pruneHostCache()` 清理历史残留。
- 🟢-2：`tests/fixtures/demo-plugin.mjs` 改为再导出 `templates/adapter/index.mjs`（单一事实源，消除双维护漂移）。
- 🟢-3：分层再导出保留（合理设计）。

### 兼容性

- 新增 check：`guard.reserved_rejected`（探针 13 → 14 项）。
- `adapter.register()` 返回值新增 `reservedRejected`（原有字段不变）。
- `verify` 报告新增 `baseline`、`contractDrift.newBaselines` 字段；`summary.contractDrift` 新增。
- CLI：`--channel all` 语义变更（现在含 legacy，与页面一致）；未知通道退出码 2。
