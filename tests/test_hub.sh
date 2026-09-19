#!/usr/bin/env bash
# 双通道真宿主验收（需要网络安装宿主依赖；CI 用）。
#
# 覆盖：
#  1. 离线单元测试 + 归因离线回归 + 发布面自检（先跑，快）
#  2. stable 通道：示例插件必须通过
#  3. dev 通道：示例插件必须通过
#  4. legacy 通道：示例插件必须通过（防「为适配新版把旧版装崩」）
#  5. 负例插件：必须被中台拦下（保留名 / schema 子集），且**归因必须是插件侧**（不得被漂移吞掉）
#  5b. 🔴-D / 🔴-D′ 闸门：8 份夹具（探针活着·同步/异步 + **探针被插件杀掉**）→ 必须判插件侧
#      且 hostFatal 为空、17 项一项不缺（与 .cnb.yml push/PR 段**共用同一脚本**，防两处漂移）
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
  ok "归因离线回归全绿（$(count_of /tmp/attribution.log) 项：判据只读结构化字段 + 硬证据优先 + 🔴-D 相位化兜底 + P2-10 守卫加固）"
else
  bad "归因离线回归失败"; tail -20 /tmp/attribution.log
fi
if "$NODE_BIN" "$ROOT/tests/test_exports.mjs" > /tmp/exports.log 2>&1; then
  ok "发布面自检全绿（exports 全解析 + 模板拷贝可用 + 文档清单顺序一致，$(count_of /tmp/exports.log) 项）"
else
  bad "发布面自检失败"; tail -20 /tmp/exports.log
fi
# 契约基线「分段 + 只读」守卫（v0.3.0）：verify 不得写基线 / settle 是唯一写入点 / CI 接线正确
if "$NODE_BIN" "$ROOT/tests/test_baseline_guard.mjs" > /tmp/baseline-guard.log 2>&1; then
  ok "基线分段守卫全绿（$(sed -n 's/.*基线守卫）：\([0-9]*\) 项通过.*/\1/p' /tmp/baseline-guard.log) 项：verify 只读 + settle 唯一写入点 + 10:00 结算接线）"
else
  bad "基线分段守卫失败"; tail -20 /tmp/baseline-guard.log
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
  ok "归因端到端回归全绿（$(count_of /tmp/e2e.log) 项；含 🔴-A / 🔴-B / 🔴-C / 🔴-D 复现场景 + attribution/verdict 双断言）"
elif [[ "$E2E_EXIT" -eq 2 ]]; then
  echo "  ⚠️ 无宿主缓存，端到端回归跳过（前一步 verify 已建立缓存，正常不会走到这里）"
  ok "端到端回归显式跳过（不假装通过）"
else
  bad "归因端到端回归失败"; tail -30 /tmp/e2e.log
fi

step "4b. 插件侧错误不得进 hostFatal[]（四条出口 + 不可捕获边界 + 防过度修正）"
# 为什么放进 test_hub.sh：这一步此前只存在于 .cnb.yml（CI 专属）⇒ 本地 `bash tests/test_hub.sh`
# 跑不到，出问题只能等 CI。现在两处**共用同一份脚本**（tests/gate_plugin_side.sh），
# 口径与夹具清单只有一处可写错（评审 🟢 重复项）。
if DSH_PROBE_RUN_WATCHDOG_MS=5000 bash "$ROOT/tests/gate_plugin_side.sh" /tmp/gate > /tmp/gate.log 2>&1; then
  ok "插件侧闸门全绿（$(count_of /tmp/gate.log) 项：四条出口 + SIGKILL 边界 + 健康插件 17/17）"
else
  bad "插件侧闸门失败"; tail -20 /tmp/gate.log
fi

step "5. 上游变更侦测"
"$NODE_BIN" "$ROOT/src/cli.mjs" watch --json /tmp/watch.json > /tmp/watch.log 2>&1
WATCH_EXIT=$?
if [[ "$WATCH_EXIT" -eq 0 ]]; then ok "上游无漂移（exit 0）"
elif [[ "$WATCH_EXIT" -eq 1 ]]; then echo "  ⚠️ 检测到上游版本漂移（exit 1，需人工确认后 bump pins）"; ok "侦测器可用"
else echo "  ⚠️ 侦测器离线（exit 2），不视为失败"; ok "侦测器可用（离线）"; fi

step "6. 契约基线（v0.3.0：分段 + 只读；verify 不得写）"
# 口径升级：旧断言是「latest.json 存在」+「没被改写」——**只在旧语义下有意义**，
# 而且「存在」这件事在新语义下**什么都不能证明**（文件可能是历史遗留、也可能早该迁走）。
# 现在断言**新语义**：① 基线链可解析；② 跑完 verify 之后基线**逐字节未变**（含分片目录）；
# ③ `settle --dry-run` 确实**不落盘**（写基线只发生在真的结算）。
BASELINE_BEFORE="$(git -C "$ROOT" status --porcelain -- registry/contract-snapshots | shasum | awk '{print $1}')"
"$NODE_BIN" "$ROOT/src/cli.mjs" baseline --json /tmp/baseline.json > /tmp/baseline.log 2>&1
if [[ -s /tmp/baseline.json ]]; then
  ok "基线链可解析（$(grep -o '"chain": \[[^]]*\]' /tmp/baseline.json | head -1)）"
else
  bad "基线链不可解析"; tail -10 /tmp/baseline.log
fi
BASELINE_AFTER="$(git -C "$ROOT" status --porcelain -- registry/contract-snapshots | shasum | awk '{print $1}')"
if [[ "$BASELINE_BEFORE" == "$BASELINE_AFTER" ]]; then
  ok "基线未被验收过程改写（verify 只读；写基线只在 settle）"
else
  bad "基线被验收过程改写（基线会自己一直在动 ⇒ 累积偏移被静默吸收）"; git -C "$ROOT" status --porcelain -- registry/contract-snapshots
fi
# dry-run 自证：不落盘
"$NODE_BIN" "$ROOT/src/cli.mjs" settle --from /tmp/baseline.json --at 2099-01-01T00:00:00Z --dry-run > /tmp/settle-dry.json 2>&1
if git -C "$ROOT" status --porcelain -- registry/contract-snapshots | grep -q '2099-01-01'; then
  bad "settle --dry-run 落盘了（dry-run 语义被破坏）"
else
  ok "settle --dry-run 不落盘（写基线只发生在真结算）"
fi

step "7. 文档计数防漂移（文档声明的项数必须等于实际跑出来的项数；声明缺失即红）"
# P2-9 同族：文档/编排里的「N 项」最容易与实际脱节（59/48/34 就曾残留两轮）。
# 这里把**实际**项数与文档声明**逐一对齐**：任一文档写错 → 本节红（不是靠人眼复核）。
#
# 🟡-2（评审实测逃逸）：上一版在取不到声明时只打 `⚠️ 跳过比对`，**不递增 DOC_COUNT_MISMATCH**
# → 把 README 的计数声明行整行删掉，三条比对全部「跳过」、本节仍绿。
# 防线对「改数」有效、对「删声明」无效——而删声明恰恰是「忘了同步」的最省事做法。
# 修法：**声明缺失即 FAIL**（声明本身是必需项）。计数口径因此分两类，都必须为 0：
#   - DOC_COUNT_MISMATCH：声明存在但数值 ≠ 实际；
#   - DOC_COUNT_MISSING：声明行缺失（有人删了它）。
#
# 🟡-R3①（复评实测逃逸）：上一版用 `grep … | head -1` **只校验每文件首处**匹配 —— 于是
# `docs/ARCHITECTURE.md` 的 M5 行（**第二处**）写错（113 项 / 21-21 / 15 负例）**永远逃逸**；
# 且 `CHANGELOG.md` **完全不在守卫表内**（v0.2.1 段写 149 项，实际 146）。
# 修法（复评要求）：① `CHANGELOG` 入表；② 改为「该文件内**所有**匹配处都必须等于实际值」
# （逐处比对，不再 `head -1`）——否则「改一处、漏一处」永远能逃。
#
# 历史段的例外（为什么 CHANGELOG 只守**最新段**）：CHANGELOG 是**历史记录**，旧版本段里的
# 数字记录的是**当时的**实际值（如「128 → 129 项」），不可能等于今天的最新值。
# 故对 CHANGELOG 只守**最新版本段**（自文件头到第二个 `## v` 之前），历史段不参与逐处比对。
DOC_COUNT_MISMATCH=0
DOC_COUNT_MISSING=0
# 取「文件内**全部**匹配处」的数值（不再 head -1）——每一处都必须等于实际值。
doc_counts_of() {
  local pattern="$1" file="$2"
  grep -oE "$pattern" "$ROOT/$file" 2>/dev/null | sed -E 's/.* ([0-9]+) 项$/\1/'
}
# 取 CHANGELOG 的**最新版本段**（自文件头到第二个 `## v` 之前）——历史段记录当时的值，不参与比对。
changelog_head() { awk '/^## v/{c++} c>=2{exit} {print}' "$ROOT/CHANGELOG.md"; }
# 逐处比对：**所有**匹配处都等于实际值才算通过（少一处声明即 MISSING，任一处不符即 MISMATCH）。
check_doc_count() {
  local label="$1" actual="$2" pattern="$3" file="$4"
  local values
  if [[ "$file" == "CHANGELOG.md" ]]; then
    values="$(changelog_head | grep -oE "$pattern" 2>/dev/null | sed -E 's/.* ([0-9]+) 项$/\1/')"
  else
    values="$(doc_counts_of "$pattern" "$file")"
  fi
  if [[ -z "$values" ]]; then
    bad "$file 的「$label」项数声明**缺失**（声明本身是必需项：删掉它 = 防漂移失效）"
    DOC_COUNT_MISSING=$((DOC_COUNT_MISSING + 1))
    return
  fi
  local total=0 mismatch=0 v
  while IFS= read -r v; do
    [[ -z "$v" ]] && continue
    total=$((total + 1))
    [[ "$v" != "$actual" ]] && mismatch=$((mismatch + 1))
  done <<< "$values"
  if [[ "$mismatch" -eq 0 ]]; then
    ok "$file 的「$label」项数 = 实际（$actual，逐处比对 $total 处）"
  else
    bad "$file 的「$label」声明有 $mismatch/$total 处 ≠ 实际 $actual 项（文档漂移；逐处比对，改一处漏一处也红）"
    DOC_COUNT_MISMATCH=$((DOC_COUNT_MISMATCH + mismatch))
  fi
}

# 守卫自证（把「为什么必须判红」写成可执行断言，防后人改回「跳过」）：
# ① 声明缺失时**必须**判红（bad 被调用、计数递增）；② 声明存在时不误报。
# 自证在**子 shell** 里跑（`( ... )`），父 shell 的 PASS/FAIL/计数不受影响——
# 测试自证不得污染被测口径（否则「自证」本身就是新的噪声源）。
_selfcheck="$( (
  PASS=0; FAIL=0; DOC_COUNT_MISMATCH=0; DOC_COUNT_MISSING=0
  bad() { FAIL=$((FAIL + 1)); }
  ok() { PASS=$((PASS + 1)); }
  check_doc_count "自证-声明缺失" "1" '绝不存在的声明 [0-9]+ 项' 'tests/fixtures/__no_such_doc__.md'
  echo "missing=$DOC_COUNT_MISSING fail=$FAIL"
) 2>/dev/null )"
if [[ "$_selfcheck" == "missing=1 fail=1" ]]; then
  ok "守卫自证：声明缺失即判红并计入 DOC_COUNT_MISSING（不再静默跳过）"
else
  bad "守卫自证：声明缺失未判红（🟡-2 回归）：$_selfcheck"
fi
# 自证 ②（🟡-R3① 的原始逃逸形态）：**第二处**写错必须判红——旧实现 `head -1` 只看首处，
# 于是「改一处、漏一处」永远能逃。这里造一个「首处对、第二处错」的临时文件，断言守卫判红。
_selfcheck2="$( (
  DOC_COUNT_MISMATCH=0; DOC_COUNT_MISSING=0
  bad() { :; }
  ok() { :; }
  tmp="$(mktemp -d)"
  mkdir -p "$tmp"
  printf '离线单测 7 项\n……\n离线单测 999 项\n' > "$tmp/doc.md"
  ROOT_SAVE="$ROOT"; ROOT="$tmp"
  # 复用被测函数体：直接调用（函数内以 $ROOT/$file 取文件）
  check_doc_count "自证-第二处写错" "7" '离线单测 [0-9]+ 项' 'doc.md'
  ROOT="$ROOT_SAVE"
  rm -rf "$tmp"
  echo "mismatch=$DOC_COUNT_MISMATCH missing=$DOC_COUNT_MISSING"
) 2>/dev/null )"
if [[ "$_selfcheck2" == "mismatch=1 missing=0" ]]; then
  ok "守卫自证：**第二处**写错即判红（🟡-R3① 的「改一处、漏一处」逃逸已被堵）"
else
  bad "守卫自证：第二处写错未判红（🟡-R3① 回归）：$_selfcheck2"
fi
check_doc_count "离线单测" "$(count_of /tmp/offline.log)" '离线单测 [0-9]+ 项' 'README.md'
check_doc_count "归因离线回归" "$(count_of /tmp/attribution.log)" '归因离线回归 [0-9]+ 项' 'README.md'
check_doc_count "归因端到端回归" "$(count_of /tmp/e2e.log)" '归因端到端回归 [0-9]+ 项' 'README.md'
check_doc_count "离线单测" "$(count_of /tmp/offline.log)" '离线单测 [0-9]+ 项' 'docs/ARCHITECTURE.md'
# 🟡-R3① 的**原始逃逸**：M5 行写的是「离线 147 项」（**没有「单测」二字**）——旧守卫的模式
# `离线单测 [0-9]+ 项` **匹配不到它** ⇒ M5 行写 113 / 999 都逃逸。故补一条**独立模式**
# （`[^测]` 负向环视，避免把「离线单测 N 项」重复计一次）。
# 模式用「离线 + **空格** + 数字」（M5 行的写法）——`离线单测 147 项` 里 `离线` 后跟的是「单」不是空格，
# 故两个模式**互不重叠**，各自逐处比对（`grep -E` 无环视，故用字面空格区分）。
check_doc_count "离线单测（M5 行写法：离线 N 项）" "$(count_of /tmp/offline.log)" '离线 [0-9]+ 项' 'docs/ARCHITECTURE.md'
check_doc_count "归因离线回归" "$(count_of /tmp/attribution.log)" '归因离线回归 [0-9]+ 项' 'docs/ARCHITECTURE.md'
check_doc_count "归因端到端回归" "$(count_of /tmp/e2e.log)" '归因端到端回归 [0-9]+ 项' 'docs/ARCHITECTURE.md'
check_doc_count "离线单测" "$(count_of /tmp/offline.log)" '离线单测 . .tests/test_offline.sh. . 测试 . [0-9]+ 项' 'docs/INDEX.md'
check_doc_count "归因离线回归" "$(count_of /tmp/attribution.log)" '归因离线回归 . .tests/test_attribution.mjs. . 测试 . [0-9]+ 项' 'docs/INDEX.md'
check_doc_count "归因端到端回归" "$(count_of /tmp/e2e.log)" '归因端到端回归 . .tests/test_e2e_regression.mjs. . 测试 . [0-9]+ 项' 'docs/INDEX.md'
# 🟡-R3①：`CHANGELOG.md` **入表**（此前完全不在守卫表内 ⇒ v0.2.1 段写 149 项、实际 146 也无人发现）。
# 只守**最新版本段**（历史段记录当时的实际值，见 `changelog_head` 的说明）。
check_doc_count "离线单测" "$(count_of /tmp/offline.log)" '离线单测 [0-9]+ 项' 'CHANGELOG.md'
check_doc_count "归因离线回归" "$(count_of /tmp/attribution.log)" '归因离线回归 [0-9]+ 项' 'CHANGELOG.md'
check_doc_count "归因端到端回归" "$(count_of /tmp/e2e.log)" '归因端到端回归 [0-9]+ 项' 'CHANGELOG.md'

# 闸门计数（🟡-R3① 同族）：`docs/ARCHITECTURE.md` 的 M5 行同时声明「插件侧闸门 N/N（M 负例…）」——
# 这两处也必须逐处对齐（此前 21/21、15 负例 与实际 20/17 不符且无人发现）。
check_doc_count "闸门项数" "$(count_of /tmp/gate.log)" '插件侧闸门 [0-9]+ 项' 'docs/ARCHITECTURE.md'
# 负例份数：声明形如「插件侧闸门 23 项（17 负例 + R24 六条 + 防过度修正）」——`check_doc_count` 的
# sed 只认「… 项」后缀，故这里单独取（口径与「逐处比对」一致：M5 行里该声明**每一处**都要对上）。
# ⚠️ 模式必须含**数字**（v0.2.5）：新夹具 `plugin-fd3-redirect-plugin` 的名字里有 `fd3`，
# 旧的 `[a-z-]+` 匹配不到它 ⇒ 闸门夹具**加了却不算数**（文档声明的份数永远追不上实际）。
NEG_FIXTURES="$(grep -cE '^  "(plugin|demo)-[a-z0-9-]+\|' "$ROOT/tests/gate_plugin_side.sh")"
NEG_DECLARED="$(grep -oE '插件侧闸门 [0-9]+ 项（[0-9]+ 负例' "$ROOT/docs/ARCHITECTURE.md" | sed -E 's/.*（([0-9]+) 负例$/\1/' | sort -u | tr '\n' ',')"
if [[ -z "$NEG_DECLARED" ]]; then
  bad "docs/ARCHITECTURE.md 的「闸门负例份数」声明**缺失**"
  DOC_COUNT_MISSING=$((DOC_COUNT_MISSING + 1))
elif [[ "$NEG_DECLARED" == "${NEG_FIXTURES}," ]]; then
  ok "docs/ARCHITECTURE.md 的「闸门负例份数」= 实际（$NEG_FIXTURES，逐处比对）"
else
  bad "docs/ARCHITECTURE.md 的「闸门负例份数」声明 ${NEG_DECLARED%,} 份，实际 $NEG_FIXTURES 份（文档漂移）"
  DOC_COUNT_MISMATCH=$((DOC_COUNT_MISMATCH + 1))
fi

# 计数口径收口：声明漂移与声明缺失都必须为 0（🟡-2）
if [[ "$DOC_COUNT_MISMATCH" -eq 0 && "$DOC_COUNT_MISSING" -eq 0 ]]; then
  ok "文档计数口径：声明漂移 0 / 声明缺失 0"
else
  bad "文档计数口径：漂移 $DOC_COUNT_MISMATCH / 缺失 $DOC_COUNT_MISSING"
fi

echo
echo "▶ 双通道验收结果：PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
