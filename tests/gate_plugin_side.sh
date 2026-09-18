#!/usr/bin/env bash
# 🔴-D / 🔴 必修-2/3 闸门：**插件侧错误不得进判据字段 `hostFatal[]`**（真宿主）。
#
# ## 为什么抽成脚本（而不是在 `.cnb.yml` 的 push / PR 两段各写一份）
# 评审 🟢 重复项点名：push 段与 PR 段的闸门脚本**各自维护**（54 行差异），
# 而「两段口径不一致」正是闸门静默失效的经典形态（一处加了新夹具、另一处忘了）。
# 抽成一份后：夹具清单、断言口径、防过度修正断言**只有一处可写错**。
#
# ## 覆盖的出口 + 防线 + 一份防过度修正
# | 夹具 | 出口 / 防线 | 期望失败项 | 完成位 |
# |---|---|---|---|
# | `plugin-side-throw-plugin` | ① 同步异常（读插件侧数据抛错 getter） | `guard.reserved_rejected` | true |
# | `plugin-registry-throw-plugin` | ① 同步异常（注册项 getter 抛错） | `registry.exact` | true |
# | `plugin-async-throw-plugin` | ② 异步异常（后台微任务抛错） | `plugin.async_uncaught_exception` | true |
# | `plugin-async-reject-plugin` | ② 异步异常（预取 promise 拒绝） | `plugin.async_uncaught_exception` | true |
# | `plugin-exit-plugin` | ③ 进程 exit（插件 `process.exit(0)`） | `plugin.early_exit` | **false** |
# | `plugin-hang-plugin` | ④ `run()` 被拖住（永不 resolve） | `plugin.run_incomplete` | **false** |
# | `plugin-sigkill-plugin` | 边界：不可捕获终止（`SIGKILL`） | `plugin.abnormal_termination` | **false** |
# | `plugin-detach-handlers-plugin` | 对抗：先摘掉全部监听器再抛错 | 插件侧（不固定名，见下） | false |
# | `plugin-busy-loop-plugin` | 对抗：后台任务同步占死事件循环 | `plugin.async_uncaught_exception` | true |
# | `plugin-process-exit-plugin` | 对抗：后台定时器里 `process.exit` | 插件侧 | false |
# | `plugin-capture-callback-plugin` | H1/R22：抢占 `setUncaughtExceptionCaptureCallback` | `plugin.process_defense_tampered` | true |
# | `plugin-defense-tamper-plugin` | H1/R28：摘掉探针兜底 + 装**自己的**（计数假阳性形态） | `plugin.process_defense_tampered` | true |
# | `plugin-forged-result-plugin` | R26：伪造裸 marker 绿卡（nonce 侧信道） | `plugin.probe_result_forged` | true |
# | `plugin-nonce-reverse-read-plugin` | R26：**反读 nonce**（environ/cmdline）再伪造带 nonce 结果行 | `plugin.probe_result_forged` | true |
# | `plugin-host-tamper-poc-plugin` | **§3 反例固化**（反读 nonce + 写 fd3 + 摘 exit 钩子 + `exit(0)` 抢跑） | `plugin.probe_result_forged` + `plugin.abnormal_termination` | **false** |
# | `plugin-exit-hook-tamper-plugin` | **批 1.5 第 8 项**：只摘出口③ 的 `exit` 钩子（其余健康） | `plugin.process_defense_tampered` | true |
# | `plugin-stringify-tamper-plugin` | 🔴 必修-4：猴子补丁 `JSON.stringify` 伪造绿卡（同族：同进程 + 共用输出面） | `registry.exact` | true |
# | `plugin-channel-redirect-plugin` | 🔴-R3′：**结果通道重定向**（fd3 → 文件）+ 压 `process.exitCode`（宿主侧通道观测交叉校验） | `plugin.protocol_injection` | **false** |
# | `plugin-sync-loop-plugin` | R24：`apply()` 内同步死循环（宿主二次终止） | `plugin.abnormal_termination` | **false** |
# | `demo-plugin`（健康） | —— | 无（必须 GREEN 17/17） | true |
#
# ## 四条断言纪律（都是踩过的坑）
# 1. **只看退出码不够**：AMBER 漂移窗口内负例也会 fail → 必须同时断言 `attribution` 与 `verdict`；
# 2. **只看 attribution 不够**：必须同时断言 `hostFatal` **为空**（判据字段的写入端不变量）；
# 3. **必须有防过度修正**：健康插件在同一次运行里必须仍 GREEN 17/17——
#    否则「把所有失败都判插件」也能让上面的断言全绿（把护栏变成噪声源）；
# 4. **期望项不得写成「固定 check 名」**（M5，评审复评 §2）：`process.exit(0)` 的落点实测是
#    `plugin.apply_ok`（不是 `plugin.early_exit`）——固定名断言依赖**夹具细节**（`plugin-exit-plugin`
#    因先注册健康工具才恰好命中）。改为断言「失败项 **⊆** `PLUGIN_SIDE_CHECKS`」（从唯一事实源 import），
#    并把「必须命中的那一项」作为**可选**加强断言（`*` 后缀表示该夹具**不得**只判固定名）。
#
# 用法：`bash tests/gate_plugin_side.sh [workdir]`
# 退出码：0 = 全部通过；1 = 有断言失败。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
WORK="${1:-./.ci}"
CHANNEL="${CHANNEL:-stable}"
# 出口④ 的回归加速：宿主侧**缩短**看门狗窗口（探针只许缩短、不许延长；下限 1s）
export DSH_PROBE_RUN_WATCHDOG_MS="${DSH_PROBE_RUN_WATCHDOG_MS:-5000}"

PASS=0
FAIL=0
ok() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

# 插件侧 check 名单**从唯一事实源 import**（M5）：此前断言写死单个 check 名，
# 而落点随夹具细节浮动（`process.exit(0)` 实测落 plugin.apply_ok）⇒ 固定名断言是**假精度**。
# 从 `contract.mjs` 取名单后，「失败项 ⊆ 插件侧」才是可判定的不变量（且名单新增一项即自动生效）。
PLUGIN_SIDE_CHECKS_JSON="$("$NODE_BIN" --input-type=module -e "
import { PLUGIN_SIDE_CHECKS } from '$ROOT/src/harness/contract.mjs';
console.log(JSON.stringify(PLUGIN_SIDE_CHECKS));
")"
if [[ -z "$PLUGIN_SIDE_CHECKS_JSON" ]]; then
  echo "❌ 无法从 src/harness/contract.mjs 读取 PLUGIN_SIDE_CHECKS（唯一事实源）"; exit 1
fi

mkdir -p "$WORK"
echo "▶ 插件侧错误不得进 hostFatal[]（闸门：四条出口 + 不可捕获边界 + 防过度修正）"

# ---- 负例：必须被拦下、必须判插件侧、hostFatal 必须为空 ----
# 每行：夹具名|期望失败项|期望完成位（true/false）|是否期望「已跑完的 pass 项保留」|**完整失败项集合**（逗号分隔）
#
# 🟡-3（评审复测）：末列是本轮补的**失败项集合**断言。此前闸门只断
# 「失败项**含**期望项」——夹具多出来的**噪音失败**（如 `render: () => []` 造成的
# `dispatch.render_projected` / `dispatch.echo_payload` 失败）会被**静默放行**，
# 于是「注释说精确、实际多条失败」没人发现。现在逐夹具断言**完整集合**，
# 多一条少一条都红（夹具一旦回归成噪音源，闸门立刻看得见）。
# 末列取值来自**真宿主实测**（stable 通道，本仓 node:22），非手写推断。
# 最后一列为什么对 SIGKILL 是 false：**不可捕获终止**的定义就是「探针来不及写结构化结果」，
# 故报告里只有装配器按相位信标补的那一条 fail（没有 pass 可保留）。其余四条出口都由探针自己
# 闭合，必须保留已跑完的检查——「报告整份消失」正是本族历史缺陷最狠的地方。
# 字段：夹具|期望**必含**失败项（`-` = 只要求「失败项 ⊆ 插件侧」）|期望完成位|是否保留已跑完的 pass 项
NEGATIVE_CASES=(
  "plugin-side-throw-plugin|guard.reserved_rejected|true|true|lifecycle.registered,guard.reserved_rejected"
  "plugin-registry-throw-plugin|registry.exact|true|true|registry.exact"
  "plugin-async-throw-plugin|plugin.async_uncaught_exception|true|true|plugin.async_uncaught_exception"
  "plugin-async-reject-plugin|plugin.async_uncaught_exception|true|true|plugin.async_uncaught_exception"
  # M5（口径收窄，评审复评 §2）：落点**不固定**（实测 `process.exit(0)` 落在 plugin.apply_ok，
  # 视注册时机而定）⇒ 必含项用 `-`（只要求「失败项 ⊆ 插件侧名单」），完整集合仍逐字比对。
  "plugin-exit-plugin|-|false|true|plugin.early_exit"
  "plugin-hang-plugin|-|false|true|plugin.run_incomplete"
  "plugin-sigkill-plugin|-|false|false|plugin.abnormal_termination"
  # 本分支补的**对抗形态**（评审 🔴-D′ 原始复现的变体；每份都实测过，见 CHANGELOG v0.1.9）：
  # - detach-handlers：插件先摘掉 `process` 上的**全部**相关监听器再抛错
  #   （「探针内任何兜底都不是安全网」——归因只能靠出口钩子/相位信标）；
  # - busy-loop：后台任务**同步占死**事件循环（看门狗排不上 → 占死结束后收尾）；
  # - process-exit：与 plugin-exit 同族但走**后台定时器**（不是 apply 内直接调）。
  "plugin-detach-handlers-plugin|-|false|true|plugin.early_exit,plugin.process_defense_tampered"
  "plugin-busy-loop-plugin|plugin.async_uncaught_exception|true|true|plugin.async_uncaught_exception"
  "plugin-process-exit-plugin|-|false|true|plugin.early_exit"
  # H1（复评）：插件抢占 `setUncaughtExceptionCaptureCallback` → 探针兜底被**静音**，
  # 旧行为判 **GREEN 放行**（比 AMBER 更危险）。收口后必须判插件侧、完成位仍为 true
  # （探针确实跑完了——它只是**不知道**自己被静音了）。
  "plugin-capture-callback-plugin|plugin.process_defense_tampered|true|true|plugin.process_defense_tampered"
  # R28（复评）：摘掉探针兜底后**装一个自己的** —— 计数判据（`listenerCount>0`）在此**假阳性**，
  # 只有「身份检查」能判出。同一族、不同机理，必须各有夹具（否则修法回退无人发现）。
  "plugin-defense-tamper-plugin|plugin.process_defense_tampered|true|true|plugin.process_defense_tampered"
  # 🆕 侧信道（评审 🟡-4 / RISKS R26）：插件往 stdout 写裸 `__DSH_PROBE__` 伪造绿卡。
  # nonce 带外通道收口后：伪造行被判 `plugin.probe_result_forged`，**且**真实缺陷
  # （`registry.exact`：注册了多余工具）仍被抓住——绿卡不得掩盖真缺陷。
  "plugin-forged-result-plugin|plugin.probe_result_forged|true|true|registry.exact,plugin.probe_result_forged"
  # 🆕 **通道形态**复现（本轮新增，与上一份的分工）：上一份伪造的是**裸 marker**（无 nonce）；
  # 本份**先反读 nonce**（`/proc/self/environ` + `/proc/self/cmdline`）再伪造**带 nonce** 的结果行。
  # 若 nonce 经 **env / argv** 下发，本形态会拿到 nonce ⇒ **GREEN 放行**（实测：env 通道下确实如此）；
  # 本实现经 **stdin** 下发 ⇒ 两条读取面都拿不到 ⇒ 判伪造、不放行。
  # 这是「为什么必须用 stdin」的**可执行证据**（不是注释里的偏好）。
  "plugin-nonce-reverse-read-plugin|plugin.probe_result_forged|true|true|plugin.probe_result_forged"
  # 🆕 **§3 反例固化**（复评裁定 ④：把反例固化为真宿主夹具并进闸门）。
  # 原始 PoC 三步：反读 `/proc/self/environ` 拿 nonce → 向 **fd3** 写带 nonce 的 17/17 绿卡 →
  # `removeAllListeners('exit')` → `process.exit(0)`。当时（env 通道）实测 `GREEN / PASS / exit 0`。
  # 现在三条独立证据链各自命中：伪造前缀不匹配（nonce 经 stdin，反读拿不到）⇒ `plugin.probe_result_forged`；
  # 摘 exit 钩子 + 抢跑退出 ⇒ 相位信标落 `plugin.abnormal_termination`（探针来不及收尾自检）。
  # ⚠️ 期望**不得** GREEN —— 这条断言正是「不可达」口径作废的可执行证据。
  "plugin-host-tamper-poc-plugin|plugin.probe_result_forged|false|false|plugin.probe_result_forged,plugin.abnormal_termination"
  # 🆕 **批 1.5 第 8 项**：`'exit'` 钩子纳入防线台账。
  # 原先 `wrapProcessDefenseApis()` 只记账 `uncaughtException` / `unhandledRejection`，
  # **`'exit'` 不在台账**、身份检查也只遍历那两个事件 ⇒「出口③ 钩子被单方摘除」**不可判定**
  # （实测收口前：干净插件 + `removeAllListeners('exit')` → **不判** `plugin.process_defense_tampered`）。
  # 本夹具把变量**单独隔离**（只摘钩子，不退出/不伪造/不抛错）⇒ 必须判出该项。
  "plugin-exit-hook-tamper-plugin|plugin.process_defense_tampered|true|true|plugin.process_defense_tampered"
  # R26 的**结构级**防线（`plugin.protocol_injection`）的**可达性口径**（复评 🔴-R1 更正）：
  # 它要求「**匹配 nonce 前缀**的结果行 ≥2 条 / 出现在 stdout」⇒ **可达当且仅当插件拿得到 nonce**。
  # 当前实现 nonce 经 **stdin** 下发（**不经 env / argv**）⇒ 经这两条**读取面**不可达（已由
  # 离线 [9.11e] 的通道形态守卫钉住）；但**同进程同 uid** 下插件仍可用**其它**手段拿到 nonce
  # （猴子补丁 / 读内存）⇒ **不得**写「真宿主不可达」（那是把未验证的命题写成对外口径，见 R26）。
  # 故本项在真宿主侧由上面两份夹具（侧信道 / §3 反例）覆盖，结构级形态由离线 [9.11f]
  # 用**可证伪**的正反两条断言覆盖（构造输入→必须命中；去掉 nonce→必须不命中）。
  # 🔴 必修-4（评审复评，与 🔴-3 **同族**）：插件**不改输出协议、不改通道**，而是猴子补丁
  # `JSON.stringify` —— 探针若在写出报告时才取全局，报告字节就被插件决定（一张完美绿卡，
  # nonce 前缀照样匹配）。收口 = 探针**加载期捕获引用** + 装配器**退出码交叉**（两道并集）。
  # 本形态下探针的**真报告**仍被判出 ⇒ 失败项精确留在真缺陷 `registry.exact` 上。
  "plugin-stringify-tamper-plugin|registry.exact|true|true|registry.exact"
  # 🔴-R3′（评审复评，收窄后的活口）：**结果通道重定向 + 压退出码**。同源活口的两个出口都走这条：
  #   · `all`（默认，= R3′）：`closeSync(3)` + `openSync(<file>)` 把 fd3 换成普通文件（宿主侧管道
  #     只见 EOF）；探针收尾把**真报告**写进文件 ⇒ 插件在 `exit` 钩子里读回它（**连 nonce 前缀
  #     一起拿到**）⇒ 用该前缀把绿卡写进 stdout ⇒ 再压 `process.exitCode = 0` 压掉退出码交叉；
  #   · `no-squelch`（= R3 主形态）：只重定向、不压退出码。
  # 收口判据 = **宿主侧通道观测**（报告自称 fd3 而宿主侧 fd3 为空 + stdout 有匹配 nonce 行）——
  # 只依赖宿主进程看到的东西 ⇒ 插件压不掉。期望：判 `plugin.protocol_injection`、不采信任何一条
  # （故**无 pass 项**、完成位 false）、hostFatal 为空。
  # ⚠️ 期望**不得** GREEN —— 这条断言正是「退出码交叉不是唯一兜底」的可执行证据。
  "plugin-channel-redirect-plugin|plugin.protocol_injection|false|false|plugin.protocol_injection"
  # ⚠️ `plugin-sync-loop-plugin`（R24）**不在**本清单：它的缺陷只在**有界 timeout** 下成立
  # （默认 timeoutMs=600s 时 3s 循环会正常跑完——那本身不是缺陷）。该形态由下方**专用 R24 段**
  # 用 `runHostProbe({ timeoutMs: 1000 })` 断言（含收口时间与 `probeExit.signal`）。
)

for entry in "${NEGATIVE_CASES[@]}"; do
  IFS='|' read -r fixture expectedCheck expectedCompleted expectsPass expectedFails <<< "$entry"
  out="$WORK/verify-$fixture.json"
  if "$NODE_BIN" "$ROOT/src/cli.mjs" verify --channel "$CHANNEL" \
      --plugin "$ROOT/tests/fixtures/$fixture.mjs" --tools demo_echo \
      --json "$out" > /dev/null 2>&1; then
    bad "$fixture 被误判为通过（护栏失效）"
    continue
  fi
  "$NODE_BIN" -e '
    const [file, fixture, expectedCheck, expectedCompleted, expectsPass, expectedFails, pluginSideChecksJson] = process.argv.slice(1);
    const pluginSide = new Set(JSON.parse(pluginSideChecksJson));
    const r = require(file);
    const c = r.channels[0] ?? {};
    const checks = c.checks ?? [];
    const failed = checks.filter((x) => x.status === "fail").map((x) => x.name);
    const bad = [];
    if (c.attribution !== "PLUGIN_REGRESSION") bad.push("归因不是 PLUGIN_REGRESSION（实得 " + c.attribution + "）");
    if ((c.hostFatal ?? []).length !== 0) bad.push("hostFatal 非空（插件侧错误写进了判据字段）：" + JSON.stringify(c.hostFatal));
    if (r.summary.verdict === "AMBER") bad.push("判决为 AMBER（插件 bug 被甩给上游）");
    if (checks.length === 0) bad.push("checks 为空（报告整份消失——旧缺陷形态）");
    // 「已跑完的 pass 项必须保留」只对**可捕获**出口成立（不可捕获终止时探针没机会写报告）
    if (expectsPass === "true" && !checks.some((x) => x.status === "pass")) bad.push("无 pass 项（已跑完的检查被丢弃）");
    // 反向：不可捕获出口若**出现** pass 项，说明报告形态异常，必须红
    if (expectsPass === "false" && checks.some((x) => x.status === "pass")) bad.push("不可捕获终止却出现 pass 项（形态异常）");
    // M5（口径收窄，评审复评 §2）：**失败项必须全部落在插件侧名单内**（名单从唯一事实源 import），
    // 而不是断言某个固定名字 —— `process.exit(0)` 的落点实测是 plugin.apply_ok（非 plugin.early_exit），
    // 固定名断言依赖夹具细节。名单外的失败项 = 归因表漏登记（会退化成 UNKNOWN）或宿主侧信号混入。
    const offList = failed.filter((x) => !pluginSide.has(x));
    if (offList.length > 0) bad.push("失败项不在插件侧名单内：" + offList.join(","));
    // 加强断言：夹具**必须**命中某一项时（字段 != "-"）才校验固定名
    if (expectedCheck !== "-" && !failed.includes(expectedCheck)) bad.push("失败项不含 " + expectedCheck + "（实得：" + failed.join(",") + "）");
    // 🟡-3：**完整失败项集合**断言（不再只断「含」）。多一条（噪音失败）或少一条（防线丢了）都红。
    // 排序后逐字比对：夹具自述「失败点精确」就必须真的精确，否则闸门看得见。
    const want = (expectedFails || "").split(",").map((x) => x.trim()).filter(Boolean).sort();
    const got = [...failed].sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      bad.push("失败项集合不符：期望 [" + want.join(",") + "] 实得 [" + got.join(",") + "]");
    }
    // 完成位：未跑完的运行**不得**判通过（假绿比 AMBER 更危险，🔴 必修-1）
    const completed = c.runCompleted === true;
    if (String(completed) !== expectedCompleted) bad.push("完成位 runCompleted=" + completed + "（期望 " + expectedCompleted + "）");
    if (completed === false && r.summary.verdict === "GREEN") bad.push("未跑完却判 GREEN（假绿）");
    if (bad.length) { console.error("❌ 闸门失败：" + bad.join("；")); process.exit(1); }
    console.log("✅ " + fixture + "：PLUGIN_REGRESSION / hostFatal 为空 / 失败项均在插件侧名单 / 集合=[" + got.join(",") + "] / checks=" + checks.length + " / 完成位=" + completed + " / verdict=" + r.summary.verdict);
  ' "$out" "$fixture" "$expectedCheck" "$expectedCompleted" "$expectsPass" "$expectedFails" "$PLUGIN_SIDE_CHECKS_JSON"
  if [[ $? -eq 0 ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
done

# ---- R24：同步死循环 → 宿主**二次终止**（`killSignal: 'SIGKILL'`） ----
# 为什么单列（评审复评 R24）：探针的看门狗 / 信号处理器都是事件循环上的回调，插件 `apply()`
# 同步占满事件循环后两者都不执行；而探针为出口③ 装了 `SIGTERM` 处理器 ⇒ Node 默认终止行为被禁用
# ⇒ 宿主**杀不掉**探针（实测 timeout=5000 却耗时 30.3s；`while(true)` 形态永久挂死，吃满 CI 额度）。
# 断言四条：① 收口时间 < timeoutMs × 3；② `probeExit.signal === 'SIGKILL'`；
# ③ 归因插件侧（相位信标）；④ `hostFatal` 为空。**外加反向护栏**：默认超时未被压小（健康插件仍 17/17）。
echo
echo "▶ R24：同步死循环（宿主二次终止 SIGKILL + 相位信标归因）"
R24_OUT="$("$NODE_BIN" --input-type=module -e "
import path from 'node:path';
import { runHostProbe, loadChannels } from '$ROOT/src/harness/host.mjs';
import { attributeFailure } from '$ROOT/src/verify/runner.mjs';
const chanTable = loadChannels('$ROOT');
const channel = chanTable.channels['$CHANNEL'];
const t = Date.now();
const probe = runHostProbe({
  channelName: '$CHANNEL', channel,
  pluginPath: path.join('$ROOT', 'tests/fixtures/plugin-sync-loop-plugin.mjs'),
  expectedTools: ['demo_echo'], hubRoot: '$ROOT', timeoutMs: 1000,
});
const elapsed = Date.now() - t;
const fails = (probe.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.name);
console.log(JSON.stringify({
  elapsed,
  signal: probe.probeExit?.signal ?? null,
  status: probe.probeExit?.status ?? null,
  attribution: attributeFailure(probe, channel, '$CHANNEL'),
  hostFatal: (probe.hostFatal ?? []).length,
  completed: probe.runCompleted === true,
  fails,
}));
" 2>/dev/null || echo '{}')"
r24() { echo "$R24_OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(eval('r$1'))})"; }
assert_r24() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1（期望 $3 / 实得 $2）"; fi; }
assert_r24 "R24：同步死循环被宿主二次终止（probeExit.signal=SIGKILL）" "$(r24 '.signal')" "SIGKILL"
assert_r24 "R24：收口时间 < timeoutMs × 3（不得挂死 / 不得吃满额度）" "$(r24 '.elapsed < 3000')" "true"
assert_r24 "R24：按相位信标归因插件侧（plugin.abnormal_termination）" "$(r24 '.fails.includes("plugin.abnormal_termination")')" "true"
assert_r24 "R24：归因 PLUGIN_REGRESSION（有信标 ⇒ 不判 UPSTREAM_DRIFT）" "$(r24 '.attribution')" "PLUGIN_REGRESSION"
assert_r24 "R24：hostFatal 为空 + 完成位 false（插件侧 / 不放行）" "$(r24 '.hostFatal + "|" + r.completed')" "0|false"
# 反向护栏（防「把 timeout 调小」式过度修正）：默认超时下健康插件仍 17/17。
R24_HEALTHY="$("$NODE_BIN" --input-type=module -e "
import path from 'node:path';
import { runHostProbe, loadChannels } from '$ROOT/src/harness/host.mjs';
const chanTable = loadChannels('$ROOT');
const probe = runHostProbe({
  channelName: '$CHANNEL', channel: chanTable.channels['$CHANNEL'],
  pluginPath: path.join('$ROOT', 'tests/fixtures/demo-plugin.mjs'),
  expectedTools: ['demo_echo', 'demo_status'], hubRoot: '$ROOT',
});
console.log(JSON.stringify({
  pass: (probe.checks ?? []).filter((c) => c.status === 'pass').length,
  fails: (probe.checks ?? []).filter((c) => c.status === 'fail').length,
  completed: probe.runCompleted === true, hostFatal: (probe.hostFatal ?? []).length,
}));
" 2>/dev/null || echo '{}')"
assert_r24 "R24 反向护栏：默认超时未被压小（健康插件仍 17/17 全绿）" "$(echo "$R24_HEALTHY" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.pass+'|'+r.fails+'|'+r.completed+'|'+r.hostFatal)})")" "17|0|true|0"

# ---- 防过度修正：健康插件必须仍 GREEN 17/17（否则「全判插件」也能让上面全绿） ----
healthy="$WORK/verify-healthy.json"
if "$NODE_BIN" "$ROOT/src/cli.mjs" verify --channel "$CHANNEL" \
    --plugin "$ROOT/tests/fixtures/demo-plugin.mjs" --tools demo_echo,demo_status \
    --json "$healthy" > /dev/null 2>&1; then
  "$NODE_BIN" -e '
    const c = require(process.argv[1]).channels[0] ?? {};
    const checks = c.checks ?? [];
    const fails = checks.filter((x) => x.status === "fail").map((x) => x.name);
    const bad = [];
    if (c.attribution !== "PASS") bad.push("归因不是 PASS（实得 " + c.attribution + "）");
    if (checks.length !== 17) bad.push("检查项数 " + checks.length + " ≠ 17");
    if (fails.length !== 0) bad.push("健康插件出现失败项：" + fails.join(","));
    if ((c.hostFatal ?? []).length !== 0) bad.push("hostFatal 非空");
    if (c.runCompleted !== true) bad.push("完成位不是 true（健康插件必须跑完）");
    if (bad.length) { console.error("❌ 防过度修正断言失败：" + bad.join("；")); process.exit(1); }
    console.log("✅ 防过度修正：健康插件仍 PASS / 17-17 全绿 / 完成位=true");
  ' "$healthy"
  if [[ $? -eq 0 ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
else
  bad "防过度修正：健康插件竟未通过（四条出口的兜底把正常路径也判红了 —— 过度修正）"
fi

echo
echo "▶ 闸门结果：PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
