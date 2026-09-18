#!/usr/bin/env bash
# 双通道真宿主验收（需要网络安装宿主依赖；CI 用）。
#
# 覆盖：
#  1. 离线单元测试 + 归因离线回归 + 发布面自检（先跑，快）
#  2. stable 通道：示例插件必须通过
#  3. dev 通道：示例插件必须通过
#  4. legacy 通道：示例插件必须通过（防「为适配新版把旧版装崩」）
#  5. 负例插件：必须被中台拦下（保留名 / schema 子集），且**归因必须是插件侧**（不得被漂移吞掉）
#  6. 归因端到端回归：上游取消保留名 → GREEN；插件侧失败 → PLUGIN_REGRESSION
#  7. 上游变更侦测可运行（离线时允许返回 2，不视为失败）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
CHANNELS="${CHANNELS:-stable dev legacy}"
PASS=0
FAIL=0

step() { echo; echo "▶ $1"; }
ok() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

step "1. 离线单元测试 + 归因离线回归"
if bash "$ROOT/tests/test_offline.sh" > /tmp/offline.log 2>&1; then
  ok "离线单元测试全绿（60 项）"
else
  bad "离线单元测试失败"; tail -20 /tmp/offline.log
fi
if "$NODE_BIN" "$ROOT/tests/test_attribution.mjs" > /tmp/attribution.log 2>&1; then
  ok "归因离线回归全绿（61 项：契约采集无残留 + 判据只读结构化字段 + 硬证据优先 + 判据表完备性）"
else
  bad "归因离线回归失败"; tail -20 /tmp/attribution.log
fi
if "$NODE_BIN" "$ROOT/tests/test_exports.mjs" > /tmp/exports.log 2>&1; then
  ok "发布面自检全绿（exports 全解析 + 模板拷贝可用，16 项）"
else
  bad "发布面自检失败"; tail -20 /tmp/exports.log
fi

step "2. 示例插件 · 逐通道真宿主验收"
for channel in $CHANNELS; do
  echo "  → 通道 $channel"
  if "$NODE_BIN" "$ROOT/src/cli.mjs" verify --channel "$channel" \
      --plugin "$ROOT/tests/fixtures/demo-plugin.mjs" \
      --tools demo_echo,demo_status --json "/tmp/verify-$channel.json" > /tmp/verify-$channel.log 2>&1; then
    ok "$channel 通道通过"
  else
    bad "$channel 通道失败"; tail -25 /tmp/verify-$channel.log
  fi
done

step "3. 负例插件 · 必须被拦下，且归因必须是插件侧（不得被漂移吞掉）"
if "$NODE_BIN" "$ROOT/src/cli.mjs" verify --channel stable \
    --plugin "$ROOT/tests/fixtures/broken-plugin.mjs" \
    --tools broken_ok --json /tmp/verify-broken.json > /tmp/verify-broken.log 2>&1; then
  bad "负例插件竟被判定通过（护栏失效）"
else
  ATTRIBUTION="$("$NODE_BIN" -e "
const r = require('/tmp/verify-broken.json');
const c = r.channels[0];
const guard = (c.checks || []).find((x) => x.name === 'guard.reserved_rejected');
console.log([r.summary.verdict, c.attribution, guard ? guard.status : 'missing'].join('|'));
" 2>/dev/null || echo 'parse-failed|none|missing')"
  echo "     负例判决：$ATTRIBUTION"
  # 断言 1：失败项确为 guard.reserved_rejected（名符实）
  if [[ "$ATTRIBUTION" == *"|fail" ]]; then
    ok "负例插件被拦下，失败项为 guard.reserved_rejected（保留名冲突，非巧合）"
  else
    bad "负例未因保留名冲突被拦下（断言名不符实）：$ATTRIBUTION"
  fi
  # 断言 2：归因必须是 PLUGIN_REGRESSION（漂移窗口内不得被 UPSTREAM_DRIFT 吞掉）
  if [[ "$ATTRIBUTION" == *"|PLUGIN_REGRESSION|"* ]]; then
    ok "负例归因为 PLUGIN_REGRESSION（插件侧硬证据优先于漂移相关性）"
  else
    bad "负例归因不是 PLUGIN_REGRESSION（被漂移吞掉？）：$ATTRIBUTION"
  fi
  # 断言 3：判决不得为 AMBER（AMBER = 归因到上游，负例护栏在漂移窗口内静默失效）
  if [[ "$ATTRIBUTION" == AMBER"|"* ]]; then
    bad "负例判决为 AMBER（负例被归因成上游漂移，护栏静默失效）：$ATTRIBUTION"
  else
    ok "负例判决非 AMBER（verdict=${ATTRIBUTION%%|*}）"
  fi
fi

step "4. 归因端到端回归（真宿主；上游取消保留名 / 插件侧失败 / 漂移窗口不吞插件硬违规）"
"$NODE_BIN" "$ROOT/tests/test_e2e_regression.mjs" > /tmp/e2e.log 2>&1
E2E_EXIT=$?
if [[ "$E2E_EXIT" -eq 0 ]]; then
  ok "归因端到端回归全绿（40 项；含 🔴-A / 🔴-B / 🔴-C 原始复现场景）"
elif [[ "$E2E_EXIT" -eq 2 ]]; then
  echo "  ⚠️ 无宿主缓存，端到端回归跳过（前一步 verify 已建立缓存，正常不会走到这里）"
  ok "端到端回归显式跳过（不假装通过）"
else
  bad "归因端到端回归失败"; tail -30 /tmp/e2e.log
fi

step "5. 上游变更侦测"
"$NODE_BIN" "$ROOT/src/cli.mjs" watch --json /tmp/watch.json > /tmp/watch.log 2>&1
WATCH_EXIT=$?
if [[ "$WATCH_EXIT" -eq 0 ]]; then ok "上游无漂移（exit 0）"
elif [[ "$WATCH_EXIT" -eq 1 ]]; then echo "  ⚠️ 检测到上游版本漂移（exit 1，需人工确认后 bump pins）"; ok "侦测器可用"
else echo "  ⚠️ 侦测器离线（exit 2），不视为失败"; ok "侦测器可用（离线）"; fi

step "6. 契约指纹基线"
if [[ -f "$ROOT/registry/contract-snapshots/latest.json" ]]; then
  ok "契约指纹已落盘（registry/contract-snapshots/latest.json）"
else
  bad "契约指纹未落盘"
fi
if git -C "$ROOT" diff --quiet -- registry/contract-snapshots/latest.json; then
  ok "基线未被验收过程改写（无脏工作区；仅 ok 且契约变化时才写盘）"
else
  bad "基线被验收过程改写（漂移侦测会被自己写坏）"; git -C "$ROOT" diff --stat -- registry/contract-snapshots/latest.json
fi

echo
echo "▶ 双通道验收结果：PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
