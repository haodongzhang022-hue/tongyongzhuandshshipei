# 变更记录（dsh-adapt-hub）

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
- `docs/INDEX.md`：17 项索引表标题改为「按探针实际输出顺序」，测试项数同步。
- `docs/ARCHITECTURE.md`：§4.2 ③「归因契约」（7 步优先级 + 四条纪律）；测试项数同步。

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
