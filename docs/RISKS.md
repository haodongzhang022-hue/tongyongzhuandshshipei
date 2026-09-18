# 风险清单（DSH 适配中台）

> 纪律：**风险显式暴露 + 给规避方案 + 标注触发条件**；不确定的一律标风险，绝不默认「应该没问题」。
> 承担风险的是人，所以每条都写清「什么时候会爆、爆了怎么办」。

| # | 等级 | 风险 | 触发条件 | 影响 | 规避方案 | 兜底 |
|---|---|---|---|---|---|---|
| R1 | **HIGH** | 上游 alpha 线出现**破坏性变更**，双通道同时红 | `dsh-tools` alpha 发新版且改了注册契约 | 所有接入插件无法加载 | 中台兼容层按契约指纹 diff 定向修；插件侧零改动 | `dev` 失败归因 `UPSTREAM_DRIFT`，不误伤插件；`stable` 通道仍绿即业务可用 |
| R2 | **HIGH** | 跨仓授权不足，其他仓库拉不到中台 | 中台仓库私有 | 接入方 CI 拉不到 hub | 中台保持 Public | 退化为 `git clone` 直取（本指南默认写法） |
| R2b | **LOW** | `include` 跨私有仓引用需 `allow_slugs`，本仓**未落地**该声明 | 有人用 `include` 而非 `git clone` | `include` 解析失败 | 暂不用 `include`；接入统一走 `git clone` 直取（指南默认写法） | 需要时再落地 `allow_slugs`（属待拍板项） |
| R3 | **MEDIUM** | 钉版表过期，验收跑在旧宿主上「假绿」 | 上游发版但无人 bump pins | 以为适配好了，实际新版已崩 | crontab 每日扫 dist-tag（退出码 1 显式可见）+ 契约指纹 diff | `watch` 报告写入 `.ci/watch.json` 留痕 |
| R4 | **MEDIUM** | 真宿主验收需要网络装包，离线/内网失败 | CI 无外网 / npm 不可达 | 验收无法执行（非插件问题） | 宿主依赖缓存目录 `$TMPDIR/dsh-adapt-host-cache`；`--offline` 模式 | `verify` 归因 `UPSTREAM_DRIFT` 并附「离线缺缓存」原因，不静默通过 |
| R5 | **MEDIUM** | `latest` dist-tag 是历史残留，误当稳定线 | 直接读 `dist-tags.latest` | 把 0.0.1 当稳定版验收，结论错 | 通道显式声明 `npmTag`（stable→`next`）+ `line` 双约束 | `watch` 对比钉版与 tag，不一致即报警 |
| R6 | **MEDIUM** | 额度消耗：每通道一次真宿主安装 | 每次 push/PR 跑多通道 | 构建额度上升 | legacy 走 crontab 周检；stable+dev 走 push/PR；依赖缓存复用 | 本地 `--offline` 复跑不消耗额度 |
| R7 | **MEDIUM** | 归因误判（把插件 bug 报成上游漂移，或反之） | 契约探测残留污染工具清单 / 判据**扫自由文本**（裸关键词或宿主侧前缀字面量）/ 无可用基线 | 修复责任被推错方向，中台核心价值主张当场失效 | **判据结构化**：宿主侧只认 `probe.hostFatal[]`（结构化字段）与宿主侧 check 名，插件侧只认插件侧 check 名；`errors[]` 是日志、**不参与判据**；契约探测**采集后立即卸载**（`contract.probe_disposed` 守门）；漂移字段须与失败 check 相关才判漂移（`guard.reserved_rejected` 不入表——插件违规不甩锅上游）；基线一致则判插件回归 | 报告含原始 `errors` + `hostFatal` + `contractDrift.items` + **`attributionReasons` 判据链**；离线回归 `tests/test_attribution.mjs` + 真宿主回归 `tests/test_e2e_regression.mjs` |
| R13 | **LOW** | 探针错误措辞混用 / 归因**扫自由文本**（宿主侧与插件侧信号都靠关键词区分） | 有人往判据里加裸关键词；或插件侧 stack / 路径 / 工作目录恰好含宿主侧前缀字面量 | 归因再次被带跑（插件 bug 报成上游漂移） | ① 探针侧分级：宿主/环境侧 `pushHostFatal()` 落**结构化字段** `hostFatal[]`，插件侧一律落 check；② 判据**只读 `probe.hostFatal[]` 与 check 名**，`errors[]` 仅作日志、**任何判据不读**；③ `HOST_FATAL_PREFIX` / `HOST_FATAL_FIELD` / `HOST_SIDE_CHECKS` / `CONTRACT_SIDE_CHECKS` / `PLUGIN_SIDE_CHECKS` 的唯一事实源是 `src/harness/contract.mjs`（探针与执行器 import 同一份，防两侧漂移） | 离线 `test_attribution.mjs` [3][3.1]（路径含 `npm` / 路径或文本含 `fatal(host)` / 判据代码不读 `errors` 的源码守卫）；真宿主 `test_e2e_regression.mjs` [5]（插件目录名含 `fatal(host)` → 必须判插件） |
| R11 | **MEDIUM** | 漂移侦测基线被验收过程自己写坏（历史缺陷） | 失败运行的契约是 `{}`，若无条件 `save` 会清空基线 → 下次产出假漂移 | 「上游漂移侦测」核心能力失效、CI 每次 push 改写 tracked 文件 | 基线**只在通道 `ok` 时更新**、`save` 做**合并**写入、**无变化不写盘**；失败运行不产生漂移项 | 单测覆盖「失败运行后基线不变 / 不产生假漂移 / 仅 ok 通道被更新」 |
| R12 | **LOW** | 保留名冲突被静默丢弃（历史缺陷） | 插件声明了 `run_code` 等保留名 | 工具凭空消失、用户以为已注册 | 冲突进 `issues`（前缀 `reserved_name_conflict:`）+ 触发 `onIssues` + `toJSON().reservedRejected`；探针 `guard.reserved_rejected` 判失败 | 单测覆盖「冲突上报 + 回调 + toJSON + 未注册到宿主」 |
| R8 | **LOW** | 版本线探测失配（上游改 `Config` 形状） | 上游重构 `tools.Config` | 探测返回 `unknown` | 三级兜底：Config 投影 → 保留名措辞 → `unknown`（**不抛错、不阻断加载**） | `unknown` 走兼容路径，插件仍可加载 |
| R9 | **LOW** | Schema 子集收窄 | 上游新增/收紧 keyword 白名单 | 部分 schema 被拒 | `normalizeSchema` 白名单化 + 注册前 `issues` 上报 | 违规清单进报告，不静默丢字段 |
| R10 | **LOW** | 同层重复注册同名工具 | 插件多次 `apply` | `is already registered` 抛错 | `adapter.disposeAll()` / 独立 `Context` | 探针含 `lifecycle.*` 检查，CI 可发现 |

| R16 | **MEDIUM** | 漂移相关性吞掉插件侧硬违规（历史缺陷，评审二轮 🔴-C）：上游放宽保留名校验时，插件声明保留名被归因为上游漂移 | 漂移窗口（`reservedName` 变化）+ 插件声明 `run_code` | 插件违规被甩给上游，责任错、修错方向；负例闸门同步静默失效 | 插件侧硬证据 `PLUGIN_HARD_EVIDENCE`（`guard.reserved_rejected`）**优先于**漂移相关性；相关性收窄为只对应中台自检 `guard.reserved_name`（不用 `guard.*` 通配） | 离线回归 [4b] + 端到端 [5]（同窗口健康插件仍须 PASS，防过度修正） |
| R17 | **LOW** | 归因判据**扫自由文本**（历史缺陷，评审二轮 🔴-C 活口二）：宿主侧信号靠 `errors` 文本里的前缀字面量区分，插件侧 stack / 文件路径 / CI 工作目录恰好含 `fatal(host)` 即翻案 | 插件放在含 `fatal(host)` 的目录；或插件错误串原样透传上游日志 | 插件 bug 被报成「上游变了，不是你的问题」，修复方向错 | 宿主侧信号落**结构化字段** `hostFatal[]`（`pushHostFatal()` 同时写字段与人读日志）；归因判据**只读 `hostFatal[]` 与 check 名**，`errors[]` 退化为纯日志、任何判据不读 | 离线 [3.1] + 源码守卫（判据代码不得出现 `errors.join`/`errors.includes`/`HOST_FATAL_PREFIX`）；真宿主 [6]（插件目录名含 `fatal(host)` → 仍判插件）+ [7]（真漂移不丢：离线缺缓存 → `hostFatal` 非空） |
| R18 | **MEDIUM** | **漂移窗口内首跑顺序影响后续归因**：漂移窗口内若先跑**健康**插件，该通道 `ok` → 漂移契约被写进基线，后续运行 `contractDrift.changed=false`，漂移信号消失 | 同一漂移窗口内先跑健康插件、再跑负例插件（或反之） | 排障时误判「没有漂移」；同一条命令在不同顺序下结论不同，责任判定被顺序左右 | 口径已明确（**非缺陷**，是「仅 ok 更新基线」的必要设计，不改）：① 判定漂移以**首次运行**或**干净副本**为准；② 复测/排障先跑负例或先隔离副本（`test_e2e_regression.mjs` 每个场景用全新仓库副本 + 独立 `TMPDIR` 缓存，正是为此）；③ 看 `attributionReasons` 里已无「契约指纹漂移」字样时，先查该通道基线是否被上一次 ok 运行刷新 | `docs/RISKS.md` 本行 + `tests/test_offline.sh`（基线只在 ok 时更新 / 失败不覆盖）已固化；排障规程见 `docs/ADAPTER_GUIDE.md` §4 |

## 待人类拍板项（不拍板则按现状执行）

| 项 | 现状 | 建议 | 影响面 |
|---|---|---|---|
| 稳定线基准取 `next`（0.1.5-rc.2）而非 `latest`（0.0.1-rc.1 残留） | 已按 `next` 执行 | 确认 | 验收结论正确性 |
| legacy（0.1.1 线）通道是否长期保留 | 保留（周检） | 若官方确认弃用则改为「冻结不跑」 | 构建额度 |
| 是否发布 npm 包 `@dongdongxiaozu/dsh-adapt-hub` | 未发布（用 `git clone` 接入） | CP2 后决定 | 接入便捷性 |
| 是否开「组织级跨仓操作」做批量体检 N 个插件 | 未开 | CP2 后决定 | 授权范围 |
