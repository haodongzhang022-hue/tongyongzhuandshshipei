## v0.2.4 · R26 残留边界②（fail-open）登记 + 批 2 首要目标并入

> 承接 v0.2.3。本版由**评审复评 §三/§四**驱动，**只做登记与断言固化，不改判据、不动架构**。
> 结论：评审的更正**成立、已采信**；其 §四 的结构性观察（fail-open）**并入批 2 立项说明与 R26 登记**。
> 两条**均不阻断放行**（评审原话）。

### 一、采信评审的更正（我 §一 表格的表述已更正）

| 项 | 内容 |
|---|---|
| 评审更正成立 | `e381d52` **不是「反读即绿」**；仓内夹具（写 stdout、**不**摘 exit）在 `e381d52` 上确为 **RED**。我原先把「反读 + 摘 exit」简写成一行，**表述不准确**——已更正 |
| 我的 §二 措辞也需更正 | 我写「必须**写对通道 fd3**」——**实测不必**。本仓实测：伪造写 **stdout** + 摘 exit 同样被采信（见下） |
| **真正的使能条件** | **「让探针来不及写自己的报告」**（摘 `exit` 钩子 + `exit(0)` ⇒ 探针 `emit()` 永不执行）⇒ **通道选择不是关键**，**「探针是否来得及 emit」才是关键** |

### 二、R26 残留边界②（fail-open）—— 本轮实测，已登记

| 项 | 内容 |
|---|---|
| 机理（读 `host.mjs` 确认） | `const isolated = channelText.trim().length > 0;` ⇒ `markers = isolated ? matchingOnChannel : matchingOnStdout`。隔离判定是「**fd3 有没有内容**」，**不是**「探针**是否**报告过」 |
| 后果 | 探针**来不及 emit**（被 `exit(0)` 截断）⇒ fd3 为空 ⇒ **回退信任 stdout** ⇒ 带**正确 nonce** 的伪造行成为**唯一** marker ⇒ 无 `injectionEvidence` ⇒ **被采信（`ok=true`）** |
| 实测（本仓，`node` 直调 `interpretProbeStdout`） | 形态 C（伪造写 fd3 + 探针沉默）⇒ `ok=true`；形态 D（伪造写 stdout + 探针沉默）⇒ `ok=true`（**同判**）；对照 A（伪造写 stdout + 探针 emit）⇒ `plugin.protocol_injection` / `ok=false` |
| 定性 | **当前防护实际是「单腿站立」**：唯一有效的是 **nonce 保密性**（stdin 下发 ⇒ 经 env / argv 拿不到）；**通道隔离在探针未 emit 时 fail-open**。一旦插件经**其它同进程手段**（猴子补丁 / 读内存，见 R29）拿到 nonce，C/D 形态**立刻重新变绿** |
| 处置（本轮） | ① `docs/RISKS.md` **R26 残留边界②** 写明（含「使能条件 = 探针是否来得及 emit」与「批 2 首要目标 = 永不回退 stdout」）；② `docs/REDO-PROPOSAL.md` 立项说明并入**首要目标** + 形态表登记 **⑤b**；③ 离线 `test_attribution.mjs` **[9.14]**（14 条）把**现状固化为可执行断言**——批 2 修好即红，强制同步 |
| **不做什么**（显式声明，不越权） | **不改判据**（改判据属批 2 范围：需「独立 fd 且**永不回退 stdout**」，要动架构）；**不阻断放行** |

### 三、评审 §三 的分行判据（已转「架构·测试」，接力卡见 PR #2 评论）

| 断言 | 期望 |
|---|---|
| 仓内 `plugin-nonce-reverse-read-plugin` @ `e381d52` | **RED**（`plugin.protocol_injection`）——**不是** GREEN |
| 仓内同夹具 @ `0ac4ab6` | RED（`plugin.probe_result_forged`） |
| 「反读 + 摘 exit + `exit(0)`」@ `e381d52` | **GREEN**（这才是那条假绿，A/B 用它才拿得到对照） |
| 同形态 @ `0ac4ab6` | RED（`plugin.abnormal_termination`，`hostFatal=[]`） |

> ⚠️ **不要用「仓内夹具 @ `e381d52`」做 GREEN 对照**——会拿不到 GREEN 而误判防线失效。

### 四、测试项数（本版）

- 离线单测 163 项（`tests/test_offline.sh`：**不变**，本版不动探针与判据）
- 归因离线回归 509 项（`tests/test_attribution.mjs`：495 → 509；新增 [9.14] R26 残留② fail-open 现状固化 14 条）
- 归因端到端回归 163 项（`tests/test_e2e_regression.mjs`：**不变**，本版不动判据）
- 发布面自检 43 项（`tests/test_exports.mjs`：**不变**）
- 插件侧闸门 24 项（`tests/gate_plugin_side.sh`：**不变**）

### 五、兼容性与边界

- **无行为变更**：未改任何判据、未改探针与装配器的判定逻辑；只增文档登记与离线断言。
- 版本口径：`package.json` / `src/version.mjs` / `docs/ARCHITECTURE.md` 头部 = **0.2.4**。

---

## v0.2.3 · 批 1.5（复评 🔴-R1/R2 收口）+ 评审复评收口（🔴-A/R30 · 🔴-B 同族假绿收口 · R29 立项）

> 承接 v0.2.2（nonce 通道改 **stdin**）。本版由**两条并行线**的产出**并集**而成，两者均已复核：
> - **批 1.5**（架构·总师复评裁定，锚点 `e381d52`）：可达性口径作废 + 通道可见化（降级不放行）
>   + §3 反例固化 + `exit` 台账 + 计数守卫；
> - **评审复评收口**（锚点 `0ac4ab6`）：🔴-A 探针无 nonce 硬崩（登记 R30）+ 不实缓解措辞
>   + 条件项守卫扩面 + 🔴-B **同族假绿**（加载期捕获 `JSON.stringify` + 退出码交叉）收口 + R29 登记
>   （批 2 进程隔离由「待拍板」升为在办）。
> 批 1 状态 = **`in_progress`**；批 2（进程隔离）**未动工**，待 CP2 人批准。

### A · 批 1.5（可达性口径 / 通道可见化 / 反例固化 / exit 台账）


### 🔴-R1 可达性论断被反证 —— 三处「不可达」口径**作废**，判据改**可证伪**

| 项 | 内容 |
|---|---|
| 反证（复评 §3，三步可复现） | 插件 `readFileSync('/proc/self/environ')` 恢复 nonce → 向 **fd3** 写**带该 nonce 前缀**的 17/17 全绿报告 → `removeAllListeners('exit')` → `process.exit(0)`；当时实测 `ok=true / PASS / GREEN / 17-17 / exit 0` |
| 根因 | `delete process.env[name]` 只清 **JS 侧副本**；**`/proc/self/environ` 仍是 spawn 时的环境快照** ⇒ 「nonce 与被测插件同进程」**不需要读 env 就能拿到** |
| 口径更正（**事实陈述**） | 结构级防线（`plugin.protocol_injection`）要求「**匹配 nonce 前缀**的结果行 ≥2 条 / 出现在 stdout」⇒ **可达当且仅当插件拿得到 nonce**。nonce 经 stdin ⇒ **经 env / argv 不可达**；但**同进程同 uid** 下插件仍可用**其它**手段（猴子补丁 / 读内存）拿到 ⇒ **在真宿主下确实可达**。四处口径（`RISKS.md` R26 / `[9.11f]` / e2e [8e] 注释 / 闸门注释）**均已更正**，回退即红 |
| `[9.11f]` 恒真式 → **可证伪** | 上一版断言是 `PLUGIN_SIDE_CHECKS.includes(...)`（**恒真**，与可达性无关）。现改为两条互为反证的断言：**构造匹配 nonce 的输入 → 判据必须命中**；**去掉 nonce（前缀不匹配）→ 判据必须不命中**（一个「恒判篡改」的实现过不了反向那条） |
| §3 反例**固化** | 新夹具 `tests/fixtures/plugin-host-tamper-poc-plugin.mjs`（反读 nonce + 写 fd3 + 摘 `exit` 钩子 + `exit(0)` 抢跑）**进闸门**，期望**不得** GREEN；实测 `PLUGIN_REGRESSION` / RED / `hostFatal=[]` / 失败项 `plugin.probe_result_forged` + `plugin.abnormal_termination` |

### 🔴-R2 降级静默 —— 通道**可见化** + **降级不得判 PASS**

| 项 | 内容 |
|---|---|
| 缺陷 | `writeResult()` 的返回值被调用点**丢弃**、`out` 里没有通道字段 ⇒ 报告里看不到走的是哪条通道；装配器在「结果通道为空」时**回落 stdout** ⇒ **降级 = 静默把防线关掉**（实测：无 fd3 的离线台 nonce 伪造 + `SIGKILL` ⇒ `ok=true / runCompleted=true / hostFatal=0`，**放行**） |
| 修法 | 探针写报告**前**探测 fd3 可写性（`writeSync(3,'')` 在 fd 未开时抛 `EINVAL`，实测）→ 回报 `resultChannel`（`fd3` / `stdout-degraded`）与 `resultChannelAtStart`（**插件代码之前**的快照）；落进 `verify` 报告与二级信息（Markdown 行内标「⚠️ 通道降级」） |
| 降级**不放行** | 降级时**两种成因分开归因**：① 早探测可写、收尾不可写 ⇒ **插件关/替换了通道** → `plugin.protocol_injection`（RED）；② 早探测即失败 ⇒ **环境**没有 fd3 → `hostFatal[]` ⇒ `UPSTREAM_DRIFT`（AMBER，**不放行**，人须确认）。装配器另置 `resultChannelDegraded` ⇒ `ok=false`（双重收口） |

### 🟡-R3 / 🟡-R4 文档与防线盲区

| 项 | 内容 |
|---|---|
| 计数守卫（🟡-R3①） | `CHANGELOG` **入守卫表**；`check_doc_count` 由 `grep … \| head -1`（**只校验首处**）改为「文件内**所有**匹配处**逐处**比对」⇒「改一处、漏一处」不再能逃（附自证：造「首处对、第二处错」的文件必须判红）。`CHANGELOG` 只守**最新版本段**（历史段记录当时的实际值） |
| 计数漂移修正 | `test_e2e_regression` 149 → **156**、离线 113 → **146**、闸门 20 → **23 项**（17 负例）；M5 行同口径 |
| 编号漂移（🟡-R3②③） | `test_offline.sh` **重复的 `[13]`** → `[18]`（nonce 侧信道段）；新增**段落编号唯一性**守卫 + `[18]` **真实存在**守卫（此前 `INDEX` / `ARCHITECTURE` 指向不存在的 `[18]` 段 = 文档撒谎） |
| `'exit'` 钩子台账（🟡-R4，R23 同族） | `wrapProcessDefenseApis()` 的记账事件与 `checkProcessDefense()` 的身份检查清单均加 `'exit'`，出口③ 钩子**具名登记**（`defenseHandlers.exit`）作身份锚点。收口前实测：干净插件 + `removeAllListeners('exit')` → **不判** `plugin.process_defense_tampered`（**不可判定**）；现新夹具 `plugin-exit-hook-tamper-plugin`（**只摘钩子**，其余健康）**进闸门** ⇒ 判出该项 |

### 兼容性（行为变更，预期）

- `contract.mjs` 新增导出 `RESULT_CHANNEL_FD3` / `RESULT_CHANNEL_STDOUT_DEGRADED`（通道形态唯一事实源）。
- 探针结构化结果新增字段 `resultChannel` / `resultChannelAtStart`；`verify` 报告与二级信息新增
  `resultChannel` / `resultChannelDegraded` / `resultChannelAtStart`。
- `interpretProbeStdout()`：**合成 payload / 老探针无 `resultChannel` 时按原行为**（不追溯判降级）——
  2 参调用的历史行为不变（旧断言不破）。
- 出口③ 钩子由匿名箭头改为**具名** `defenseHandlers.exit`（行为等价，但**可被身份检查**）。

### B · 评审复评收口（🔴-A / 🔴-B / R29 / 措辞与守卫）
> 承接 v0.2.2（nonce 通道改 **stdin**）。本版由**评审复评**（锚点 `0ac4ab6`）驱动，
> 逐条回应 §一–§六；**处置 = 清零 🔴**。总师裁定：① 放行对象 = `0ac4ab6`（改锚转测试）；
> ② 批 2（进程隔离）**由「待拍板」升为在办**（R29 证逐点补不可穷尽）。

### 🔴-A（探针端硬崩 ⇒ 甩锅上游）—— 已收口，登记 R30

| 项 | 内容 |
|---|---|
| 缺陷 | `probe-template.mjs` 在无 nonce 分支用 `PROBE_RESULT_MARKER`，但 **import 列表里没有它** ⇒ 任何不带 nonce 的调用（stdin 不可读 / 手工直跑 / 旧宿主 / 版本错配）抛 `ReferenceError` / rc=1 / **无结构化结果、无相位信标** |
| 后果 | 装配器判 **`UPSTREAM_DRIFT` / `hostFatal[]` 非空** —— 探针**自身**缺陷被报成「上游变了」（本项目定义的最严重失败类，甩锅方是宿主自己） |
| 修法 | 补 `PROBE_RESULT_MARKER` import（一行） |
| 防线 | ① **探针端**回归 `test_offline.sh` [16] 补 6 条（无 nonce：rc=0 / 17 项 / 全绿 / `hostFatal` 为空 / 完成位 true / **不得**归因 `UPSTREAM_DRIFT`）——既有 [13] 只测**解释端**，给探针做不到的承诺开了绿灯；② `test_attribution.mjs` 新增**源码守卫**：探针用到的 `contract.mjs` 导出**必须已 import**（按词元判，回退即红，已做反证）；③ 离线回归台新增 `stdinUnreadable` 形态（**仅回归反证用**） |

### 🔴-B（`JSON.stringify` 未捕获）—— **本形态已收口**（两条并集，各自独立可回退即红）；不逐点补的**定性不变**，登记 **R29** + 批 2 立项

- 独立复现：同缺陷（多注册 `demo_extra`）对照 = **RED / `fails=[registry.exact]`**；打 `JSON.stringify` 补丁 = **`ok=true` / 17 项全 pass / `hostFatal=0`**（真缺陷被绿卡掩盖）。
- 定性：与 R26 同族 —— 凭据（nonce）与通道（fd3）只是**加门槛**，同进程可写**任意全局** ⇒ **逐点补不可穷尽**（上轮 `/proc`，本轮 `JSON.stringify`）。**该判断不变**：下面的两条只闭合**这一个具体形态**。
- **收口（评审「下一步要求 1–4」逐条）**：
  1. **探针加载期捕获引用**（最小修法）：`const STRINGIFY = JSON.stringify`（在**任何插件代码之前**；TDZ 顺序——捕获块必须早于 `expectedTools` 解析，本版实测踩过）且后续**只用**捕获值 ⇒ 同一夹具由「绿卡被采信」回到 **RED / `fails=[registry.exact]`**；
  2. **退出码交叉**（成本最低、正好兜住本形态）：`probeExit` 改为**无条件**记录（旧实现只在 `error || signal` 时赋值 ⇒ 正常非零退出**根本不进报告**），装配器判「报告自称 `ok=true` 而退出码非 0（或带终止信号）」为**内部矛盾** ⇒ 新插件侧 check `plugin.exit_code_mismatch`（不放行）。退出码由探针内存算出、**不经序列化**，报告字节可被替换 ⇒ 两个独立产物互相矛盾即证据；
  3. **新夹具进闸门 + 离线守卫**：夹具 `plugin-stringify-tamper-plugin` 进闸门（15 → **16 负例**）+ 离线 [9.13]（源码守卫 + 行为级 + 合成输入 + 反向护栏 + **变异回退**：A 回退由 B 兜住 / B 回退由 A 兜住）+ `test_offline.sh` [20]（含**双回退复现绿卡**的反证）+ 真宿主 [8g]；
  4. **正文不再声称未实现的防线**：卡里「四重校验」中 `check 名白名单` / `形状下限` **未实现，故不写入正文**（正文与实现一致优先于条目齐备）。
- 残留边界（**不越权承诺**）：能**同时**篡改退出码（`process.exitCode` / 替换 `process.exit`）与报告的插件仍可绕过——离线 [20] 的「双回退」把该形态**跑出来**并断言 `ok=true`。根治 = `docs/REDO-PROPOSAL.md` **批 2 · 进程隔离**（总师裁定**升为在办**，待人批额度后开工）。

### 不实缓解措辞收口（文档/注释与代码相反）

「读到后立刻从 `process.env` 删除（缩小插件侧可见窗口）」是 **env 通道时代**的措辞，代码早已改读 `readFileSync(0)`。**4 处全部收口**（`probe-template.mjs` / `gate_plugin_side.sh` / `test_attribution.mjs` / `test_e2e_regression.mjs`），并改为陈述**实测依据**（env 可被 `/proc/self/environ` 反读 ⇒ 故用 stdin）。

### 🟡（不阻断，本版一并收）

| 项 | 收口 |
|---|---|
| 条件项守卫只覆盖 `ADAPTER_GUIDE` + `INDEX`（`ARCHITECTURE` / `README` 可静默漂移） | 守卫扩到 **`docs/ARCHITECTURE.md` + `README.md`**；且名单匹配改**词元精确**（防 `plugin.probe_result_forgedX` 前缀包含逃逸）。已做三组反证（N 改字 / 名单改名 / README 的 N） |
| `host.mjs:329` 仍裸 `startsWith('__DSH_PROBE__')` | 改用唯一事实源常量 `PROBE_RESULT_MARKER`（同文件两种写法收口） |
| `probe-template.mjs` 未使用 import | 移除 `PLUGIN_PROTOCOL_INJECTION_CHECK` / `PROBE_NONCE_STDIN_CHANNEL`（探针侧未用） |
| 措辞不一致：226 行「三重」vs 84/355「四重」 | 统一为**四重** |
| `REDO-PROPOSAL.md` §6 承诺 `stdout-degraded` 字段（全仓无该字段） | 按**现状**更正陈述（降级行为已实现；**报告字段未落地**，显式标注） |
| `probeNonceChannel` 设了但 `runner` 未透传 | `runner.mjs` 透传 + `secondary.mjs` 报告输出该字段 |

### 测试项数（本版 · **并集后的最终值**）

- 离线单测 163 项（`tests/test_offline.sh`：128 → 163；批 1.5 [19] 四项 × 19 条 + 🔴-A [16] 探针端无 nonce 6 条 + 🔴-B [20] 10 条）
- 归因离线回归 509 项（`tests/test_attribution.mjs`：441 → 509；[9.11f] 可证伪改写 + 口径守卫 + 🔴-A 源码守卫 + [9.13] 🔴-B 段 + [9.11g] 裸字面量守卫 + **[9.14] R26 残留② fail-open 现状固化 14 条**）
- 归因端到端回归 163 项（`tests/test_e2e_regression.mjs`：146 → 163；[8g] §3 反例 + 通道可见化 + 🔴-B 真宿主段）
- 插件侧闸门 24 项（`tests/gate_plugin_side.sh`：21 → 24；负例 15 → **17 份**：+ §3 反例 + exit 钩子 + 猴子补丁序列化）
- 发布面自检 43 项（`tests/test_exports.mjs`：40 → 43；条件项守卫扩面 + 条件项计数 8 → 9 自动跟随）

### 风险登记（本版）

- **R29（HIGH，新增）**：全局改写（猴子补丁）⇒ 放行级假绿。**`JSON.stringify` 这一形态已由「加载期捕获 + 退出码交叉」收口**（残留：同时改退出码仍可绕过，已写成可执行反证）；**逐点补不可穷尽**的定性不变 ⇒ 批 2 为根治。
- **R30（HIGH，新增，已收口）**：探针无 nonce 路径硬崩 ⇒ 甩锅上游。
- **R26（保留）**：残留边界补注「该形态已实测，独立登记 R29」。

### 兼容性

- 🔴-A 是修**崩溃路径**（无行为变更）；🔴-B 有**行为变更**：`contract.mjs` 新增 `PLUGIN_EXIT_CODE_MISMATCH_CHECK`
  （`plugin.exit_code_mismatch`，登记进 `PLUGIN_SIDE_CHECKS` 与 `CONDITIONAL_PROBE_CHECKS` ⇒ 条件项 **8 → 9**，
  文档「另有 N 项」随之更新）；`host.mjs` 的 `probeExit` 由「仅在异常时赋值」改为**无条件记录**（形状不变）。
- `tests/offline-probe-harness.mjs` **新增导出** `runOfflineProbeWithSources()`（可用变异源码跑探针/装配器，
  供「回退即红」的可执行反证；假宿主构造抽成 `materializeWorkDir()` 消除重复）。
- `probe-template.mjs` 的 import 列表**变短**（移除 2 个未用符号）+ **变长**（补 1 个必需符号 + 加载期捕获段）。

## v0.2.2 · nonce 带外通道改走 **stdin**（env/argv 通道可被同进程插件反读，实测放行级假绿）

> 承接 v0.2.1（fd3 结果通道 + R28 判据 + R24 反向反证 + 结构性重做一页方案）。
> 本版**只补一处实测活口**，不重复已完成部分。

### 🔴 活口：env / argv 通道的 nonce 可被同进程插件反读

| 项 | 内容 |
|---|---|
| 机理 | v0.2.0 的 nonce 经 **env 通道**下发（随机环境变量名经 argv `--probe-nonce-env=NAME`、值经 env 传入；探针读到后 `delete process.env[NAME]`）。`delete` 只改 **Node 的环境视图**，**不**改内核里的**进程环境块** ⇒ 插件仍可从 **`/proc/self/environ`** 读回 nonce |
| 我方实测（夹具 `plugin-nonce-reverse-read-plugin`，env 通道下） | **`verdict=GREEN / attribution=PASS / checks=17 / hostFatal=[]`** —— 即「反读 nonce 后伪造带 nonce 的结果行」**被采信**（放行级假绿）。argv 通道同理：nonce 会出现在 `ps` / `/proc/self/cmdline` |
| 修复 | nonce 改经 **stdin** 下发（`stdio[0] = 'pipe'` + `input`）；探针 `readFileSync(0, 'utf8')` 读完**立刻** `process.stdin.destroy()`。stdin 的字节流**不在**进程环境块、也**不在** argv 里 ⇒ 上述两条读取面都不成立 |
| 修复后实测 | 同一夹具判 **`plugin.probe_result_forged` / RED / `hostFatal=[]`**（不再放行） |
| 防线 | 新夹具 **进闸门**（14 → 15 负例）+ 离线源码守卫（`probeSpawnOptions` 断言 stdin 为 pipe / `input` 带 nonce / env **无** `DSH_NONCE*` / argv **无** nonce 参数；探针侧断言从 fd 0 读 + 读完 destroy；**反向**断言 `contract.mjs` 不再有 env 通道 API ⇒ 回退即红）+ 夹具自检（断言两条读取面都真的尝试了） |

> **口径（不越权承诺，与 R26 一致）**：本项收窄的是「从环境块 / argv 反读」这条**具体通道**；
> 探针与插件**同进程、同 uid** 这一结构性事实下，插件仍可篡改**其它**全局
> （猴子补丁 `JSON.stringify` / 直接读探针内存）。彻底隔离需**进程级**方案
> （见 `docs/REDO-PROPOSAL.md` 批 2，待总师裁定）。故**不得**宣称「报告不可伪造」。

### 兼容性（行为变更，预期）

- `contract.mjs`：**移除** `PROBE_NONCE_ENV_ARG_PREFIX` / `probeNonceEnvNameFromArgv`；
  `createProbeNonce()` 返回值由 `{envName, value}` 收窄为 `{value}`；**新增**
  `PROBE_NONCE_STDIN_CHANNEL`（通道形态的唯一事实源）。
- 生产路径与离线回归台**同构**（都经 `probeSpawnOptions()`），故「通道拼装」这一层在离线侧也被覆盖。

### 测试项数（本版）

- `tests/test_offline.sh`：129 → **128 项**（通道形态断言由「env 名随机」改为「stdin 通道」）
- `tests/test_attribution.mjs`：430 → **441 项**（[9.11e] 通道形态守卫 11 条 + 夹具自检）
- `tests/test_e2e_regression.mjs`：**146 项**（不变）
- `tests/gate_plugin_side.sh`：20 → **21 项**（负例 14 → **15 份**：新增反读形态）
- `tests/test_exports.mjs`：**40 项**（不变）

## v0.2.1 · 信任边界**显式前提** + 🔴-1 **反向反证** + 结构性重做一页方案

> 承接 v0.1.9d / v0.2.0（🔴-1 killSignal + R26 协议注入 + R28 防线自检 + nonce/fd3 两条防线）。
> 本版补总师 §5「开发下一步」中**尚未落地**的三项：① 结构性重做**一页方案**（§5-2）；
> ② 信任边界写成**显式前提**并同步对外限定词（§3-Q2）；③ 把 🔴-1 的「为什么必须 SIGKILL」
> 变成**机器可检的反向反证**（§5-1）。**不重复**已完成部分（🔴-1 修法 / nonce / fd3 / 🔴-5 / 🟡-3）。

### 🟡-4 信任边界 → 写成**显式前提**（总师 §3-Q2）

已有 nonce 带外通道 + fd3 通道隔离（挡「**无意**的自我发绿卡」），但**前提本身**仍是隐式的。
本版按 §3-Q2 显式化：

- `docs/RISKS.md` **R26** 的「显式前提」由行内补注升级为**可检索的显式声明**；
- **对外主张加限定词**：README / ARCHITECTURE / ADAPTER_GUIDE 三处新增「架构前提」段——
  **不得**在缺少该前提时宣称「报告可信」；并声明**本中台是验收工具、不是沙箱**、指向
  `docs/REDO-PROPOSAL.md`；
- 防线：离线 **[14]** 29 条——R26 必须登记（HIGH + 显式前提 + 根治方向 + 三条形态）、
  三份对外文档必须显式声明前提、声明「不是沙箱」、指向 R26/REDO-PROPOSAL、
  **不得**出现**无限定**的「报告可信 / 归因可信」（改回无限定即**红**）。

### 📄 结构性重做 · **一页方案**（总师 §3-Q1 / §5-2：先出方案再动手）

新增 `docs/REDO-PROPOSAL.md`（**只出方案，不动代码**）：
① 问题（四条形态 → 共同根因：报告与信标都走**被测插件可写的输出面**、且凭据与被测方**同进程**）；
② 目标 / **非目标**（不做安全沙箱、不防全面恶意对抗、不改插件可见行为）；
③ 两候选：**A · 独立 fd 作真·带外通道 + 一次性 nonce**（**已在 v0.2.x 落地**）/
  **B · 进程隔离**（**待立项**，根治 R26 与出口④）；④ 决策矩阵；⑤ 推荐 **C = 批 1 已落地 → 只立项批 2**；
⑥ 风险与回滚（fd3 不可用 → **显式降级**并标 `stdout-degraded`，不静默）；⑦ **待总师裁定**三项。

### 🔴-1 / R24 **反向反证**（把「为什么必须 SIGKILL」变成机器可检）

原有 [17] 只断言「SIGKILL 下有界」。本版补**反向反证**：同一形态的**有界**占死夹具
（`plugin-busy-loop-hang-plugin`，占死时长 > 外层超时，`DSH_BUSY_LOOP_MS` 可收窄）改用
**旧口径 SIGTERM** ⇒ 耗时**随插件占死时长走**（超时形同虚设）。两条断言为相对量（< / ≥ 2×timeout），
与正向断言构成对照，**差异只来自 `killSignal`** ⇒ 排除环境噪声。

实测（本机 node:22，timeoutMs=1500、占死 6000ms）：SIGKILL **1510ms** / `signal=SIGKILL`；
SIGTERM **6251ms** / `signal=null`。

另：终止信号收敛为**唯一事实源** `src/harness/host.mjs` 的 **`CHILD_KILL_SIGNAL`**——
`probeSpawnOptions`（探针）+ `npm install` 两处共用；离线回归台改为**镜像** `probeSpawnOptions`
（不再自造一套），并可传 `killSignal` 做反证。离线 [14] 五条源码守卫（回退成默认 SIGTERM 即红）。

### 测试项数（本版）

- `tests/test_offline.sh`：113 → **129 项**（[17] 反向反证 5 条）
- `tests/test_attribution.mjs`：401 → **430 项**（[14] 信任边界显式前提 + 重做方案 + 源码守卫 29 条）
- `tests/test_exports.mjs` **40 项** / `tests/test_e2e_regression.mjs` **146 项**（该版实测值；原文误记 149，属并行线 `57969b8` 的值，merge 后已变 146——已按 🟡-R3① 修正）/ 闸门 **20 项**（均不变）

### 兼容性

- `host.mjs` 新增导出 **`CHILD_KILL_SIGNAL`**（`'SIGKILL'`）；`probeSpawnOptions` 新增可选
  `killSignal`（**仅回归反证用**；生产路径不传，默认即该常量）。
- 新增文档 `docs/REDO-PROPOSAL.md`（**待拍板**，不改变任何行为）。
- 健康插件不受影响（闸门防过度修正仍在）。



## v0.2.0 · **复评 🔴 收口** —— 🔴-1 CI 级回归 + 🆕 nonce 带外通道（侧信道）+ 命名口径/闸门防线

> 承接 PR #3 复评（评审对交付 SHA `0b06398` 的裁定：7 🔴 / 4 🟡）。本轮按总师裁定执行：
> 先修 🔴-1（会挂死 CI），再落 🆕 nonce 必修，并把 🔴-5 / 🟡-3 的**防线**补回。

### 🔴-1【CI 级回归，最先修】`execFileSync(timeout)` 对「同步占死事件循环」插件失效

| 项 | 内容 |
|---|---|
| 机理 | `execFileSync` 的 `timeout` 默认只发一次 **SIGTERM**；而探针为出口③装了 `SIGTERM`/`SIGINT` 处理器 ⇒ ① 监听器存在即**替换** Node 默认终止行为；② 插件同步占死事件循环时信号处理器**不可达**（回调排不上）⇒ 探针杀不死 ⇒ `execFileSync` 无限等待 |
| 后果 | **CI 挂到流水线上限**（`CNB_PIPELINE_MAX_RUN_TIME`）。实测 `while(true)` + `timeoutMs=5000` → 45s+ 未返回；base `main@d2cd96c` 同场景 5.0s 有界返回 |
| 修法 | 宿主侧**探针**与 **npm 安装**两处 `execFileSync` 均加 `killSignal: 'SIGKILL'`——SIGKILL **不可捕获**，探针的信号处理器拦不住它 ⇒ `timeoutMs` 重新成为**有界**承诺（实测 5.01–5.07s 有界返回） |
| 回归 | 离线 `test_offline.sh` **[17]**：新夹具 `plugin-event-loop-hog-plugin`（**永久**占死事件循环）+ `timeoutMs=5000` → 断言「< 20s 有界返回 + signal=SIGKILL + 归因 PLUGIN_REGRESSION」。短 timeout，**不进闸门**、不吃满 CI 额度 |

### 🆕 nonce 带外通道（🔴-4 必修 + 🟡-4 信任边界显式化）

| 项 | 内容 |
|---|---|
| 缺口 | 探针与插件**共用 stdout + 同进程**：插件 `process.stdout.write('__DSH_PROBE__{绿卡}')` 即可自我发绿卡（实测：真实缺陷插件 → **GREEN**）；写 `hostFatal:[...]` 可把责任甩给上游（实测 AMBER / `UPSTREAM_DRIFT`）。**base 同样可复现**（既有缺口，见 `docs/RISKS.md` R26） |
| 协议 | 宿主每次运行生成**随机** nonce，经 **stdin** 下发（探针 `readFileSync(0)` 读完**立刻** `process.stdin.destroy()`）；输出 `__DSH_PROBE__<nonce>:{json}`；宿主**只认带该 nonce 的行**。<br>⚠️ **通道形态（本版加固，实测依据）**：本仓曾并行落地 **env 通道**（随机环境变量名经 argv、值经 env 传，探针 `delete process.env[NAME]`）。**实测可被同进程插件反读**——`delete` 只改 Node 视图，内核环境块不变，插件仍能从 **`/proc/self/environ`** 读回 nonce（夹具 `plugin-nonce-reverse-read-plugin` 在 env 通道下判 **GREEN / PASS / 17 项**）；argv 通道同理出现在 `ps`。stdin 不在环境块、不在 argv ⇒ 两条读取面都不成立（同夹具在 stdin 通道下判 RED） |
| 判定 | 出现裸 `__DSH_PROBE__`（无 nonce / 不匹配）⇒ 判**伪造**：落插件侧 check **`plugin.probe_result_forged`**（登记 `PLUGIN_SIDE_CHECKS` + `CONDITIONAL_PROBE_CHECKS`，条件项 6 → 7），`result.ok` 必为 false |
| 显式前提 | 「**插件为可信代码**」由 R26 写成**显式前提**（此前是隐式）。nonce 挡的是「无意的自我发绿卡」「共用输出面的误命中」「从环境块 / argv 反读」，**不是**「恶意插件」（同进程同 uid 下的一切篡改需进程级隔离）——根治需**进程隔离**（结构性重做，待人拍板，见 `docs/REDO-PROPOSAL.md`） |
| 回归 | 离线 `test_offline.sh` **[13]**（伪造即判 / 不放行 / 真报告不误伤 / 无 nonce 退化路径 / 名字与值都随机）+ 新夹具 `plugin-forged-result-plugin` → **进闸门**（真宿主失败项集合含 `plugin.probe_result_forged` 且真缺陷 `registry.exact` 仍被抓）+ 真宿主 E2E `[8d]` |

### 🔴-5 命名口径守卫（合并不得再丢防线）

- 事实澄清：`PROBE_CHECK_ORDER` / `CONDITIONAL_PROBE_CHECKS` / `plugin.async_uncaught_exception` 在**分支 HEAD `16714ca`** 上**均存在**（`0b06398` 上确实缺失，那是并行尝试的中间态）。本轮把它们变成**跨产物守卫**：
  - 新增离线 **[12]**：三张 check 表并集 == 顺序表 ∪ 条件项；**扫描夹具 / 闸门 / 文档**里出现的 check 名，未登记即红；并自证「旧实现遗留名 `plugin.probe_aborted` 会被判未登记」。
  - 修掉夹具里两处**遗留的错名**（`plugin.probe_aborted` → `plugin.early_exit`，与实现逐字一致）。

### 🟡-3 闸门失败项集合断言

- 此前闸门只断「失败项**含**期望项」⇒ 夹具多出的**噪音失败**（如 `render: () => []` 造成的 `dispatch.render_projected`）被**静默放行**。
- 现在 `tests/gate_plugin_side.sh` 的 `NEGATIVE_CASES` 增加第 5 列「**完整失败项集合**」，逐夹具**排序后逐字比对**：多一条少一条都红（取值来自真宿主实测）。

### 🟡-4 / R24b / R26 登记（风险显式暴露）

- `docs/RISKS.md` 新增 **R24b**（🔴-1 的 CI 级回归，标「已收口」）、**R26**（信任边界：共用 stdout + 同进程，**HIGH**，含残留边界与显式前提）。


## v0.1.9d · **放行级假绿收口（续）**（与 v0.2.0 **同批合并**：并行一线的并集） —— R26 协议注入 + R28 防线自检判据 + R24 宿主二次终止 + R27 口径守卫加固

> 承接 v0.1.9c（H1 收口）。评审复评 @ `ab85c82` 裁定：**R26 与 H1 同级**（都是**放行级**假绿），
> 必须一起排进 v0.1.9；R24 的修法从「`worker_threads` 大改」**降级为一行 `killSignal`**（根因定位后）。
> 本版按 **M1 → M3 → M2 → M5 → M4 → M6** 落地，**不改架构**，只补防线与口径。

### 🔴 M3 · R26 协议注入 → 放行级假绿（**与 H1 同级**）

| 项 | 内容 |
|---|---|
| 机理 | 装配器 `stdout.split('\n').find(l => l.startsWith('__DSH_PROBE__'))` 取**第一条**结果行，而结果与日志**共用 stdout** ⇒ 插件在 `apply()` 里 `writeSync(1, …)` 一条伪造报告即**抢到首位**，探针的真报告被忽略；且装配器**不校验结果行条数**（正常恒为 1 条） |
| 实测 | ① 天真伪造 ② 伪造 + 真缺陷（不注册工具）+ 压回 `exitCode=0` ③ 伪造**合法**报告（用文档公开的 17 个真 check 名）→ 真宿主下均 **GREEN / PASS / 17 项（放行）**；④⑤ 伪造 `hostFatal[]` / 畸形 marker → AMBER（甩锅上游） |
| 修法 **A**（结构不变量） | `interpretProbeStdout()` 统计结果行条数：**≥2 条即判篡改** → 插件侧 check **`plugin.protocol_injection`**（进 `PLUGIN_SIDE_CHECKS` + `CONDITIONAL_PROBE_CHECKS`，条件项 6 → **7**）、`runCompleted=false`、`ok=false`、`hostFatal[]` 为空、**不采信任何一条**（`find(first)` 只作末位兼容） |
| 修法 **B**（通道隔离） | 探针结果改走**独立 fd3**（`host.mjs` 由 `execFileSync` 改 `spawnSync` + `stdio: ['ignore','pipe','inherit','pipe']`，`writeSync(3, …)`；fd3 不可用时回退 stdout）⇒「stdout 里出现结果行」**本身**即篡改证据（第二条独立证据链） |
| 为什么 C/D 不作防线 | **C**（一次性 nonce）挡不住同进程读 `process.argv` 的有心插件（评审实测）；**D**（check 名白名单）挡不住用**公开真名**的伪造（形态③） |
| 反向护栏 | 正常路径（fd3 1 条 / stdout 只有日志）**不误判**；fd3 缺省（2 参调用）时行为与 v0.1.9c **完全一致**（老装配器 / 直接跑探针不破）；相位信标不被误当结果行 |

### 🔴 M1 · R28 防线自检判据不可判定（H1 修法 A 的**假阳性**）

评审实测：`hasUncaughtExceptionCaptureCallback() || listenerCount('uncaughtException') > 0` 在插件
**用自己的回调顶替**我们的 handler 后：`has=true`、`count=1` ⇒ 该式**恒真** ⇒ 判「防线有效」，
而实际后台抛错已被插件自己的 handler 吞掉。⇒ 判据升级为**四重**（`checkProcessDefense()`）：

| # | 判据 | 挡住的形态 |
|---|---|---|
| ① | **wrap** `setUncaughtExceptionCaptureCallback` / `removeAllListeners` / `removeListener` / `off` **记账**（探针启动、任何插件代码之前；只记**插件集成相位**，防误伤宿主装配段） | 插件抢占 capture API / 摘监听器（真实形态：Sentry / APM / 日志库） |
| ② | **身份检查**：我们的 handler 仍在 `process.listeners(event)` 内 | 插件**用自己的回调顶替**我们的（**计数判据在此假阳性**） |
| ③ | 独占 API 存在（`hasUncaughtExceptionCaptureCallback()`，**独立**篡改信号，**不与计数做 `\|\|`**） | capture callback 存在 ⇒ 监听器不再被调用（Node 官方语义） |
| ④ | **行为级 canary**：临时监听器 + `process._fatalException`（**真实派发路径**） | 「监听器还在但不会被调用」的形态；不可用时**自动跳过**（不误报） |

- canary 哨兵用 **Symbol** 标记（不可外部伪造）⇒ 避免「插件抛一个同名消息的错误即可静音自己」的新活口；
- **为什么不用 `process.emit('uncaughtException', …)`**：实测在存在 capture callback 时**仍会调用监听器**
  （capture-callback 分支在内部派发函数里）⇒ 对「被静音」**无判别力**（假阴性）。改用 `_fatalException`
  并显式声明依赖内部入口（不可用即跳过）。
- 新夹具 **`plugin-defense-tamper-plugin.mjs`**：摘掉探针兜底后**再装自己的**（`listenerCount === 1`，
  旧判据假阳性）→ 收口后判 `plugin.process_defense_tampered`、`hostFatal=0`、完成位仍 `true`。

### 🟠 M2 · R24 宿主二次终止（**一行** + 影响列更正）

- `host.mjs` 抽出 `probeSpawnOptions()`（**唯一事实源**）并在其中加 **`killSignal: 'SIGKILL'`**：
  根因是**探针自己装了 `SIGTERM` 处理器**（出口③）⇒ Node 默认终止行为被禁用 ⇒ SIGTERM 杀不掉探针
  （实测 timeout=5000 却耗时 30.3s；`while(true)` 形态永久挂死）。
- **影响列就地更正**：有相位信标时**不会**判 `UPSTREAM_DRIFT`（死循环在 `apply()` 内、信标已打）
  → `PLUGIN_REGRESSION` / `plugin.abnormal_termination`；只有「插件**模块顶层**死循环」才落 `UPSTREAM_DRIFT`。
- **取舍显式声明**：超时路径**失去优雅报告**（只剩信标归因）；正常路径不受影响（`RUN_WATCHDOG_MS` 20s
  先于 `timeoutMs` 600s）。
- 新夹具 `plugin-sync-loop-plugin.mjs`（**3s** 循环，不吃满 CI）。

### 🟡 M5 · 归因落点口径（闸门断言不再写死 check 名）

闸门期望从「固定 check 名」改为「失败项 **⊆** `PLUGIN_SIDE_CHECKS`」（名单**从唯一事实源 import**），
并把「必须命中的那一项」降为**可选**加强断言（`-` 表示该夹具落点不固定）。
理由：`process.exit(0)` 的落点实测是 **`plugin.apply_ok`**（不是 `plugin.early_exit`），
固定名断言依赖**夹具细节**（`plugin-exit-plugin` 因先注册健康工具才恰好命中）。

### 🟡 M4 · R27 口径守卫加固

- **命题扩为两条**：`不进 hostFatal` **与** `一律/都/必然 落 check`（后者才是 H1/R26/R28 推翻的**完整性主张**）；
  另覆盖**主谓倒置**与**英文**形态；
- **同义词组**：`永远|永不|绝不|决不|从不|一律不` / `一律|都|必然|一定`；
- **豁免改为「必须同段引用收窄前提」**——去掉 `不得` 这类单独豁免词（旧守卫把豁免词与前提写成 `\|\|`，
  于是 `…永远不进 hostFatal[]（不得有例外）` 能骗过守卫，**正是它要防的东西**）；
- **段落级**（而非逐行）：前提写在上一行、主张写在下一行不再漏（按空行 / 空注释行 / Markdown 表行切段）；
- `DOC_FILES` 增 **`docs/INDEX.md`**（此前不在表内 = 漏守）与 **`src/harness/host.mjs`**（**装配器**——
  R26 的成因就在它的注释里）。

### 测试项数（与 v0.2.0 合并后的最终口径）

- `tests/test_offline.sh`：117 → **124 项**（[18] v0.1.9d R28 / R24 两形态 × 7）
- `tests/test_attribution.mjs`：329 → **401 项**
- `tests/test_e2e_regression.mjs`：130 → **146 项**
- `tests/gate_plugin_side.sh`：13 → **20 项**（负例 12 → **13 份** + R24 专用段 6 条 + 防过度修正；`plugin-protocol-injection-plugin` **不进闸门**——其结构级形态在真宿主不可达，见 RISKS R26「可达性边界」）
- `tests/test_exports.mjs`：**40 项**（不变）
- `tests/test_hub.sh`：**PASS=25 FAIL=0**

### 测试项数（本版原始口径，供对照）

- `tests/test_attribution.mjs`：314 → **387 项**（[9.10] R28 判据 / 反证 / 夹具自检；[9.11] R26 协议注入
  （A 行为 + B 通道隔离 + 向后兼容 + 信标不误命中 + spawn 参数 + 夹具自检）；[9.12] R24 行为级
  （SIGKILL 收口 + 信标归因 + 反向护栏）；[11] 口径守卫扩条：命题 1 → **2**（新增「一律落 check」完整性主张）、
  同义词组、主谓倒置 / 英文形态、**同段前提**（去 `不得` 豁免词）、`DOC_FILES` 8 → **10**，含 12 种绕过形态逐条自证）
- `tests/test_offline.sh`：103 → **113 项**（[16] 新增 R28 / R26 / R24 三形态 × 10 条）
- `tests/test_e2e_regression.mjs`：124 → **149 项**（[8d] R28 / R26 真宿主 × 11 + [8e] R24 真宿主 8 条）
- `tests/gate_plugin_side.sh`：11 → **20 项**（负例 10 → **13 份**（+`plugin-defense-tamper` / `plugin-forged-result`）
  + **R24 专用段 6 条**（含反向护栏）+ 防过度修正）
- `tests/test_exports.mjs`：**40 项**（不变；条件项计数 6 → 7 由既有守卫自动跟随）
- `tests/test_hub.sh`：**PASS=25 FAIL=0**（含 113 / 387 / 149 三处计数对齐）

### 兼容性

- `contract.mjs` 新增导出 `PLUGIN_PROTOCOL_INJECTION_CHECK`；`CONDITIONAL_PROBE_CHECKS` 6 → **7 项**；
  `PLUGIN_SIDE_CHECKS` 新增一项；`host.mjs` 新增导出 `collectProbeResultLines` / `probeSpawnOptions`。
- **行为变更（预期）**：① 向结果通道注入伪造结果的插件，从此判 `PLUGIN_REGRESSION`/RED（此前 **GREEN 放行**）；
  ② 摘掉探针兜底再装自己的插件，从此判 RED（此前**放行**）；③ 同步死循环插件在**有界 timeout** 下
  按 `SIGKILL` 收口（此前挂死/吃满额度）。三条都是**修复**，不是回归。
- 健康插件**不受影响**（闸门含防过度修正断言：`demo-plugin` 仍 17/17 GREEN / 完成位 true）。

### 口径（**不得**恢复绝对措辞）

H1 已收口，但 R23（防线可被单方面撤销）是**结构性**事实，本版又新增 R26（协议注入）与 R28（自检判据），
故「**在探针进程内防线未被插件干预的前提下**」这一前提**永久保留**；CHANGELOG / 文档 / 代码注释
**不得**出现「永远 / 永不」类绝对口径（由 [11] 守卫）。



## v0.1.9c · **H1 放行级假绿收口** —— 探针收尾自检进程内防线 + 夹具进闸门

> 承接 v0.1.9b（口径收窄）。v0.1.9b 把 H1 记为**已知活口**（`docs/RISKS.md` R22，夹具不进闸门）。
> 本版**把 H1 修掉**——因为它是**放行级**缺陷（判 `GREEN` 放行），比 AMBER 危险得多：
> AMBER 至少是红的、有人看。

### 🔴 H1 收口（放行级假绿）

| 项 | 内容 |
|---|---|
| 机理 | `process.setUncaughtExceptionCaptureCallback(cb)` 一旦设置，`uncaughtException` **监听器不再被调用**（Node 官方语义）⇒ 探针出口②（进程级异步异常兜底）被**静音** ⇒ 插件后台抛错完全不可见、`run()` 正常收尾、完成位仍真 ⇒ **GREEN / PASS 放行** |
| 真实形态 | 插件（或其依赖）引入 Sentry / APM / 错误上报 / 日志库，初始化时抢占该**独占** API——**不是**刻意攻击，是普通工程实践 |
| 修复 | 探针收尾（`emit()` 内、**写出报告之前**）自检：① `process.hasUncaughtExceptionCaptureCallback()` 为假；② 两个监听器 `listenerCount > 0`。任一不成立 → 判插件侧 check **`plugin.process_defense_tampered`**（登记 `PLUGIN_SIDE_CHECKS` + `CONDITIONAL_PROBE_CHECKS`，条件项 5 → 6），**绝不**写 `hostFatal[]`；`out.ok` 随之必为 `false` |
| 为什么**两条都查** | 只查 capture callback → `removeAllListeners('uncaughtException')` 可绕过；只查监听器计数 → capture callback 可绕过（回调存在时监听器**仍在**，但**不被调用**）。任一单查都是活口搬家 |
| 为什么**不**抢占该独占 API | 探针若启动时抢占，插件引入的 Sentry / APM 会在初始化时直接抛 `ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET`——那是把「探针的诊断能力」变成「插件的运行障碍」（改变插件可见行为）。改用**收尾自检**：不改变插件可见行为，只把「防线是否仍有效」变成**可判定** |
| 只在插件集成相位判 | 宿主装配段探针自己还没装监听器、还没跑插件代码，判了会**误报**（健康插件被判红 = 过度修正） |

**防线**：
- 新增夹具 `tests/fixtures/plugin-capture-callback-plugin.mjs`（H1 一行复现：抢占 API + 后台抛错）→ **进闸门**（10 负例）：断言 `PLUGIN_REGRESSION` / `hostFatal` 为空 / **`verdict=RED` 不得 `GREEN`** / 完成位仍 `true`（探针**确实跑完了**——它只是**不知道**自己被静音了）。
- 离线 `[9.4e]` 源码守卫 8 条：自检存在 / **两条都查** / 在 `out.ok` 判定**之前** / 只在插件集成相位 / 落点已登记 + 夹具自检 3 条。实测「删掉监听器计数检查」即**红**。
- 文档：两份条件检查表补 `plugin.process_defense_tampered`；「另有 N 项」由 `test_exports.mjs` 按 `CONDITIONAL_PROBE_CHECKS.length` 反推（5 → 6，改一处漏一处即红）。

**残留边界（不越权承诺，与 R23 一致）**：本项**只能在探针还活着时**判。插件若让探针**整个进程**消失（`SIGKILL` / `process.exit` / 挂住），本项同样来不及判——那时由出口③④ 或装配器按相位信标归因。**故措辞保持收窄，不恢复「永不」**。

### 🟡 同批修：`[2b''']` 自证空转（实测逃逸）

上一版对**整份文档**做 `replace(dropped, ...)` 做「删一项」变异：条件检查名在别处（索引行）也出现时，变异只改第一处、`includes()` 仍命中 ⇒ **自证断言空转**。改为**按条件检查表段落**变异（表头 `| 条件检查 |` 锚定 → 切段），并把反证**自造**成「名字出现两次」的文本（不依赖当前文档恰好如此，避免反证自身成为漂移源）。

### 测试项数（本版）

- `tests/test_attribution.mjs`：296 → **314 项**（[9.4e] H1 防线静音守卫 8 条 + 夹具自检 3 条；[9.4] 兜底区切片守卫；[9.4d] 报告完整性；[11] 口径守卫随 H1 收口同步断言）
- `tests/test_exports.mjs`：33 → **40 项**（[2b'''] 段落级自证与反证 7 条）
- `tests/gate_plugin_side.sh`：8 → **11 项**（负例 7 → **10 份** + 防过度修正）
- `tests/test_offline.sh`：103 项（不变）
- `tests/test_e2e_regression.mjs`：124 项（不变）

### 兼容性

- `contract.mjs` 新增导出 `PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK`；`CONDITIONAL_PROBE_CHECKS` 5 → **6 项**；`PLUGIN_SIDE_CHECKS` 新增一项。
- **行为变更（预期）**：插件抢占 `setUncaughtExceptionCaptureCallback` / 摘掉进程级监听器，从此判 `PLUGIN_REGRESSION`/RED（此前判 **GREEN 放行**）。这是**修复**，不是回归。
- 健康插件**不受影响**（闸门含防过度修正断言：`demo-plugin` 仍 17/17 GREEN / 完成位 true）。

## v0.1.9b · 口径收窄 + 风险显式化 + 口径守卫（本轮，**非行为改动**）

> 起因：评审复评 @ `c8965b9` 的裁定——**最高优先项不是写代码，是收窄文档**：
> 中台的核心价值主张是「归因可信」，**文档撒谎的代价 > 代码有洞**。
> 复评实测 **H1 放行级假绿**（`setUncaughtExceptionCaptureCallback` 静音探针防线 → `GREEN` 放行）
> 直接推翻 v0.1.7 / v0.1.8 的对外主张「插件侧错误**永远**不进 `hostFatal[]`」。
> 本补丁**只改口径与风险记录 + 加守卫**，**不动行为**（代码修复留 v0.1.9 修法 A/B/D）。

| # | 处置 | 落点 |
|---|---|---|
| 1 | **不变量措辞收窄**：`插件侧错误**永远**不进 hostFatal[]` → `**在探针进程内防线未被插件干预的前提下**，插件侧错误不进 hostFatal[]`（**不得**再写「永远 / 永不」） | `src/harness/contract.mjs`（`HOST_FATAL_FIELD` JSDoc，唯一事实源）· `docs/RISKS.md` R19 · `docs/ARCHITECTURE.md` §4.2 ③ · `docs/ADAPTER_GUIDE.md` · `README.md` · `.cnb.yml` 注释 · 3 份夹具注释 · `tests/test_e2e_regression.mjs` · `CHANGELOG`（v0.1.7/v0.1.9 历史口径**就地更正**，不删历史） |
| 2 | **补 4 条风险行（含本轮新实测）**：R22 **H1 放行级假绿**（HIGH）· R23 探针进程内防线可被插件单方面撤销 / 静音 · R24 **宿主 `execFileSync(timeout)` 对「同步死循环」插件失效**（本轮新发现，见下）· R25「排空窗口之外的延迟抛错 → 该插件判 GREEN」的**后果**（复评 §六 要求写明） | `docs/RISKS.md` |
| 3 | **新增口径守卫**（`tests/test_attribution.mjs` **[11]**，19 条）：8 份文档 / 源码 / 闸门脚本出现「插件侧错误永远 / 永不进 hostFatal」**绝对口径**即**红**（说明性更正行豁免，但必须同时引用收窄前提）；并断言 RISKS 记录 R22–R25、H1 夹具存在且自述指向 v0.1.9 | 离线回归 [11] |
| 4 | **固化 H1 复现夹具** `tests/fixtures/plugin-capture-callback-plugin.mjs`（一行 `setUncaughtExceptionCaptureCallback` + 后台抛错）——**当前形态判 GREEN**，作为 v0.1.9 修法 A 的验收资产；**不进 CI 闸门**（进了就是红，那正是 H1 未修的证明） | 夹具 + [11] 三条断言 |

**本轮新发现（复评 §二 之外，已实测）**：

- **[MEDIUM] R24 · 宿主 `execFileSync(timeout)` 对「同步死循环」插件失效**：探针的看门狗与信号处理器都是**事件循环**上的回调，插件 `apply()` 同步死循环占满事件循环后**两者都不执行**；而探针为出口③装了 `SIGTERM`/`SIGINT` 处理器 → Node 默认终止行为被禁用 → **宿主杀不掉探针**。实测：`apply` 同步循环 30s + `runHostProbe(timeoutMs=5000)` → 实际耗时 **30.3s**（不是 5s），且 `hostFatal` 非空 / `checks=1`；`while(true)` 形态下宿主**永久挂死**（外层 45s timeout 命中）。
- **R25 边界实测**：健康插件 + `setTimeout` 抛错 —— 30 / 100 / 150 / 200 / 250 ms → `RED`（`plugin.async_uncaught_exception`，`hostFatal=0`）；**300 ms / 2000 ms → `GREEN / PASS / 17 项`**（该插件判**通过**）。故**不得**按「50ms 窗口」字面承诺边界。
- **H1 复核（当前 tip 仍复现）**：`plugin-capture-callback-plugin` 连跑 3 次 → `GREEN / PASS / 17 项 / hostFatal=0 / completed=true`；H1 的 SIGKILL 变体（captureCallback + `kill -9`）仍被相位信标正确归因插件侧（`plugin.abnormal_termination`）——**说明信标路径不受 H1 影响，H1 只影响出口②**。
- **H3 复核（当前 tip）**：伪造 marker（含伪造 `runCompleted: true` + 17 项全绿）+ 真违规 → `verdict=UNKNOWN`（不放行），但**归因未落到插件侧**（评审 H3 的「协议注入」仍在：装配器 `find(startsWith)` 取第一条）。**既存，v0.1.9 修法 D**。

**自测（全绿）**：离线单测 103/103 · 归因离线回归 296/296（[11] 新增 19 条）· 发布面自检 33/33 · 真宿主端到端回归 124/124 · 闸门 `tests/gate_plugin_side.sh` 8/8。

**范围口径（按评审 §四 表）**：

- v0.1.9b（本段）：可合并，**不宣称清零**；措辞已收窄。
- 后续顺序：**H1（放行级假绿）→ H2 → H3 → 🟡-1 正则盲区**。
- **H1 已在 v0.1.9c 收口**（见下节）：`plugin.process_defense_tampered` 收尾自检 + 夹具进闸门。
  措辞仍**保持收窄**（H2 / H3 未修，且 R23「防线可被单方面撤销」是**结构性**事实）——
  「永不 / 永远」这类绝对口径**不恢复**。

## v0.1.9 — 🔴 必修-1/2/3 收口：**完成位** + 进程 exit 出口 + `run()` 被拖住（四条出口逐条闭合）

> 承接 v0.1.8（异步异常兜底）。评审 @ `c8965b9` 判 `disposition = fix_bug`（**第 6 次回转 = 硬上限**）：
> 异步活口已收口 ✅，但同一失效族仍有**三条**未闭合——且其中一条被「修一半」后会产生**假绿**。
> 评审 §五 把总师的「可穷举 3 出口」修正为 **4 个**：① `run()` try/catch ② 异步异常 ③ 进程 `exit`
> ④ **`run()` 被插件拖住**。②③④ 同属单一进程边界，本版**一次修完**。

### 🔴 必修（本轮清零）

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| **必修-1** | **完成位缺失**（总师点名「必须」）。`emit()` 的 `ok` 只看 `errors.length === 0`，而出口 ③ 的兜底会在验收**中途**输出报告——此时「还没跑到」的检查一律是 `skip`（不是 `fail`）⇒ 一个在 `apply()` 里 `process.exit(0)` 的插件会拿到 **GREEN / PASS / checks=6 的假绿**（比 AMBER 更危险：AMBER 至少不放行）。评审实测：只加 `exit` 钩子而**不带完成位** = 用一个 HIGH 换一个 MEDIUM | `runCompleted` **只在 `run()` 正常返回后**置真；`emit()` 的 `ok = runCompleted && errors.length === 0`；完成位随结构化结果输出，装配器**原样透传**（`result.ok` 同样要求完成位）；判据新增 **1b**（宿主侧信号之后、硬证据之前）：`runCompleted === false` 且无失败项且 `checks` 非空 → `PLUGIN_REGRESSION`（**绝不判 PASS**）。`exit` 钩子里 `process.exitCode = 1`（插件 `exit(0)` 也不得让装配器读成通过） | 离线 [9.9d] 完成位 6 条（含反向护栏：缺字段不翻案 / 宿主侧信号优先）；装配器层 [9.9e] 3 条；`test_offline.sh` [16] 断言「未跑完绝不给 ok / 退出码非 0」；真宿主 [8c] 断言 `runCompleted=false` 且 verdict=RED |
| **必修-2** | **进程 exit 出口未闭合、且未声明（静默）**。插件调 `process.exit()` **不抛异常** ⇒ 顶层 `catch` 与 `uncaughtException` 都接不到 ⇒ 探针在写出结构化结果前消失 ⇒ 装配器**无条件** `pushHostFatal()` ⇒ `UPSTREAM_DRIFT`/AMBER + `checks` 归零。且 `CHANGELOG` / `docs/RISKS.md` / 提交信息 / PR 描述**均无**「已知未收口」标注（违反「不得静默」） | ① `process.on('exit')` 钩子：`recordProbeEarlyExit()` 落插件侧 check `plugin.early_exit` → `skipPendingChecks()` 补 skip → `emit()`（`writeSync`，防截断）→ `process.exitCode = 1`；② 自杀式信号（`SIGTERM`/`SIGINT`/`SIGHUP`/`SIGQUIT`）显式接住，同一路径收尾；③ **不可捕获边界**（`SIGKILL`/OOM/原生 `abort`）**显式声明**（本文件 + `docs/RISKS.md` R21 + 指南 + 判据表口径），并**按相位信标**归因（见下），不是「声明了事」 | 离线 [9.9a/b/c/f/g] 路由 + 写入端不变量 + 崩溃路径不抛 + 信标 + 源码守卫；`test_offline.sh` [16] 出口③ 5 条；真宿主 [8c] 3 条 + 假绿反证 2 条；闸门 `tests/gate_plugin_side.sh` |
| **必修-3** | **看门狗不覆盖「单纯挂住」**。`ASYNC_WATCHDOG_MS` 只在**记录过异步异常**时才安装 ⇒ `apply()` 返回永不 resolve 的 Promise（无异常、无退出）**根本没装**；且紧跟 `watchdog.unref?.()` ⇒ 事件循环里没有其它 handle 时进程直接走 exit 路径，看门狗**永不触发**（这正是「`run()` 被拖住」的场景）。评审实测：仅删 `unref` 只覆盖一半 | 看门狗**无条件**安装（探针启动即装）、**不得 `unref`**（收尾由 `finish()` 显式 `clearTimeout`）、与完成位联动；落插件侧 check `plugin.run_incomplete`。窗口默认 20s；宿主侧可用 `DSH_PROBE_RUN_WATCHDOG_MS` **只许缩短**（`Math.min` + 下限 1s，且在**任何插件代码运行之前**读取 ⇒ 插件无法影响），供回归不必干等 | 离线 [9.9g] 源码守卫（无条件安装 / **不得 unref** / clearTimeout / 只许缩短）；`test_offline.sh` [16] 出口④ 4 条；真宿主 [8c] |

### 边界（本轮**显式声明**，不再静默）

| 形态 | 归因 | 依据 |
|---|---|---|
| 可捕获出口（①同步 ②异步 ③进程 exit ④`run()` 被拖住） | 插件侧 check（`plugin.unexpected_exception` / `plugin.async_uncaught_exception` / `plugin.early_exit` / `plugin.run_incomplete`），`hostFatal[]` **保持为空** | 探针自己闭合，照常输出结构化结果 |
| **不可捕获**终止（`SIGKILL` / OOM / 原生 `abort` / stdout 被破坏） | **有相位信标** → 插件侧 check `plugin.abnormal_termination`（插件代码运行期间被终止）；**无信标** → `hostFatal[]` → `UPSTREAM_DRIFT`/AMBER（宿主装配段，真上游信号不丢） | 探针来不及写报告 ⇒ 装配器按 `__DSH_PROBE_PHASE__` 信标**按证据**归因（评审 🔴 必修-2 的「二选一」中的方案②），不再无条件甩锅上游 |

> **为什么信标是必须的**：只「声明边界」解决「静默」，但不解决「甩锅」——插件把自己 `kill -9` 也会被判成「上游变了，不是你的问题」。信标把「终止发生在哪一段」变成**证据**。

### 🟡 建议（本轮清零）

| # | 问题 | 处置 |
|---|---|---|
| 🟡-1 | **口径自订不变量与实现不符**：`contract.mjs` / `docs/ADAPTER_GUIDE.md` 写「插件侧错误**永不**进 `hostFatal[]`」，但探针**未**覆盖全部退出路径（③④ 未闭合）⇒ 文案在说谎 | 二选一 → **选「覆盖全路径 → 保留」**：四条可捕获出口全部闭合 + 不可捕获边界显式声明并给证据化归因。文案**收窄为准确口径**（「插件侧错误**不得**进该字段；探针**可捕获**的全部逃逸形态都落插件侧 check，唯一例外是不可捕获的进程级终止，按信标归因」），`contract.mjs` 与指南同步。<br>⚠️ **v0.1.9b 二次收窄（评审复评 H1）**：上句仍**不完整**——还有一类例外是「插件**主动干预**探针进程内防线」（`setUncaughtExceptionCaptureCallback` 静音监听器 / `removeAllListeners` 撤销），此时整轮判 GREEN **放行**。准确口径 =「**在探针进程内防线未被插件干预的前提下**」；**不得**写「永远 / 永不」。见 `docs/RISKS.md` R22/R23 |

### 🟢 优化（顺手）

| # | 问题 | 处置 |
|---|---|---|
| 🟢-1 | `CHANGELOG.md` v0.1.7 段有**重复句**（「本轮先照单复跑…」×2） | 已删 |
| 🟢-2 | `tests/test_offline.sh` [14] 的 `known` **硬编码 17 条**（已被三张事实源表 100% 覆盖，评审实测 17/17 冗余） | 改为**派生**：`[...HOST_SIDE_CHECKS, ...CONTRACT_SIDE_CHECKS, ...PLUGIN_SIDE_CHECKS]`（新增 check 时不会漏改一处而静默失效） |
| 🟢-3 | 两份异步夹具的 `definitions().render` 返回 `[]` ⇒ 附带 `dispatch.render_projected` / `echo_payload` 噪音 fail（不影响归因，但淹没真因） | 改为正常文本投影，把失败点精确留在「后台任务抛错」上 |
| 🟢-4 | `.cnb.yml` push / PR 两段闸门脚本**各自维护**（54 行差异，两段口径迟早不一致 = 闸门静默失效） | 抽成 **`tests/gate_plugin_side.sh`**（唯一事实源：夹具清单 + 断言口径 + 防过度修正断言），push / PR 共用；`tests/test_hub.sh` 新增第 4b 步（本地也能跑，不必等 CI） |

### 新增能力（顺带，为本轮防线服务）

- **离线探针回归台** `tests/offline-probe-harness.mjs`：造一个**最小假宿主**（`Context` / `ToolRuntime` 三条面 + 与真宿主同构的保留名拒绝措辞），把 `probe-template.mjs` 当真实探针跑（子进程），再用**装配器的真实实现**（`interpretProbeStdout()`）解释输出。⇒ 四条出口从「只被真宿主 E2E 覆盖（慢、要网、CI 才跑）」变成**秒级离线回归**。
  **边界显式声明**：假宿主**不做**真实 schema 子集校验与 ToolRuntime 的并发/取消细节 ⇒ **「假宿主通过」不等于「真宿主适配通过」**（那是 `verify` 的事），它只回答「探针有没有把插件侧错误写成宿主侧信号」。
- `host.mjs` 抽出纯函数 `interpretProbeStdout(result, stdout)`：装配器与离线回归**共用同一份**解析/归因逻辑（判据字段的写入端只有一处可写错）。
- `contract.mjs` 新增：`PLUGIN_EARLY_EXIT_CHECK` / `PLUGIN_RUN_INCOMPLETE_CHECK` / `PLUGIN_ABNORMAL_TERMINATION_CHECK` / `PROBE_PHASE_BEACON_PREFIX` / `probeProcessFailureRoute()` / `recordProbeEarlyExit()` / `recordProbeRunIncomplete()` / `PLUGIN_SKIP_ON_PRECONDITION`（派生：插件侧 check 表 **减去**条件项，避免普通失败报告里多出 5 条无意义的 skip）。

### 兼容性

- 探针结构化结果**新增字段** `runCompleted`；验收报告通道级**新增字段** `runCompleted`。
- `contract.mjs` 的 `CONDITIONAL_PROBE_CHECKS` 由 2 项扩到 **5 项**（新增 `plugin.early_exit` / `plugin.run_incomplete` / `plugin.abnormal_termination`）；「17 项 + N 条件项」口径随之更新（文档由 `test_exports.mjs` 断言一致）。
- 判据新增 **1b**（完成位），位置在宿主侧信号之后、插件侧硬证据之前（理由见 `docs/ARCHITECTURE.md` §4.2 ③）。
- `probeFailureRoute()` / `probeAsyncFailureRoute()` 语义不变；新增通用入口 `probeProcessFailureRoute(phase, check)`（旧入口委托它，行为等价）。
- **行为变更（预期）**：插件在验收中调 `process.exit()` / 挂住事件循环，从此判 `PLUGIN_REGRESSION`/RED（此前判 `UPSTREAM_DRIFT`/AMBER 或假绿）。这是**修复**，不是回归。

### 测试项数

- `tests/test_offline.sh`：85 → **103 项**（新增 [16] 四条出口 18 条；[14] 改派生不增减）
- `tests/test_attribution.mjs`：209 → **294 项**（新增 [9.9] 四条出口 + 完成位 65 条；[9.4] 增 🟡-3 兜底区切片守卫 6 条 + [9.4d] 报告完整性 3 条 + [9.4e] H1 防线静音守卫 8 条）
- `tests/test_e2e_regression.mjs`：92 → **124 项**（新增 [8c] 三条出口 × 10 + 假绿反证 2）
- `tests/test_exports.mjs`：28 → **38 项**（新增 [2b'''] 文档条件项计数 = 事实源长度 + 段落级自证 10 条）
- 新增夹具：`tests/fixtures/plugin-exit-plugin.mjs`、`tests/fixtures/plugin-hang-plugin.mjs`、`tests/fixtures/plugin-sigkill-plugin.mjs`
- v0.1.9b 新增夹具：`tests/fixtures/plugin-capture-callback-plugin.mjs`（H1 复现；**当前判 GREEN**，v0.1.9 修法 A 后必须 RED；不进 CI 闸门）
- 新增脚本：`tests/gate_plugin_side.sh`（闸门唯一事实源）、`tests/offline-probe-harness.mjs`（离线探针回归台）
- `tests/test_hub.sh`：新增第 4b 步（插件侧闸门，含防过度修正）
- `.cnb.yml`：push / PR 的 `plugin-error-not-host-signal` 改为**共用** `tests/gate_plugin_side.sh`（夹具 4 → **10 份** + 健康插件防过度修正断言）
- 新增夹具：`plugin-detach-handlers-plugin.mjs`（摘掉全部相关监听器）/ `plugin-busy-loop-plugin.mjs`（同步占死事件循环）/ `plugin-process-exit-plugin.mjs`（后台定时器里 exit）/ `plugin-capture-callback-plugin.mjs`（H1 抢占捕获回调）

### H1（复评）：**放行级假绿** —— 插件静音探针的进程内防线（本轮已收口）

评审复评指出：v0.1.9 的四条出口都**跑在探针进程内**，而插件可以**单方面撤销**它们。
其中 **H1 是放行级假绿**（比 AMBER 更危险——AMBER 至少不放行）：

| 形态 | 机理（Node 语义） | 旧行为 | 收口 |
|---|---|---|---|
| 插件调 `process.setUncaughtExceptionCaptureCallback(cb)` | capture callback 一旦设置，`uncaughtException` **监听器不再被调用**（官方语义）⇒ 探针出口② 被静音 | 插件后台抛错**完全不可见**、`run()` 正常收尾、完成位仍真 ⇒ **GREEN / PASS 放行** | 探针收尾（`emit()` 内、**写出报告之前**）自检 `process.hasUncaughtExceptionCaptureCallback()` + 两个监听器 `listenerCount > 0` → 判插件侧 check `plugin.process_defense_tampered` |
| 插件 `removeAllListeners('uncaughtException'/'unhandledRejection')` | 监听器被摘掉 | 同上（出口② 失效） | 同上（**两条都查**，缺一即被绕过） |

- 真实形态很常见：插件引入 Sentry / APM / 错误上报 / 日志库，初始化时会抢占该**独占** API
  ——**不是**刻意攻击，是普通工程实践。
- 新增夹具 `tests/fixtures/plugin-capture-callback-plugin.mjs`（H1 一行复现）+ 进闸门（10 负例）。
- 防线：闸门（判插件侧 / `hostFatal` 为空 / **verdict=RED 不得 GREEN** / 完成位仍 `true`——探针确实跑完了，它只是**不知道**自己被静音了）；
  离线 [9.4e] 源码守卫（自检存在 / **两条都查** / 在 `out.ok` 之前 / 只在插件集成相位判 / 落点已登记）+ 夹具自检；
  删掉任一检查即红（已实测）。
- **口径（不越权承诺）**：本项**只能在探针还活着时**判。插件若让探针**整个进程**消失
  （`SIGKILL` / `process.exit` / 挂住），本项同样来不及判——那时由出口③④ 或装配器按相位信标归因。

### 放行判据（总师 §三⑤，不变）

- 异步路径 + 进程 exit 路径均 `hostFatal=[]`；**且健康插件仍 GREEN 17/17**（防过度修正）。

### 并行尝试的合并说明（`0b06398` → 本版）

本轮源分支上另有一份**同族四条出口**的并行实现（`0484292`，已与 `c8965b9` 合并为 `0b06398`）。
两份解决同一失效族，但**逐条比对后取本实现**，理由（都是判据层面的差异，不是风格）：

| 项 | 并行实现（`0b06398`） | 本实现（v0.1.9） | 为什么取本实现 |
|---|---|---|---|
| 不可捕获终止（`SIGKILL` / OOM） | 仍**无条件** `pushHostFatal()` | **相位信标**归因：有信标 → 插件侧 `plugin.abnormal_termination`；无信标 → `hostFatal[]` | 评审 🔴 必修-2 要求「收口或显式声明，**不得静默**」；且只声明不解决**甩锅**（插件 `kill -9` 自己会被判成上游问题） |
| 出口④ 看门狗 | 依赖**宿主传入** `timeoutMs`（= 宿主 timeout 80%） | 探针**无条件自持**（不依赖入参，默认 20s；宿主侧只能**缩短**） | 评审 🔴 必修-3 的表述是「看门狗**无条件**覆盖 `run()` 全程」；挂在宿主入参上 ⇒ 换个调用方就重新开洞 |
| 归因判据 | 完成位只在 `ok` 上生效，`attributeDetail()` 未据它判定 | 新增判据 **1b**（宿主侧之后、硬证据之前） | 探针未跑完且恰好无 fail check 时会落到其他分支（`UNKNOWN` 等）；判据层必须能独立判「没跑完」 |
| 离线防线 | 无（四条出口只被真宿主 E2E 覆盖） | `tests/offline-probe-harness.mjs`（假宿主 + 真实探针 + 装配器真实实现） | 秒级回归，判据一变就红，不必等 CI 装宿主 |
| 闸门 | push / PR 两段各自维护 | 抽 `tests/gate_plugin_side.sh` 唯一事实源 + **防过度修正**断言 | 两段口径迟早不一致 = 闸门静默失效；且负例断言必须配「健康插件仍 17/17」，否则「全判插件」也能全绿 |

冲突解决：13 个文件取本实现；并行实现的 4 份夹具（`async-throw` / `async-reject` /
`exit-in-apply` / `hang-in-apply`）删除——本实现以 `plugin-async-throw` / `plugin-async-reject` /
`plugin-exit` / `plugin-hang` / `plugin-sigkill` 覆盖同一形态，且**多覆盖不可捕获边界**。

### 合并第三方并行尝试（`3e25675` 一线）后的**并集增量**

本版合并时，另一条并行线（`3e25675` 一线，同样针对本轮评审 🔴-D′）带来了**互补**的
形态覆盖。两边最终都收敛到「带外证据 + 相位」这一族思路（本实现用**落盘侧信道**
`probe-phase.txt`，对方用 **stdout 相位信标** `__DSH_PROBE_PHASE__`），故取其更完整的
出口覆盖 + 完成位，并保留/补上本线的以下增量（**都是实测能红的防线**）：

| 增量 | 为什么必须有 | 防线 |
|---|---|---|
| **🟡-3 兜底区切片守卫** | 评审实测逃逸：`[9.4]` 的源码守卫从 `try {\n  await run();` 起切 ⇒ **兜底处理器区域不在视野内**（「保留 `recordProbeAsyncException` 诱饵 + 另加一行 `pushHostFatal`」变异漏检） | 切片起点上移到兜底区段标记；补**守卫自证**（诱饵 / 别名 / 模板插值）+ **反证**（同一变异喂旧切片 → 确认漏检、喂新切片 → 确认抓到）+ 段标记本身有断言（改名即红） |
| **报告完整性：`lifecycle.disposer_count` 不再丢** | 实测发现（跨夹具）：探针第 10 段 catch 只标 `lifecycle.registered` / `lifecycle.dispose`，而 `lifecycle.disposer_count` 的 `check()` 在抛错点**之前** ⇒ 报告少一项（17 → **16**），人分不清「没验」与「验过了」 | 改为 `skipAll([三项])`；`[9.4d]` 加源码守卫；闸门每份夹具断言 **17 项一项不缺** |
| **闸门补 3 份对抗夹具** | 评审 🔴-D′ 原始复现的变体，此前只在临时验证里跑过、**未进闸门**（= 无防线） | `plugin-detach-handlers`（摘掉**全部**相关监听器后再抛）/ `plugin-busy-loop`（**同步占死**事件循环）/ `plugin-process-exit`（**后台定时器**里 exit，非 apply 内直接调）→ 纳入 `tests/gate_plugin_side.sh`（7 → **10 份**） |
| **🟡-5 夹具 render 噪音** | 夹具注释自述「失败点精确留在对应出口」，实际附带 `dispatch.render_projected` / `echo_payload` 两条噪音 fail（`render: () => []`），掩盖真因 | 5 份夹具改真实投影（走中台 `defaultRender`）；修后异步两例**仅 1 条 fail + 17 pass** |
| **🟡-4 守卫自证** | 上一版自证对整份文档做 `replace` ⇒ 条件检查名在别处（负例索引行）也出现时，变异只改第一处、断言仍命中 = **自证空转**（实测逃逸） | 自证改为**按条件检查表段落**变异（表头锚定 → 段落切出）；附反证「整份 replace 会漏检」 |

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

> ⚠️ **v0.1.9b 更正**：标题里的「永不进判据字段」是**当时的自述**，现已被复评实测推翻（H1 放行级假绿）。
> 当前有效口径见 v0.1.9b 小节与 `docs/RISKS.md` R19/R22/R23。

> 承接 v0.1.5（复测清单闭环）/ v0.1.6（文档守卫加固）。
> 评审 @ `f995979` 判 `disposition = fix_bug`：🔴-D 未清零——同一失效族**仍有活口**，
> 但活口从「判据读取端」搬到了「**写入端**」。

### 🔴 必修

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| 🔴-D | **探针顶层兜底把插件侧异常写进 `hostFatal[]`**（判据唯一事实字段）。探针有两条「读插件侧数据」的路径不在 try 内：`tools.schemas().map(...)`（第 6 段）与 `definitions.map((d) => d?.name)`（第 11 段）。插件写错代码（类实例未初始化字段 / 抛错 getter）→ 异常逃出 `run()` → 顶层 `catch` 一律 `pushHostFatal()` → 判据 1 命中 → `UPSTREAM_DRIFT`/AMBER，且判据 1 **优先于**判据 5 → 插件侧已失败的 check 被整条盖掉。违反本 PR 自订不变量「插件侧错误**永远**不进该字段」（⚠️ v0.1.9b 更正：绝对口径不成立，已收窄） | ① **相位化兜底**：探针声明执行相位（`host-assembly` / `plugin-integration`），顶层兜底按相位归因——宿主装配相位 → `hostFatal[]`，插件集成相位 → **插件侧 check** `plugin.unexpected_exception`（已登记 `PLUGIN_SIDE_CHECKS`）；未知相位**保守判插件侧**；② **插件数据读取加护栏**：`tools.schemas()` → `registry.exact`、`definitions.map()` → `guard.reserved_rejected`（异常均落插件侧 check，并 `skipAll` 后续未验项）；③ 归属路由唯一事实源 `contract.mjs` 的 `PROBE_PHASE` / `probeFailureRoute()` / `recordProbeException()`（探针与离线回归共用同一份）；④ 相位随报告透出（`probePhase`），排障看得见异常归属依据 | **离线** [9] 20 条（相位路由 / 写入端不变量 / 反向护栏 / 源码守卫）；**真宿主** [8] 18 条 ×2 夹具（`plugin-side-throw-plugin.mjs` / `plugin-registry-throw-plugin.mjs` → `PLUGIN_REGRESSION`/RED **且 `hostFatal.length === 0`**、`hostFatal` 不含夹具路径与 `at ` 帧、插件侧 stack 仍留在 `errors` 日志）；**反向** 真宿主 [9] 3 条（离线缺缓存仍判漂移、`hostFatal` 非空、`probePhase=host-assembly`） |

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

> 承接本版第一批（🔴-D 写入端分相位）。本轮先**照单复跑**你点名的 §二 14 组变异（含 2b 行下移/整行删除、INDEX 标题与序号），
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
