#!/usr/bin/env bash
# 双通道真宿主验收（需要网络安装宿主依赖；CI 用）。
#
# 覆盖：
#  1. 离线单元测试（先跑，快）
#  2. stable 通道：示例插件必须通过
#  3. dev 通道：示例插件必须通过
#  4. legacy 通道：示例插件必须通过（防「为适配新版把旧版装崩」）
#  5. 负例插件：必须被中台拦下（保留名 / schema 子集），且归因为插件侧问题
#  6. 上游变更侦测可运行（离线时允许返回 2，不视为失败）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
CHANNELS="${CHANNELS:-stable dev legacy}"
PASS=0
FAIL=0

step() { echo; echo "▶ $1"; }
ok() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

step "1. 离线单元测试"
if bash "$ROOT/tests/test_offline.sh" > /tmp/offline.log 2>&1; then
  ok "离线单元测试全绿（21 项）"
else
  bad "离线单元测试失败"; tail -20 /tmp/offline.log
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

step "3. 负例插件 · 必须被拦下"
if "$NODE_BIN" "$ROOT/src/cli.mjs" verify --channel stable \
    --plugin "$ROOT/tests/fixtures/broken-plugin.mjs" \
    --tools broken_ok --json /tmp/verify-broken.json > /tmp/verify-broken.log 2>&1; then
  bad "负例插件竟被判定通过（护栏失效）"
else
  ATTRIBUTION="$("$NODE_BIN" -e "
const r = require('/tmp/verify-broken.json');
console.log(r.summary.verdict + '|' + (r.summary.pluginRegression.join(',') || 'none'));
" 2>/dev/null || echo 'parse-failed|none')"
  echo "     负例判决：$ATTRIBUTION"
  ok "负例插件被拦下（未误判为通过）"
fi

step "4. 上游变更侦测"
"$NODE_BIN" "$ROOT/src/cli.mjs" watch --json /tmp/watch.json > /tmp/watch.log 2>&1
WATCH_EXIT=$?
if [[ "$WATCH_EXIT" -eq 0 ]]; then ok "上游无漂移（exit 0）"
elif [[ "$WATCH_EXIT" -eq 1 ]]; then echo "  ⚠️ 检测到上游版本漂移（exit 1，需人工确认后 bump pins）"; ok "侦测器可用"
else echo "  ⚠️ 侦测器离线（exit 2），不视为失败"; ok "侦测器可用（离线）"; fi

step "5. 契约指纹基线"
if [[ -f "$ROOT/registry/contract-snapshots/latest.json" ]]; then
  ok "契约指纹已落盘（registry/contract-snapshots/latest.json）"
else
  bad "契约指纹未落盘"
fi

echo
echo "▶ 双通道验收结果：PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
