# 变更记录（dsh-adapt-hub）

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
