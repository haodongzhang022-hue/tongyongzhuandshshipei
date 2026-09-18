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
# 测试项数**从输出里取**（不再硬编码）：硬编码计数与文档/实际三者互漂，是 P2-9 同族问题的根。
# 用法：count_of <logfile> → 输出 PASS 数（取不到则输出 ?，调用方据此判红）。
count_of() { sed -n 's/.*PASS=\([0-9]*\).*/\1/p' "$1" | tail -1; }
ok() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

step "1. 离线单元测试 + 归因离线回归"
if bash "$ROOT/tests/test_offline.sh" > /tmp/offline.log 2>&1; then
  ok "离线单元测试全绿（$(count_of /tmp/offline.log) 项）"
else
  bad "离线单元测试失败"; tail -20 /tmp/offline.log
fi
if "$NODE_BIN" "$ROOT/tests/test_attribution.mjs" > /tmp/attribution.log 2>&1; then
  ok "归因离线回归全绿（$(count_of /tmp/attribution.log) 项：判据只读结构化字段 + 硬证据优先 + 🔴-D 相位化兜底 + 进程边界守卫（异步异常/进程 exit/挂住超时/信号）+ P2-10 守卫加固）"
else
  bad "归因离线回归失败"; tail -20 /tmp/attribution.log
fi
if "$NODE_BIN" "$ROOT/tests/test_exports.mjs" > /tmp/exports.log 2>&1; then
  ok "发布面自检全绿（exports 全解析 + 模板拷贝可用 + 文档清单顺序一致，$(count_of /tmp/exports.log) 项）"
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
  ok "归因端到端回归全绿（$(count_of /tmp/e2e.log) 项；含 🔴-A / 🔴-B / 🔴-C / 🔴-D + 异步活口/进程 exit/挂住超时出口复现场景 + attribution/verdict/完成位三断言）"
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

step "7. 文档计数防漂移（文档声明的项数必须等于实际跑出来的项数）"
# P2-9 同族：文档/编排里的「N 项」最容易与实际脱节（59/48/34 就曾残留两轮）。
# 这里把**实际**项数与文档声明**逐一对齐**：任一文档写错 → 本节红（不是靠人眼复核）。
#
# 🟡-2（本轮）：**声明缺失即判红**（原实现 `⚠️ 跳过` → 删掉声明行反而全绿，守卫静默失效）；
# 并移除 `DOC_COUNT_MISMATCH` 死变量（此前只在函数内自增、从未参与最终判定 —— 尾部只看 `FAIL`）。
check_doc_count() {
  local label="$1" actual="$2" pattern="$3" file="$4"
  local declared
  declared="$(grep -oE "$pattern" "$ROOT/$file" | head -1 | sed -E 's/.* ([0-9]+) 项$/\1/')"
  if [[ -z "$declared" ]]; then
    # 声明是**必需项**：删掉声明 = 防漂移防线失效（历史缺陷：删声明行 → 三条比对全部跳过 → 全绿）
    bad "$file 缺「$label」的项数声明（声明是必需项，缺失即防线失效）"
    return
  fi
  if [[ "$declared" == "$actual" ]]; then
    ok "$file 的「$label」项数 = 实际（$actual）"
  else
    bad "$file 的「$label」声明 $declared 项，实际 $actual 项（文档漂移）"
  fi
}
check_doc_count "离线单测" "$(count_of /tmp/offline.log)" '离线单测 [0-9]+ 项' 'README.md'
check_doc_count "归因离线回归" "$(count_of /tmp/attribution.log)" '归因离线回归 [0-9]+ 项' 'README.md'
check_doc_count "归因端到端回归" "$(count_of /tmp/e2e.log)" '归因端到端回归 [0-9]+ 项' 'README.md'
check_doc_count "离线单测" "$(count_of /tmp/offline.log)" '离线单测 [0-9]+ 项' 'docs/ARCHITECTURE.md'
check_doc_count "归因离线回归" "$(count_of /tmp/attribution.log)" '归因离线回归 [0-9]+ 项' 'docs/ARCHITECTURE.md'
check_doc_count "归因端到端回归" "$(count_of /tmp/e2e.log)" '归因端到端回归 [0-9]+ 项' 'docs/ARCHITECTURE.md'
check_doc_count "离线单测" "$(count_of /tmp/offline.log)" '离线单测 . .tests/test_offline.sh. . 测试 . [0-9]+ 项' 'docs/INDEX.md'
check_doc_count "归因离线回归" "$(count_of /tmp/attribution.log)" '归因离线回归 . .tests/test_attribution.mjs. . 测试 . [0-9]+ 项' 'docs/INDEX.md'
check_doc_count "归因端到端回归" "$(count_of /tmp/e2e.log)" '归因端到端回归 . .tests/test_e2e_regression.mjs. . 测试 . [0-9]+ 项' 'docs/INDEX.md'

echo
echo "▶ 双通道验收结果：PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
