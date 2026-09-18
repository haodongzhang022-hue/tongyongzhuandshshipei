# 变更记录（dsh-adapt-hub）

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
