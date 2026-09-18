# 插件接入指南（5 分钟接入 DSH 适配中台）

> 目标：**插件作者只写业务逻辑**，版本探测 / schema 压平 / 取消语义 / 保留名规避全部交给中台。
> 上游 DSH 一变，改中台一处，你的插件仓库**不用改**。

---

## 一、你不再需要写的东西

| 以前每个插件都要写 | 现在 |
|---|---|
| 探测宿主是新版（PTC）还是旧版（Code） | ✅ 中台 `detectHostFlavor()` |
| 把宽松 schema 压平为宿主受支持子集 | ✅ 中台 `normalizeSchema()` |
| 规避 `run_code` 保留名 | ✅ 中台 `assertNotReserved()` 显式报错 |
| 补 `output.render` | ✅ 中台缺省文本投影 |
| 在 `execute` 里尊重 `exec.signal` | ✅ 中台统一包装 |
| 写双版本适配验收脚本 | ✅ 中台 `verify --channel stable|dev` |
| 盯上游有没有发新版 | ✅ 中台 `watch` + crontab |
| 上游发版后「漂移到哪、影响谁、我要不要动」 | ✅ 中台 `watch --markdown`（**影响面自动归因**，直接点名中台改哪一处） |

---

## 二、最小接入（复制即用）

> ⚠️ 模板 `templates/adapter/index.mjs` 拷出本仓后，**必须改第一行 import**（模板内有 `TODO(拷贝后必改)` 标记）：
> 中台未发布 npm 包时，改成你 clone 的中台路径（如 `/tmp/hub/src/adapter.mjs`）；
> 已发布时用 `@dongdongxiaozu/dsh-adapt-hub/adapter`。不改则 `ERR_MODULE_NOT_FOUND`。
> 自检：`node tests/test_exports.mjs`（含「模板拷贝可用」用例）。

### 1. 插件入口 `index.mjs`

```js
import { createAdapter } from '@dongdongxiaozu/dsh-adapt-hub';

/** 只依赖宿主 tools 服务（新旧版语义一致）。 */
export const inject = ['tools'];

/** 工具名清单（供验收脚本读取，可选但推荐）。 */
export const expectedTools = ['myplugin_echo', 'myplugin_status'];

/** 工具定义：纯业务，无任何版本相关代码。 */
export function definitions() {
  return [
    {
      name: 'myplugin_echo',
      description: '回显文本',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '待回显文本' } },
        required: ['text'],
      },
      output: {
        // 宽松写法也可以，中台会压平；不写 render 时自动兜底文本投影
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      execute: async (args) => ({ text: `echo: ${args.text}` }),
    },
    {
      name: 'myplugin_status',
      description: '返回适配状态',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { flavor: { type: 'string' } }, required: ['flavor'] } },
      execute: async () => ({ flavor: 'runtime-detected' }),
    },
  ];
}

export function apply(ctx) {
  const adapter = createAdapter(ctx, {
    prefix: 'myplugin',
    // 可选：把 schema 违规上报到加载画像，而不是「装上了但调用即炸」
    onIssues: (issues) => console.warn('[myplugin] schema issues:', issues),
  });
  adapter.register(definitions());
}
```

> **关键点**：这份文件里**没有任何 `@deepseek-ai/*` import**。这正是「上游换版不用改插件」的前提。

### 2. 插件包声明（`package.json`）

```json
{
  "name": "@your-scope/myplugin",
  "type": "module",
  "main": "./index.mjs",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "peerDependenciesMeta": { "@deepseek-ai/cordis": { "optional": true } }
}
```

### 3. 挂上双通道验收（`.cnb.yml`）

```yaml
main:
  push:
    - name: dsh-dual-channel
      docker:
        image: node:22
      stages:
        - name: stable
          script: |
            git clone --depth 1 https://cnb.cool/dongdongxiaozu/tongyongzhuandshshipei.git /tmp/hub
            node /tmp/hub/src/cli.mjs verify --channel stable \
              --plugin ./index.mjs --tools myplugin_echo,myplugin_status --markdown
        - name: dev
          script: |
            node /tmp/hub/src/cli.mjs verify --channel dev \
              --plugin ./index.mjs --tools myplugin_echo,myplugin_status --markdown
  pull_request:
    - name: dsh-dual-channel
      docker:
        image: node:22
      stages:
        - name: stable
          script: |
            git clone --depth 1 https://cnb.cool/dongdongxiaozu/tongyongzhuandshshipei.git /tmp/hub
            node /tmp/hub/src/cli.mjs verify --channel stable \
              --plugin ./index.mjs --tools myplugin_echo,myplugin_status
        - name: dev
          script: |
            node /tmp/hub/src/cli.mjs verify --channel dev \
              --plugin ./index.mjs --tools myplugin_echo,myplugin_status
        - name: legacy-guard
          script: |
            node /tmp/hub/src/cli.mjs verify --channel legacy \
              --plugin ./index.mjs --tools myplugin_echo,myplugin_status
```

> 也可用 `include` 把中台仓库的模板配置引入，避免复制（见 `docs/ARCHITECTURE.md` §4.2 与官方 `file-reference` 文档）。
>
> ⚠️ **`allow_slugs` 未落地**：跨私有仓引用需模板文件声明 `allow_slugs`，本仓当前**未实现**该声明（中台保持 Public，接入默认走 `git clone` 直取）。口径见 `docs/RISKS.md` R2。

---

## 三、本地自测

```bash
# 只跑离线单测（不装宿主，秒级）
bash /path/to/hub/tests/test_offline.sh

# 跑指定通道的真宿主验收（首次会装宿主依赖，之后走缓存）
node /path/to/hub/src/cli.mjs verify --channel stable --plugin ./index.mjs --tools myplugin_echo,myplugin_status --markdown

# 三通道全跑（all = stable + dev + legacy，与页面按钮同义）
node /path/to/hub/src/cli.mjs verify --channel all --plugin ./index.mjs --tools myplugin_echo,myplugin_status

# 看上游有没有发新版 + 影响面自动归因（漂移到哪 / 影响谁 / 改哪一处）
node /path/to/hub/src/cli.mjs watch --markdown

# CI 上：把验收报告喂进来，watch 同时给出「版本漂移 + 契约漂移 + 影响面」（不必再跑真宿主）
node /path/to/hub/src/cli.mjs verify --channel all --plugin ./index.mjs --tools a,b --json ./verify.json
node /path/to/hub/src/cli.mjs watch --contract-from ./verify.json --markdown
```

---

## 四、验收报告怎么读

```
| 通道 | 版本线 | 状态 | 归因 | 版本线探测 | 检查项 |
| ✅ 稳定版通道 | 0.1.5 | pass | PASS | modern | 17/17 |
| ❌ 开发版通道 | 0.1.6 | fail | UPSTREAM_DRIFT | modern | 15/17 |
```

| 归因 | 含义 | 你该做什么 |
|---|---|---|
| `PASS` | 通过 | 无事 |
| `UPSTREAM_DRIFT` | **上游契约变了 / 宿主环境不可用**（装不上、离线缺缓存），不是你的 bug | 提 Issue 到中台仓库；中台改兼容层，你不动 |
| `PLUGIN_REGRESSION` | 你的插件出问题 | 看 `failedChecks[].name` 定位并修 |
| `UNKNOWN` | 验收失败但无法归因（探针被外力打断等） | 看原始 `errors` 与 `attributionReasons`，人工判定后再跑 |

> 报告里的 `attributionReasons` 是**判据链**：告诉你这次为什么这么判（哪条信号命中），不必猜。

> **优先级提醒**：插件侧**硬证据**（声明 DSH 保留名 → `guard.reserved_rejected` fail）
> **优先于**上游漂移相关性——即使上游此刻正在漂移，你的保留名冲突也会如实归因为
> `PLUGIN_REGRESSION`，不会被甩成「上游变了，不是你的问题」。

**17 项检查清单**（三通道一致；**顺序 = 探针实际输出顺序**，见 `src/harness/probe-template.mjs`）：

```
 1 host.tools_ready        宿主 ToolRuntime 就绪
 2 detect.flavor_known     版本线可判定
 3 contract.probe_disposed 契约探测采集后已全部卸载（无残留）
 4 guard.reserved_name     中台保留名护栏可用（中台自检，非插件违规）
 5 compat.schema_flatten   schema 压平后无违规
 6 plugin.loaded           插件导出 apply(ctx)（import 失败/未导出 → 插件侧失败）
 7 plugin.apply_ok         插件 apply(ctx) 执行成功
 8 registry.exact          注册工具清单精确匹配
 9 dispatch.execute_ok     真实 dispatch 成功
10 dispatch.render_projected  output.render 投影正确
11 dispatch.echo_payload   业务返回值正确（插件无 *echo 工具时自动跳过）
12 dispatch.abort_semantics  exec.signal 取消语义生效
13 plugin.definitions_ok   插件导出可用的 definitions 数组
14 lifecycle.disposer_count disposer 数量正确（按可注册定义数计）
15 lifecycle.registered    独立上下文注册成功
16 lifecycle.dispose       卸载后无残留
17 guard.reserved_rejected 插件声明的保留名必须被拒绝并上报（声明即判失败）
```

> 顺序即探针实际输出顺序（`guard.reserved_rejected` 在**末尾**，依赖插件 `definitions()`）。
> 本清单顺序由 `tests/test_exports.mjs` [2b] 守住：与探针 `check()` 调用顺序不一致即红。
**另有 2 项条件检查**（不计入上表 17 项，仅在异常路径出现；唯一事实源 = `CONDITIONAL_PROBE_CHECKS`）：

| 条件检查 | 触发场景 | 归因 |
|---|---|---|
| `plugin.unexpected_exception` | **同步**异常：探针读插件侧数据（`tools.schemas()` / `definitions.map()`）时**插件代码**抛错，逃到顶层 `catch` | `PLUGIN_REGRESSION` |
| `plugin.async_uncaught_exception` | **异步**异常：插件在 `apply()` 里排的后台任务（微任务 / 定时器 / 事件回调 / 预取 promise）抛错，**不在**探针 `run()` 的调用栈上 | `PLUGIN_REGRESSION` |

两者都是「插件侧错误不进 `hostFatal[]`」这条不变量的执行点（见下）。
异步那条为何必须单独兜：不在调用栈上 ⇒ 顶层 `catch` 永远接不到 ⇒ 旧探针会在写出结构化结果前被杀，
装配器只看到「探针未输出结构化结果」→ 判 `UPSTREAM_DRIFT`/AMBER，且 `checks` 从 17 掉到 **0**。
现在探针挂了 `uncaughtException` / `unhandledRejection` 两个进程级兜底：按同一份相位路由归因，
**照常输出结构化结果**（已跑完的检查全部保留），`probePhase` 仍为 `plugin-integration`。
边界（不越权承诺）：探针是**有限时长验收**，只在收尾前给已排队的微任务/宏任务一个 50ms 排空窗口；
更晚的延迟抛错发生在探针退出之后，不属本防线范围。

**归因优先级**（`attributionReasons` 判据链按此顺序取第一条命中）：

```
1. 宿主/环境侧    结构化字段 hostFatal[] 非空（或失败项属宿主侧 check）
2. 版本线 unknown 探针无法判定版本线
3. 插件侧硬证据   插件声明了 DSH 保留名（guard.reserved_rejected）——**优先于契约漂移相关性**
4. 契约漂移相关   漂移字段与失败 check **一一对应**（表 = src/triage/index.mjs 的 DRIFT_IMPACT；
                  含 guard.reserved_name / compat.schema_flatten / detect.flavor_known / dispatch 四项精确名）
5. 无可用基线     契约 check 失败且首次采集 → 保守判漂移（让人确认）
6. 插件侧 check   插件侧 / 中台契约层检查失败（上游契约与基线一致）
7. UNKNOWN        有失败但无可识别 check（被外力打断）→ 不猜、不甩锅
```

> **`hostFatal[]` 什么时候会被写？**（写入端分相位，🔴-D）
> 探针分两段跑：`host-assembly`（宿主包 import / Context 装配 / 契约采集）与
> `plugin-integration`（插件 import / apply / definitions / dispatch / 生命周期）。
> **只有 `host-assembly` 段的未预期异常**才写 `hostFatal[]`；插件集成段的异常一律落
> **插件侧 check**（同步 `plugin.unexpected_exception` / 异步 `plugin.async_uncaught_exception` /
> `registry.exact` / `guard.reserved_rejected`）。
> 所以：`hostFatal[]` 非空 ⇒ 确实是宿主/环境侧问题；`hostFatal[]` 为空 + 插件侧 check 失败
> ⇒ 是你的插件问题（哪怕 `errors[]` 里出现了宿主侧措辞的字面量——`errors` 不参与判据）。
> 报告里的 `probePhase` 字段告诉你异常发生在哪一段，排障不必猜。
>
> **后台任务抛错也算你的问题**：插件在 `apply()` 里排的后台任务（微任务 / 定时器 / 事件回调 /
> 预取 promise）抛错时，异常不在探针 `run()` 的调用栈上——中台用进程级兜底按同一份相位路由归因，
> 落 `plugin.async_uncaught_exception`，**不会**被算成「上游变了」。已跑完的检查全部保留。

> 第 3 条是「漂移窗口内的插件 bug」不被吞的关键：上游取消保留名 = 契约漂移（照实记录），
> 但插件**仍不得**声明 `run_code`——两者互不抵消。
>
> 上游发版后先跑 `watch --markdown`：它会把「契约字段漂移 → 受影响检查 → 责任方 → 中台改哪个文件 →
> 插件要不要动」一次列清（未登记的契约字段会显式标「未登记、先补表」，**不瞎指**）。
>
> 排障口径（漂移窗口首跑顺序）：**判定漂移以首次运行或干净副本为准**。
> 漂移窗口内若先跑健康插件，该通道 `ok` → 漂移契约被写进基线，后续运行 `contractDrift.changed=false`，
> 漂移信号消失（这是「仅 ok 更新基线」的必要设计，见 `docs/RISKS.md` R18）。

---

## 五、常见坑（都已被中台处理，列此备查）

| 坑 | 现象 | 中台处置 |
|---|---|---|
| 工具名撞 `run_code` | `register()` 直接抛错，措辞提到 PTC/Code Mode | 注册前显式报「你的 prefix 选得不对」，并**上报**（见下条） |
| `output.schema` 用了 `type:'json'` | `unsupported JSON schema: ... must be one of object/array/...` | 自动压平为受支持子集 |
| `output` 只写了 `schema` | `must declare output { schema, render, presentationMeta? }` | 自动补缺省文本 `render` |
| `execute` 忽略 `exec.signal` | 取消后仍执行副作用 | 统一入口 `throwIfAborted()` |
| 同层重复注册同名工具 | `is already registered` | 中台返回 `issues`，建议先 `disposeAll()` 或用独立 `Context` |
| 工具名撞 `run_code`（保留名） | 被静默跳过、工具凭空消失 | **不静默**：进 `issues`（前缀 `reserved_name_conflict:`）+ 触发 `onIssues` + `adapter.toJSON().reservedRejected`；验收探针 `guard.reserved_rejected` 判失败 |
