#!/usr/bin/env bash
# 🔴-D / 🔴 必修-2/3 闸门：**插件侧错误不得进判据字段 `hostFatal[]`**（真宿主）。
#
# ## 为什么抽成脚本（而不是在 `.cnb.yml` 的 push / PR 两段各写一份）
# 评审 🟢 重复项点名：push 段与 PR 段的闸门脚本**各自维护**（54 行差异），
# 而「两段口径不一致」正是闸门静默失效的经典形态（一处加了新夹具、另一处忘了）。
# 抽成一份后：夹具清单、断言口径、防过度修正断言**只有一处可写错**。
#
# ## 覆盖的五条出口 + 一份防过度修正
# | 夹具 | 出口 | 期望失败项 | 完成位 |
# |---|---|---|---|
# | `plugin-side-throw-plugin` | ① 同步异常（读插件侧数据抛错 getter） | `guard.reserved_rejected` | true |
# | `plugin-registry-throw-plugin` | ① 同步异常（注册项 getter 抛错） | `registry.exact` | true |
# | `plugin-async-throw-plugin` | ② 异步异常（后台微任务抛错） | `plugin.async_uncaught_exception` | true |
# | `plugin-async-reject-plugin` | ② 异步异常（预取 promise 拒绝） | `plugin.async_uncaught_exception` | true |
# | `plugin-exit-plugin` | ③ 进程 exit（插件 `process.exit(0)`） | `plugin.early_exit` | **false** |
# | `plugin-hang-plugin` | ④ `run()` 被拖住（永不 resolve） | `plugin.run_incomplete` | **false** |
# | `plugin-sigkill-plugin` | 边界：不可捕获终止（`SIGKILL`） | `plugin.abnormal_termination` | **false** |
# | `demo-plugin`（健康） | —— | 无（必须 GREEN 17/17） | true |
#
# ## 三条断言纪律（都是踩过的坑）
# 1. **只看退出码不够**：AMBER 漂移窗口内负例也会 fail → 必须同时断言 `attribution` 与 `verdict`；
# 2. **只看 attribution 不够**：必须同时断言 `hostFatal` **为空**（判据字段的写入端不变量）；
# 3. **必须有防过度修正**：健康插件在同一次运行里必须仍 GREEN 17/17——
#    否则「把所有失败都判插件」也能让上面的断言全绿（把护栏变成噪声源）。
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
NEGATIVE_CASES=(
  "plugin-side-throw-plugin|guard.reserved_rejected|true|true|lifecycle.registered,guard.reserved_rejected"
  "plugin-registry-throw-plugin|registry.exact|true|true|registry.exact"
  "plugin-async-throw-plugin|plugin.async_uncaught_exception|true|true|plugin.async_uncaught_exception"
  "plugin-async-reject-plugin|plugin.async_uncaught_exception|true|true|plugin.async_uncaught_exception"
  "plugin-exit-plugin|plugin.early_exit|false|true|plugin.early_exit"
  "plugin-hang-plugin|plugin.run_incomplete|false|true|plugin.run_incomplete"
  "plugin-sigkill-plugin|plugin.abnormal_termination|false|false|plugin.abnormal_termination"
  # 本分支补的**对抗形态**（评审 🔴-D′ 原始复现的变体；每份都实测过，见 CHANGELOG v0.1.9）：
  # - detach-handlers：插件先摘掉 `process` 上的**全部**相关监听器再抛错
  #   （「探针内任何兜底都不是安全网」——归因只能靠出口钩子/相位信标）；
  # - busy-loop：后台任务**同步占死**事件循环（看门狗排不上 → 占死结束后收尾）；
  # - process-exit：与 plugin-exit 同族但走**后台定时器**（不是 apply 内直接调）。
  "plugin-detach-handlers-plugin|plugin.early_exit|false|true|plugin.early_exit,plugin.process_defense_tampered"
  "plugin-busy-loop-plugin|plugin.async_uncaught_exception|true|true|plugin.async_uncaught_exception"
  "plugin-process-exit-plugin|plugin.early_exit|false|true|plugin.early_exit"
  # H1（复评）：插件抢占 `setUncaughtExceptionCaptureCallback` → 探针兜底被**静音**，
  # 旧行为判 **GREEN 放行**（比 AMBER 更危险）。收口后必须判插件侧、完成位仍为 true
  # （探针确实跑完了——它只是**不知道**自己被静音了）。
  "plugin-capture-callback-plugin|plugin.process_defense_tampered|true|true|plugin.process_defense_tampered"
  # 🆕 侧信道（评审 🟡-4 / RISKS R26）：插件往 stdout 写裸 `__DSH_PROBE__` 伪造绿卡。
  # nonce 带外通道收口后：伪造行被判 `plugin.probe_result_forged`，**且**真实缺陷
  # （`registry.exact`：注册了多余工具）仍被抓住——绿卡不得掩盖真缺陷。
  "plugin-forged-result-plugin|plugin.probe_result_forged|true|true|registry.exact,plugin.probe_result_forged"
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
    const [file, fixture, expectedCheck, expectedCompleted, expectsPass, expectedFails] = process.argv.slice(1);
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
    // 反向：可捕获出口若**没有** pass 项，说明报告形态退化成「整份消失」，必须红
    if (expectsPass === "false" && checks.some((x) => x.status === "pass")) bad.push("不可捕获终止却出现 pass 项（形态异常）");
    if (!failed.includes(expectedCheck)) bad.push("失败项不含 " + expectedCheck + "（实得：" + failed.join(",") + "）");
    // 🟡-3：**完整失败项集合**断言（不再只断"含"）。多一条（噪音失败）或少一条（防线丢了）都红。
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
    console.log("✅ " + fixture + "：PLUGIN_REGRESSION / hostFatal 为空 / checks=" + checks.length + " / 完成位=" + completed + " / 失败项集合=[" + got.join(",") + "] / verdict=" + r.summary.verdict);
  ' "$out" "$fixture" "$expectedCheck" "$expectedCompleted" "$expectsPass" "$expectedFails"
  if [[ $? -eq 0 ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
done

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
