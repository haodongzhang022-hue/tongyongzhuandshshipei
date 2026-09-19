#!/usr/bin/env bash
# 离线单元测试（不联网、不装宿主）：验证契约兼容层、版本线探测、汇报渲染。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
PASS=0
FAIL=0

assert() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name"
    echo "     期望: $expected"
    echo "     实得: $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "▶ 离线单元测试（tests/test_offline.sh）"

echo "  [1] schema 压平与校验"
OUT="$("$NODE_BIN" --input-type=module -e "
import { normalizeSchema, collectSchemaViolations } from '$ROOT/src/compat/schema.mjs';
const flat = normalizeSchema({ type:'object', properties:{ a:{ type:'json' }, b:{ type:'string' } }, required:['a','b','zzz'], extra:1 });
console.log(JSON.stringify(collectSchemaViolations(flat)));
console.log(JSON.stringify(flat));
")"
assert "宽松 schema 压平后无违规" "[]" "$(echo "$OUT" | head -1)"
assert "required 收敛为 properties 内项" '{"type":"object","properties":{"a":{},"b":{"type":"string"}},"required":["a","b"],"additionalProperties":false}' "$(echo "$OUT" | tail -1)"

OUT="$("$NODE_BIN" --input-type=module -e "
import { collectSchemaViolations } from '$ROOT/src/compat/schema.mjs';
console.log(collectSchemaViolations({ type:'object', properties:{ a:{ type:'json' } } }).length);
console.log(collectSchemaViolations({ type:'object', oneOf:[{type:'string'},{type:'number'}] }).length);
console.log(collectSchemaViolations({}).length);
")"
assert "显式不支持类型被拒" "1" "$(echo "$OUT" | sed -n 1p)"
assert "type 与 oneOf 互斥被拒" "1" "$(echo "$OUT" | sed -n 2p)"
assert "无 type 节点被接受（实测宿主行为）" "0" "$(echo "$OUT" | sed -n 3p)"

echo "  [2] 版本线探测"
OUT="$("$NODE_BIN" --input-type=module -e "
import { detectHostFlavor } from '$ROOT/src/detect/flavor.mjs';
console.log(detectHostFlavor(undefined).flavor);
console.log(detectHostFlavor({ constructor:{ Config:{ toString:()=>'{ mode?: \"native\" | \"ptc\" | \"both\" }' } } }).flavor);
console.log(detectHostFlavor({ constructor:{ Config:{ toString:()=>'{ mode?: \"native\" | \"code\" | \"both\" }' } } }).flavor);
")"
assert "无宿主 → unknown（不抛错）" "unknown" "$(echo "$OUT" | sed -n 1p)"
assert "ptc 指纹 → modern" "modern" "$(echo "$OUT" | sed -n 2p)"
assert "code 指纹 → legacy" "legacy" "$(echo "$OUT" | sed -n 3p)"

echo "  [3] 保留名护栏与默认 render"
OUT="$("$NODE_BIN" --input-type=module -e "
import { assertNotReserved, defaultRender, normalizeToolDefinition } from '$ROOT/src/compat/tool.mjs';
let rejected = 'no';
try { assertNotReserved('run_code'); } catch { rejected = 'yes'; }
console.log(rejected);
console.log(defaultRender(null, { a: 1 })[0].type);
const d = normalizeToolDefinition({ name:'t', description:'d', parameters:{}, output:{}, execute: async()=>({}) });
console.log(typeof d.output.render);
")"
assert "run_code 被插件侧拒绝" "yes" "$(echo "$OUT" | sed -n 1p)"
assert "默认 render 产出 text 块" "text" "$(echo "$OUT" | sed -n 2p)"
assert "缺 render 自动兜底" "function" "$(echo "$OUT" | sed -n 3p)"

echo "  [4] 通道矩阵完整性"
OUT="$("$NODE_BIN" --input-type=module -e "
import { loadChannels } from '$ROOT/src/harness/host.mjs';
const r = loadChannels('$ROOT');
const names = Object.keys(r.channels).sort().join(',');
const missing = Object.entries(r.channels).filter(([,c]) => !c.pins['@deepseek-ai/dsh-tools']).map(([n]) => n);
console.log(names);
console.log(missing.length);
console.log(r.channels.stable.pins['@deepseek-ai/dsh-tools'] === r.channels.stable.line + '-rc.2' || r.channels.stable.pins['@deepseek-ai/dsh-tools'].startsWith(r.channels.stable.line) ? 'aligned' : 'drift');
")"
assert "三通道齐备（stable/dev/legacy）" "dev,legacy,stable" "$(echo "$OUT" | sed -n 1p)"
assert "每通道均钉 dsh-tools 版本" "0" "$(echo "$OUT" | sed -n 2p)"
assert "stable 钉版与声明版本线一致" "aligned" "$(echo "$OUT" | sed -n 3p)"

echo "  [4.5] 发布面自检（exports 全解析 + 模板拷贝可用）"
if "$NODE_BIN" "$ROOT/tests/test_exports.mjs" > /tmp/exports.log 2>&1; then
  EXPORTS_LINE="$(tail -1 /tmp/exports.log)"
  assert "exports 全解析 + 模板拷贝可用（无失败项）" "${EXPORTS_LINE##*FAIL=}" "0"
else
  echo "  ❌ 发布面自检失败"; tail -20 /tmp/exports.log; FAIL=$((FAIL + 1))
fi

echo "  [5] 契约基线防自毁（失败运行不得写坏基线）"
OUT="$("$NODE_BIN" --input-type=module -e "
import { contractSnapshot, planSnapshotUpdate, diffContracts, mergeContracts } from '$ROOT/src/watch/upstream.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'dsh-snap-'));
const snap = contractSnapshot({ hubRoot: dir });
const base = { stable:{configProjection:'A',reservedName:'R',schemaSubset:'S',outputShape:'O'}, dev:{configProjection:'A',reservedName:'R',schemaSubset:'S',outputShape:'O'} };
snap.save(base);
// 一次失败运行：契约是 {} → 不得覆盖基线
const failed = { channels:[{channel:'stable',ok:false,contract:{}},{channel:'dev',ok:false,contract:{}}] };
const plan1 = planSnapshotUpdate({ snapshot:snap, report:failed });
if (plan1.changed) snap.save(plan1.accepted);
const afterFail = snap.load();
console.log(JSON.stringify(afterFail.contracts) === JSON.stringify(base) ? 'baseline-intact' : 'baseline-BROKEN');
// 失败运行后不得产出假漂移
const drift = diffContracts(afterFail, { stable:{}, dev:{} });
console.log(String(drift.changed));
// 只有 ok 通道才更新（ok 通道写、fail 通道保留）
const mixed = { channels:[{channel:'stable',ok:true,contract:{configProjection:'B',reservedName:'R',schemaSubset:'S',outputShape:'O'}},{channel:'dev',ok:false,contract:{}}] };
const plan2 = planSnapshotUpdate({ snapshot:snap, report:mixed });
if (plan2.changed) snap.save(plan2.accepted);
const afterMixed = snap.load();
console.log(afterMixed.contracts.stable.configProjection + '|' + afterMixed.contracts.dev.configProjection);
console.log(JSON.stringify(plan2.skipped));
rmSync(dir, { recursive:true, force:true });
")"
assert "失败运行后基线不变" "baseline-intact" "$(echo "$OUT" | sed -n 1p)"
assert "失败运行不产生假漂移" "false" "$(echo "$OUT" | sed -n 2p)"
assert "仅 ok 通道被更新（fail 保留）" "B|A" "$(echo "$OUT" | sed -n 3p)"
assert "被跳过的通道被显式记录" '["dev"]' "$(echo "$OUT" | sed -n 4p)"

echo "  [6] 保留名冲突必须上报（不静默丢工具）"
OUT="$("$NODE_BIN" --input-type=module -e "
import { createAdapter } from '$ROOT/src/adapter.mjs';
const host = { reg:[], register(d){ this.reg.push(d.name); return () => {}; }, schemas(){ return this.reg.map((n)=>({name:n})); } };
let calls = 0; let last = [];
const adapter = createAdapter({ tools: host }, { prefix:'p', onIssues:(i)=>{calls+=1;last=i;} });
const r = adapter.register([
  { name:'leak_echo', description:'', parameters:{}, output:{schema:{}}, execute: async()=>({}) },
  { name:'run_code', description:'', parameters:{}, output:{schema:{}}, execute: async()=>({}) },
]);
console.log(r.reservedRejected.length);
console.log(r.issues.some((i)=>i.includes('reserved_name_conflict')));
console.log(calls > 0);
console.log(Array.isArray(adapter.toJSON().reservedRejected) && adapter.toJSON().reservedRejected.length === 1);
console.log(JSON.stringify(r.registered));
")"
assert "保留名冲突进 reservedRejected" "1" "$(echo "$OUT" | sed -n 1p)"
assert "保留名冲突进 issues（可识别前缀）" "true" "$(echo "$OUT" | sed -n 2p)"
assert "保留名冲突触发 onIssues 回调" "true" "$(echo "$OUT" | sed -n 3p)"
assert "toJSON 暴露 reservedRejected" "true" "$(echo "$OUT" | sed -n 4p)"
assert "冲突工具未被注册到宿主" '["leak_echo"]' "$(echo "$OUT" | sed -n 5p)"

echo "  [7] all 语义 = stable+dev+legacy"
OUT="$("$NODE_BIN" --input-type=module -e "
import { resolveChannels, ALL_CHANNELS } from '$ROOT/src/cli.mjs';
console.log(JSON.stringify(resolveChannels('all')));
console.log(JSON.stringify(resolveChannels(undefined)));
console.log(JSON.stringify(resolveChannels('stable')));
let rejected = 'no';
try { resolveChannels('nope'); } catch { rejected = 'yes'; }
console.log(rejected);
console.log(JSON.stringify(ALL_CHANNELS));
")"
assert "resolveChannels(all) 含三通道" '["stable","dev","legacy"]' "$(echo "$OUT" | sed -n 1p)"
assert "默认（未指定）= all" '["stable","dev","legacy"]' "$(echo "$OUT" | sed -n 2p)"
assert "单通道解析不变" '["stable"]' "$(echo "$OUT" | sed -n 3p)"
assert "未知通道显式报错（不静默）" "yes" "$(echo "$OUT" | sed -n 4p)"

echo "  [8] 参数解析支持 --key=value，未知 token 显式报错"
OUT="$("$NODE_BIN" --input-type=module -e "
import { parseArgs } from '$ROOT/src/cli.mjs';
console.log(parseArgs(['verify','--channel=stable','--tools=a,b']).channel);
console.log(parseArgs(['verify','--channel','stable']).channel);
console.log(parseArgs(['watch','--offline']).offline);
let bad = 'no';
try { parseArgs(['--bogus=1','-x']); } catch { bad = 'yes'; }
console.log(bad);
")"
assert "--key=value 被正确解析" "stable" "$(echo "$OUT" | sed -n 1p)"
assert "--key value 仍可用" "stable" "$(echo "$OUT" | sed -n 2p)"
assert "布尔开关可用" "true" "$(echo "$OUT" | sed -n 3p)"
assert "未知 token 显式报错" "yes" "$(echo "$OUT" | sed -n 4p)"

echo "  [9] 归因判定（结构化判据：宿主侧 hostFatal[] vs 插件侧 check）"
# 说明：判据自 v0.1.3 起**只读结构化字段**——宿主侧认 probe.hostFatal[]（结构化）与宿主侧 check 名，
# 插件侧只认插件侧 check 名；errors[] 仅作日志、不参与判据。
# 历史缺陷：v0.1.1 裸 /npm|fatal:/；v0.1.2 改为扫 fatal(host) 前缀（仍是自由文本子串扫描，
# 插件路径/文本含该字面量即翻案）。更完整的回归见 tests/test_attribution.mjs。
# 🔴-D（v0.1.6）：判据字段 hostFatal[] 的**写入端**分相位——插件集成相位的未预期异常
# 落插件侧 check（plugin.unexpected_exception），绝不进 hostFatal[]。
OUT="$("$NODE_BIN" --input-type=module -e "
import { attributeFailure, attributionDetail } from '$ROOT/src/verify/runner.mjs';
import { PROBE_PHASE, recordProbeException, recordProbeAsyncException, PLUGIN_ASYNC_EXCEPTION_CHECK } from '$ROOT/src/harness/contract.mjs';
const ch = { label: 'x', line: '0.1.6' };
const p = (errors, checks = [], extra = {}) => ({ errors, checks, hostFatal: [], profile: { flavor: 'modern' }, contract: {}, ...extra });
const hf = (detail) => p(['fatal(host): ' + detail], [], { hostFatal: [detail] });
const fc = (name) => ({ name, status: 'fail', detail: 'x' });
// 宿主/环境侧：**结构化字段** hostFatal[]（判据只读它）
console.log(attributeFailure(hf('宿主依赖安装失败（npm）：npm ERR! code ETARGET'), ch, 'dev'));
console.log(attributeFailure(p(['host.tools_ready: ctx.tools 未就绪'], [fc('host.tools_ready')]), ch, 'dev'));
// 插件侧
console.log(attributeFailure(p(['registry.exact: 期望 a / 实得 b'], [fc('registry.exact')]), ch, 'dev'));
console.log(attributeFailure(p(['dispatch.execute_ok: Error'], [fc('dispatch.execute_ok')]), ch, 'dev'));
// 🔴-B 回归：路径含 npm + 插件侧失败 → 仍判插件
console.log(attributeFailure(p(['plugin.apply_ok: 插件 apply 抛错 | at file:///home/runner/.npm/_npx/x/probe.mjs:1:1'], [fc('plugin.apply_ok')]), ch, 'dev'));
// 🔴-B 回归：插件侧旧措辞裸 fatal: 不得翻案
console.log(attributeFailure(p(['plugin.loaded: 插件 import 失败：SyntaxError | fatal: 旧措辞'], [fc('plugin.loaded')]), ch, 'dev'));
// 🔴-C 回归：自由文本含 fatal(host) 字面量（插件路径/文本）不得翻案
console.log(attributeFailure(p(['plugin.apply_ok: 插件 apply 抛错 | at file:///tmp/fatal(host)-dir/apply-throws.mjs:3:33'], [fc('plugin.apply_ok')]), ch, 'dev'));
// 无失败 check（探针被外力打断）→ 不猜
console.log(attributeFailure(p(['探针非零退出（status=null）']), ch, 'dev'));
// 理由链可审计
console.log(attributionDetail(p(['registry.exact: x'], [fc('registry.exact')]), ch, 'dev').reasons.length > 0 ? 'has-reasons' : 'no-reasons');
// 🔴-D：插件集成相位的未预期异常 → 插件侧 check，且**绝不**写 hostFatal[]
const pluginPhase = { checks: [], errors: [], hostFatal: [] };
recordProbeException(pluginPhase, PROBE_PHASE.PLUGIN_INTEGRATION, 'TypeError: x | at get name (file:///tmp/plugin.mjs:5:33)');
console.log(pluginPhase.checks[0].name);
console.log(pluginPhase.hostFatal.length);
console.log(attributeFailure({ ...pluginPhase, profile: { flavor: 'modern' }, contract: {} }, ch, 'dev'));
// 🔴-D 反向：宿主装配相位仍写 hostFatal[] 并判漂移
const hostPhase = { checks: [], errors: [], hostFatal: [] };
recordProbeException(hostPhase, PROBE_PHASE.HOST_ASSEMBLY, 'Cannot find package @deepseek-ai/dsh-tools');
console.log(attributeFailure({ ...hostPhase, profile: { flavor: 'modern' }, contract: {} }, ch, 'dev'));
// 🔴-D 异步活口：插件后台任务（不在 run() 调用栈上）的未捕获异常 → 插件侧 check，绝不写 hostFatal[]
const asyncOut = { checks: [], errors: [], hostFatal: [] };
recordProbeAsyncException(asyncOut, PROBE_PHASE.PLUGIN_INTEGRATION, 'Error: plugin background task bug | at queueMicrotask (file:///tmp/plugin.mjs:48:11)');
console.log(asyncOut.checks[0].name);
console.log(asyncOut.hostFatal.length);
console.log(attributeFailure({ ...asyncOut, profile: { flavor: 'modern' }, contract: {} }, ch, 'dev'));
console.log(PLUGIN_ASYNC_EXCEPTION_CHECK === asyncOut.checks[0].name ? 'registered-check' : 'unregistered-check');
// 🔴-D 异步反向：宿主装配相位的异步异常仍写 hostFatal[] 并判漂移
const asyncHost = { checks: [], errors: [], hostFatal: [] };
recordProbeAsyncException(asyncHost, PROBE_PHASE.HOST_ASSEMBLY, 'Cannot find package @deepseek-ai/dsh-tools');
console.log(attributeFailure({ ...asyncHost, profile: { flavor: 'modern' }, contract: {} }, ch, 'dev'));
")"
assert "宿主安装失败（结构化 hostFatal[]）→ UPSTREAM_DRIFT" "UPSTREAM_DRIFT" "$(echo "$OUT" | sed -n 1p)"
assert "宿主未就绪 → UPSTREAM_DRIFT" "UPSTREAM_DRIFT" "$(echo "$OUT" | sed -n 2p)"
assert "工具清单不符 → PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 3p)"
assert "dispatch 失败 → PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 4p)"
assert "🔴-B：路径含 npm 不误判为上游漂移" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 5p)"
assert "🔴-B：插件侧裸 fatal: 措辞不误判为上游漂移" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 6p)"
assert "🔴-C：路径含 fatal(host) 不误判为上游漂移" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 7p)"
assert "无失败 check → UNKNOWN（不猜归因）" "UNKNOWN" "$(echo "$OUT" | sed -n 8p)"
assert "归因带可审计理由链" "has-reasons" "$(echo "$OUT" | sed -n 9p)"
assert "🔴-D：插件集成相位异常落插件侧 check" "plugin.unexpected_exception" "$(echo "$OUT" | sed -n 10p)"
assert "🔴-D：插件集成相位异常不写 hostFatal[]（不变量）" "0" "$(echo "$OUT" | sed -n 11p)"
assert "🔴-D：插件侧异常 → PLUGIN_REGRESSION（不甩锅上游）" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 12p)"
assert "🔴-D 反向：宿主装配相位异常 → 仍判 UPSTREAM_DRIFT" "UPSTREAM_DRIFT" "$(echo "$OUT" | sed -n 13p)"
assert "🔴-D 异步：插件后台任务异常落插件侧异步 check" "plugin.async_uncaught_exception" "$(echo "$OUT" | sed -n 14p)"
assert "🔴-D 异步：不写 hostFatal[]（不变量，与同步路径同口径）" "0" "$(echo "$OUT" | sed -n 15p)"
assert "🔴-D 异步：→ PLUGIN_REGRESSION（不甩锅上游）" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 16p)"
assert "🔴-D 异步：落点 check 已登记进 PLUGIN_SIDE_CHECKS（否则归因退化成 UNKNOWN）" "registered-check" "$(echo "$OUT" | sed -n 17p)"
assert "🔴-D 异步反向：宿主装配相位异步异常 → 仍判 UPSTREAM_DRIFT" "UPSTREAM_DRIFT" "$(echo "$OUT" | sed -n 18p)"

OUT="$("$NODE_BIN" --input-type=module -e "
import { attributeFailure } from '$ROOT/src/verify/runner.mjs';
const ch = { label: 'x', line: '0.1.6' };
const fc = (name) => ({ name, status: 'fail', detail: 'x' });
const p = (errors, checks = []) => ({ errors, checks, profile: { flavor: 'modern' }, contract: {} });
// 真漂移：契约指纹与基线不一致且与失败点相关
console.log(attributeFailure(p(['guard.reserved_name: tool name \"run_code\" is reserved'], [fc('guard.reserved_name')]), ch, 'dev', { contractDrift:{ changed:true, items:[{field:'reservedName'}] } }));
// 漂移字段与失败点无关 → 插件回归（不甩锅上游）
console.log(attributeFailure(p(['registry.exact: 期望 a / 实得 b'], [fc('registry.exact')]), ch, 'dev', { contractDrift:{ changed:true, items:[{field:'outputShape'}] } }));
// 契约 check 失败且无可用基线（首次采集）→ 保守判漂移
console.log(attributeFailure(p(['compat.schema_flatten: unsupported ...'], [fc('compat.schema_flatten')]), ch, 'dev', { contractDrift:{ changed:false, newBaseline:true } }));
// 契约 check 失败但基线一致（上游没变）→ 插件回归
console.log(attributeFailure(p(['guard.reserved_name: 插件声明了保留名'], [fc('guard.reserved_name')]), ch, 'dev', { contractDrift:{ changed:false, newBaseline:false, items:[] } }));
// 旧版死判据不得再出现
console.log(/register\\.count|register\\.no_issues/.test(attributeFailure.toString()) ? 'dead-criteria-present' : 'no-dead-criteria');
")"
assert "契约指纹漂移（与失败点相关）→ UPSTREAM_DRIFT" "UPSTREAM_DRIFT" "$(echo "$OUT" | sed -n 1p)"
assert "契约漂移与失败点无关 → PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 2p)"
assert "契约 check 失败（无基线）→ UPSTREAM_DRIFT" "UPSTREAM_DRIFT" "$(echo "$OUT" | sed -n 3p)"
assert "契约 check 失败但基线一致 → PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 4p)"
assert "归因不再含死判据" "no-dead-criteria" "$(echo "$OUT" | sed -n 5p)"

echo "  [10] 汇报渲染（二级信息）"
OUT="$("$NODE_BIN" --input-type=module -e "
import { buildSecondary, toMarkdown } from '$ROOT/src/report/secondary.mjs';
const s = buildSecondary({ generatedAt:'T', plugin:'p', channels:[{channel:'dev',label:'开发版通道',line:'0.1.6',ok:false,attribution:'UPSTREAM_DRIFT',profile:{flavor:'modern'},checks:[{name:'a',status:'fail',detail:'d'}],errors:['a: d'],durationMs:1}], summary:{total:1,passed:0,failed:1,upstreamDrift:['dev'],pluginRegression:[],verdict:'AMBER'} });
console.log(s.verdict);
console.log(s.risks[0].severity);
console.log(toMarkdown(s).includes('上游契约漂移') ? 'has-mitigation' : 'missing');
")"
assert "AMBER 判决透传" "AMBER" "$(echo "$OUT" | sed -n 1p)"
assert "上游漂移风险降级为 MEDIUM" "MEDIUM" "$(echo "$OUT" | sed -n 2p)"
assert "Markdown 含规避方案" "has-mitigation" "$(echo "$OUT" | sed -n 3p)"

echo "  [11] 兜底探测不留副作用（接受 run_code 的宿主）"
OUT="$("$NODE_BIN" --input-type=module -e "
import { detectHostFlavor } from '$ROOT/src/detect/flavor.mjs';
// 构造「接受 run_code」的宿主（= 本中台要侦测的那种上游漂移）
const host = { reg: [], register(d){ this.reg.push(d.name); return () => { this.reg = this.reg.filter((n)=>n!==d.name); }; } };
const profile = detectHostFlavor(host);
console.log(profile.flavor);
console.log(JSON.stringify(host.reg));
")"
assert "接受保留名的宿主 → unknown（不误判版本线）" "unknown" "$(echo "$OUT" | sed -n 1p)"
assert "兜底探测后宿主无残留工具" "[]" "$(echo "$OUT" | sed -n 2p)"

echo "  [12] CLI 契约（退出码 / 带值参数缺值 / cache 子命令）"
# 退出码即信号：0=GREEN 1=失败 2=用法错误 3=运行时异常（usage 里显式声明）
cli_exit() {
  "$NODE_BIN" "$ROOT/src/cli.mjs" "$@" > /dev/null 2>&1
  echo $?
}
assert "带值参数缺值 → 2（不静默改语义）" "2" "$(cli_exit verify --channel --tools a)"
assert "--json 缺值 → 2（不静默不写文件）" "2" "$(cli_exit verify --json)"
assert "缺插件文件 → 2（用法错误，非运行时异常）" "2" "$(cli_exit verify --channel stable --plugin /nonexistent-plugin.mjs --tools a)"
assert "未知通道 → 2" "2" "$(cli_exit verify --channel nope)"
assert "未知参数 → 2" "2" "$(cli_exit verify --bogus 1)"
OUT="$("$NODE_BIN" "$ROOT/src/cli.mjs" --help 2>&1 || true)"
assert "usage 声明了 cache 子命令" "yes" "$(echo "$OUT" | grep -q 'dsh-adapt cache' && echo yes || echo no)"
assert "usage 声明了退出码 3" "yes" "$(echo "$OUT" | grep -q '3=运行时异常' && echo yes || echo no)"
# cache 子命令：pruneHostCache 的真实调用点（P2-3）
OUT="$(TMPDIR="$(mktemp -d)" "$NODE_BIN" "$ROOT/src/cli.mjs" cache 2>&1)"
assert "cache 子命令可运行且输出 keep 指纹" "yes" "$(echo "$OUT" | grep -q '\"keep\"' && echo yes || echo no)"
assert "cache 保留三通道指纹" "3" "$(echo "$OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.keep.length)})")"

echo "  [13] summarize() 多通道 verdict 优先级（漂移+回归混合 → RED，不静默降级）"
OUT="$("$NODE_BIN" --input-type=module -e "
import { summarize } from '$ROOT/src/verify/runner.mjs';
const rep = (attribution, ok) => ({ channel: attribution + '-ch', ok, attribution, contractDrift: { changed: false } });
// 全绿 → GREEN
console.log(summarize([rep('PASS', true), rep('PASS', true)]).verdict);
// 只有上游漂移 → AMBER
console.log(summarize([rep('UPSTREAM_DRIFT', false)]).verdict);
// 只有插件回归 → RED
console.log(summarize([rep('PLUGIN_REGRESSION', false)]).verdict);
// 漂移 + 回归混合 → RED（回归优先，不得被漂移降级成 AMBER）
console.log(summarize([rep('UPSTREAM_DRIFT', false), rep('PLUGIN_REGRESSION', false)]).verdict);
// 回归在前 / 漂移在后（顺序无关，防「按首项取判决」的静默退化）
console.log(summarize([rep('PLUGIN_REGRESSION', false), rep('UPSTREAM_DRIFT', false)]).verdict);
// 全失败但无法归因 → UNKNOWN（不猜）
console.log(summarize([rep('UNKNOWN', false)]).verdict);
")"
assert "全绿 → GREEN" "GREEN" "$(echo "$OUT" | sed -n 1p)"
assert "仅上游漂移 → AMBER" "AMBER" "$(echo "$OUT" | sed -n 2p)"
assert "仅插件回归 → RED" "RED" "$(echo "$OUT" | sed -n 3p)"
assert "漂移+回归混合 → RED（回归优先，不被降级）" "RED" "$(echo "$OUT" | sed -n 4p)"
assert "混合判决与通道顺序无关（回归在后也 RED）" "RED" "$(echo "$OUT" | sed -n 5p)"
assert "失败但无法归因 → UNKNOWN（不猜）" "UNKNOWN" "$(echo "$OUT" | sed -n 6p)"

echo "  [14] 漂移相关性表唯一事实源（v0.1.7：runner 不得回退手写判据 / 不得前缀通配）"
CHECK_JS="$(mktemp).mjs"
cat > "$CHECK_JS" <<'JS'
import { readFileSync } from 'node:fs';
import { DRIFT_IMPACT, DRIFT_FIELDS } from 'ROOT/src/triage/index.mjs';
import { PLUGIN_HARD_EVIDENCE, CONTRACT_SIDE_CHECKS, PLUGIN_SIDE_CHECKS, HOST_SIDE_CHECKS } from 'ROOT/src/harness/contract.mjs';
const runner = readFileSync('ROOT/src/verify/runner.mjs', 'utf8');
const out = [];
out.push(/import \{[^}]*DRIFT_IMPACT[^}]*\} from '\.\.\/triage\/index\.mjs'/.test(runner) ? 'import-ok' : 'import-missing');
const hardcoded = DRIFT_FIELDS.filter((f) => new RegExp("fields\\.has\\('" + f + "'\\)").test(runner));
out.push(hardcoded.length === 0 ? 'no-hardcoded' : 'hardcoded:' + hardcoded.join(','));
out.push(runner.includes("startsWith('dispatch.')") ? 'prefix-wildcard' : 'no-prefix-wildcard');
const leaked = Object.values(DRIFT_IMPACT).flatMap((v) => v.checks).filter((n) => PLUGIN_HARD_EVIDENCE.includes(n));
out.push(leaked.length === 0 ? 'hard-evidence-excluded' : 'hard-evidence-leaked:' + leaked.join(','));
// 🟢 优化-2（评审 §三）：原先这里**硬编码 17 条**，已被三张事实源表 100% 覆盖
// （评审实测 17/17 冗余）→ 改为**派生**：check 名的唯一事实源是 contract.mjs 的三张表。
// 手写清单必然与事实源漂移（新增 check 时漏改一处 = 本节静默失去防线）。
const known = new Set([...HOST_SIDE_CHECKS, ...CONTRACT_SIDE_CHECKS, ...PLUGIN_SIDE_CHECKS]);
const unknown = Object.values(DRIFT_IMPACT).flatMap((v) => v.checks).filter((n) => !known.has(n));
out.push(unknown.length === 0 ? 'checks-known' : 'checks-unknown:' + unknown.join(','));
console.log(out.join('\n'));
JS
sed -i "s#ROOT#$ROOT#g" "$CHECK_JS"
OUT="$("$NODE_BIN" "$CHECK_JS")"
rm -f "$CHECK_JS"
assert "runner 判定式从唯一事实源 import DRIFT_IMPACT" "import-ok" "$(echo "$OUT" | sed -n 1p)"
assert "runner 判定式不再硬编码契约字段名" "no-hardcoded" "$(echo "$OUT" | sed -n 2p)"
assert "runner 判定式不使用 dispatch. 前缀通配" "no-prefix-wildcard" "$(echo "$OUT" | sed -n 3p)"
assert "硬证据（guard.reserved_rejected）永不入漂移相关性表" "hard-evidence-excluded" "$(echo "$OUT" | sed -n 4p)"
assert "漂移相关性表的 check 名均属唯一事实源名单" "checks-known" "$(echo "$OUT" | sed -n 5p)"

echo "  [15] watch 自动归因影响面（v0.1.7：CLI watch 接 triage，支持 --contract-from / --markdown）"
DRIFT_REPORT="$(mktemp).json"
cat > "$DRIFT_REPORT" <<'JSON'
{ "channels": [ { "channel": "dev", "ok": true, "contract": {
  "configProjection": "{ mode?: \"native\" | \"ptc\" | \"both\", maxParallelSubCalls?: number }",
  "reservedName": "tool name \"run_script\" is reserved for the X transport and cannot be registered or shadowed",
  "schemaSubset": "unsupported JSON schema: schema.properties.a.type must be one of object/array/string/number/integer/boolean/null/fn",
  "outputShape": "tool \"probe_no_render\" must declare output { schema, render, presentationMeta? }"
} } ] }
JSON
OUT="$(TMPDIR="$(mktemp -d)" "$NODE_BIN" "$ROOT/src/cli.mjs" watch --contract-from "$DRIFT_REPORT" --markdown 2>&1 || true)"
assert "watch --markdown 输出「上游漂移影响面」标题" "yes" "$(echo "$OUT" | grep -q '上游漂移影响面' && echo yes || echo no)"
assert "影响面表列出 reservedName → guard.reserved_name" "yes" "$(echo "$OUT" | grep -q 'guard.reserved_name' && echo yes || echo no)"
assert "影响面指明中台要改的文件（定向修）" "yes" "$(echo "$OUT" | grep -q 'src/compat/schema.mjs' && echo yes || echo no)"
assert "新增保留名被点名 → 插件必须改名" "yes" "$(echo "$OUT" | grep -q '必须' && echo yes || echo no)"
assert "建议里声明 advice 不得回灌判据" "yes" "$(echo "$OUT" | grep -q '不得.*判据' && echo yes || echo no)"
rm -f "$DRIFT_REPORT"

echo "  [16] 🔴 四条出口（离线探针回归台：假宿主 + 真实探针 + 真实归因）"
# 为什么搬到离线：这四条出口此前只被真宿主 E2E 覆盖（慢、要网、CI 才跑），而它们恰恰是最容易
# 写错的地方——历史缺陷：exit 出口既未闭合也未声明；看门狗只在记录过异步异常时才装、且被 unref 掉。
# 本节的「假宿主」只模拟探针用到的那点宿主面（见 tests/offline-probe-harness.mjs 的边界声明）：
# **「假宿主通过」不等于「真宿主适配通过」**，本节只回答「探针有没有把插件侧错误写成宿主侧信号」。
EXIT_OUT="$("$NODE_BIN" --input-type=module -e "
import path from 'node:path';
import { runOfflineProbe } from '$ROOT/tests/offline-probe-harness.mjs';
const root = '$ROOT';
const probe = (fixture, tools, watchdogMs, timeoutMs) => {
  const r = runOfflineProbe({ pluginPath: path.join(root, 'tests/fixtures', fixture), expectedTools: tools, watchdogMs, ...(timeoutMs ? { timeoutMs } : {}) });
  const checks = r.result.checks;
  const fails = checks.filter((c) => c.status === 'fail').map((c) => c.name);
  return {
    attribution: r.attribution,
    hostFatal: r.result.hostFatal.length,
    completed: r.result.runCompleted,
    ok: r.result.ok === true,
    pass: checks.filter((c) => c.status === 'pass').length,
    fails,
    phase: r.result.phase,
    exitStatus: r.exit.status,
    exitSignal: r.exit.signal,
  };
};
const cases = {
  healthy: probe('demo-plugin.mjs', ['demo_echo', 'demo_status']),
  sync: probe('apply-throws-plugin.mjs', ['demo_echo']),
  asyncThrow: probe('plugin-async-throw-plugin.mjs', ['demo_echo']),
  exit0: probe('plugin-exit-plugin.mjs', ['demo_echo']),
  hang: probe('plugin-hang-plugin.mjs', ['demo_echo'], 2000),
  sigkill: probe('plugin-sigkill-plugin.mjs', ['demo_echo']),
  // v0.1.9d 新增（评审复评 R24 / R26 / R28）
  defenseTamper: probe('plugin-defense-tamper-plugin.mjs', ['demo_echo']),
  syncLoop: probe('plugin-sync-loop-plugin.mjs', ['demo_echo'], undefined, 1500),
};
console.log(JSON.stringify(cases));
")"
j() { echo "$EXIT_OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);const c=r['$1'];console.log(eval('c$2'))})"; }
assert "健康插件：17/17 全绿且跑完（完成位=true）" "17|true|true" "$(j healthy '.pass+"|"+c.completed+"|"+c.ok')"
assert "健康插件：无失败项、hostFatal 为空、probePhase=plugin-integration" "0|0|plugin-integration" "$(j healthy '.fails.length+"|"+c.hostFatal+"|"+c.phase')"
assert "出口①同步异常：归因 PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(j sync '.attribution')"
assert "出口①同步异常：hostFatal 为空（插件侧错误不进判据字段）" "0" "$(j sync '.hostFatal')"
assert "出口②异步异常：落插件侧异步 check" "true" "$(j asyncThrow '.fails.includes("plugin.async_uncaught_exception")')"
assert "出口②异步异常：hostFatal 为空 + 已跑完（完成位=true，报告不丢）" "0|true" "$(j asyncThrow '.hostFatal+"|"+c.completed')"
assert "出口③进程 exit：归因 PLUGIN_REGRESSION（不甩锅上游）" "PLUGIN_REGRESSION" "$(j exit0 '.attribution')"
assert "出口③进程 exit：hostFatal 为空 + 完成位=false" "0|false" "$(j exit0 '.hostFatal+"|"+c.completed')"
assert "出口③进程 exit：失败项 plugin.early_exit（已登记插件侧）" "true" "$(j exit0 '.fails.includes("plugin.early_exit")')"
assert "出口③进程 exit：**不得假绿**（未跑完绝不给 ok / 退出码非 0）" "false|1" "$(j exit0 '.ok+"|"+c.exitStatus')"
assert "出口③进程 exit：已跑完的 pass 项保留（报告不丢）" "true" "$(j exit0 '.pass >= 6')"
assert "出口④run() 被拖住：归因 PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(j hang '.attribution')"
assert "出口④run() 被拖住：hostFatal 为空 + 完成位=false" "0|false" "$(j hang '.hostFatal+"|"+c.completed')"
assert "出口④run() 被拖住：失败项 plugin.run_incomplete（无条件看门狗生效）" "true" "$(j hang '.fails.includes("plugin.run_incomplete")')"
assert "出口④run() 被拖住：**不得假绿**（未跑完绝不给 ok）" "false" "$(j hang '.ok')"
assert "边界（不可捕获 SIGKILL）：归因 PLUGIN_REGRESSION（按相位信标，不甩锅上游）" "PLUGIN_REGRESSION" "$(j sigkill '.attribution')"
assert "边界（不可捕获 SIGKILL）：hostFatal 为空 + 落 plugin.abnormal_termination" "0|true" "$(j sigkill '.hostFatal+"|"+c.fails.includes("plugin.abnormal_termination")')"

# 反证：假宿主若**不**打相位信标（= 探针在宿主装配段就被终止），装配器必须仍落 hostFatal[]
# （收窄装配器归因不得丢掉真上游信号——与「插件侧不甩锅」是一对反向护栏）
NOBEACON_OUT="$("$NODE_BIN" --input-type=module -e "
import { interpretProbeStdout } from '$ROOT/src/harness/host.mjs';
const r = { checks: [], errors: [], hostFatal: [], phase: 'host-assembly' };
interpretProbeStdout(r, 'Killed（无相位信标：终止发生在宿主装配段）');
console.log(r.hostFatal.length + '|' + r.checks.length);
")"
assert "反向护栏：无相位信标（宿主装配段被终止）→ 仍写 hostFatal[]（真上游信号不丢）" "1|0" "$NOBEACON_OUT"


echo "  [17] 🔴-1 占死事件循环 → 探针**有界**返回（timeoutMs 不再失效）"
# 为什么必须有：探针为出口③装了 SIGTERM/SIGINT 处理器 ⇒ Node 默认终止行为被**替换**；
# 插件同步占死事件循环时信号处理器**不可达** ⇒ 只发 SIGTERM 的 execFileSync 无限等待
# ⇒ CI 挂到流水线上限（实测 while(true) → 45s+ 未返回）。修法：宿主侧 killSignal:'SIGKILL'。
# 用 plugin-event-loop-hog-plugin（**永久**占死事件循环）：这是「只发 SIGTERM 就杀不死」的
# **唯一**形态；plugin-hang-plugin（永不 resolve 的 Promise）事件循环是空的，SIGTERM 杀得死，
# 测不出本回归。本断言用**短 timeout**（5s）直接测「有界性」，不进闸门、不吃满 CI 额度。
BOUNDED_OUT="$("$NODE_BIN" --input-type=module -e '
import path from "node:path";
import { runOfflineProbe } from "'"$ROOT"'/tests/offline-probe-harness.mjs";
const t0 = Date.now();
const r = runOfflineProbe({ pluginPath: path.join("'"$ROOT"'", "tests/fixtures/plugin-event-loop-hog-plugin.mjs"), expectedTools: ["demo_echo"], timeoutMs: 5000 });
console.log((Date.now() - t0) + "|" + (r.exit.signal ?? "none") + "|" + r.attribution);
')"
BOUNDED_MS="$(echo "$BOUNDED_OUT" | cut -d'|' -f1)"
# 🟡-2（评审实测）：原式 `[[ "$BOUNDED_MS" -lt 20000 ]]` 在读数**为空或非数字**时**判真**
# （bash 把空串当 0）⇒ 探针若完全跑不出输出，这条「有界」断言会**假绿**。
# 修法：先断言「纯数字」（`^[0-9]+$`）再比大小；并加守卫自证（空值 / 非数字必须判否）。
bounded_ok() { [[ "${1:-}" =~ ^[0-9]+$ ]] && [[ "$1" -lt 20000 ]]; }
assert "占死事件循环：耗时读数必须是**纯数字**（空值/非数字不得参与比较）" "yes" "$([[ "$BOUNDED_MS" =~ ^[0-9]+$ ]] && echo yes || echo no)"
assert "占死事件循环：5s timeout 内**有界**返回（< 20s，实测约 5s）" "yes" "$(bounded_ok "$BOUNDED_MS" && echo yes || echo no)"
# 守卫自证：把「为什么必须先判数字」写成可执行断言（防后人改回裸 -lt）
assert "🟡-2 守卫自证：空读数判否（裸 -lt 会把它当 0 判真 = 假绿）" "no" "$(bounded_ok "" && echo yes || echo no)"
assert "🟡-2 守卫自证：非数字读数判否（裸 -lt 会误判）" "no" "$(bounded_ok "abc" && echo yes || echo no)"
assert "🟡-2 守卫自证：正常读数仍判是（收紧不得误伤）" "yes" "$(bounded_ok "5012" && echo yes || echo no)"
assert "占死事件循环：由 SIGKILL 收尾（signal=SIGKILL，非无限等待）" "SIGKILL" "$(echo "$BOUNDED_OUT" | cut -d'|' -f2)"
assert "占死事件循环：归因 PLUGIN_REGRESSION（不甩锅上游）" "PLUGIN_REGRESSION" "$(echo "$BOUNDED_OUT" | cut -d'|' -f3)"

# 反向反证（**为什么必须 SIGKILL**，机器可检、不是注释里的断言）：
# 同一形态的**有界**占死夹具（plugin-busy-loop-hang-plugin，占死时长 > 外层超时），
# 把宿主终止信号换回**旧口径 SIGTERM**（探针为出口③装了 SIGTERM 处理器 ⇒ 默认终止行为被替换
# ⇒ 超时发的 SIGTERM 被吞掉）⇒ 耗时**随插件占死时长走**，超时形同虚设。
# 与上一条的差异只来自 killSignal ⇒ 证明有界性不是环境噪声。两条断言都用相对量（×timeout）。
export DSH_BUSY_LOOP_MS=6000
SIGTERM_OUT="$("$NODE_BIN" --input-type=module -e '
import path from "node:path";
import { runOfflineProbe } from "'"$ROOT"'/tests/offline-probe-harness.mjs";
const TIMEOUT = 1500;
const run = (killSignal) => {
  const t0 = Date.now();
  const r = runOfflineProbe({
    pluginPath: path.join("'"$ROOT"'", "tests/fixtures/plugin-busy-loop-hang-plugin.mjs"),
    expectedTools: ["demo_echo"], timeoutMs: TIMEOUT, killSignal,
  });
  const fails = r.result.checks.filter((c) => c.status === "fail").map((c) => c.name);
  return { ms: Date.now() - t0, timeout: TIMEOUT, signal: r.exit.signal ?? "none", attribution: r.attribution,
    hostFatal: r.result.hostFatal.length, completed: r.result.runCompleted, fails, ok: r.result.ok === true };
};
console.log(JSON.stringify({ killed: run(undefined), legacy: run("SIGTERM") }));
')"
unset DSH_BUSY_LOOP_MS
jk17() { echo "$SIGTERM_OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);const c=r['$1'];console.log(eval('c$2'))})"; }
assert "🔴-1 反向反证（生产口径）：耗时 < 2×timeout（超时真的生效，不随占死时长走）" "true" "$(jk17 killed '.ms < c.timeout * 2')"
assert "🔴-1 反向反证（生产口径）：SIGKILL 收尾 + 归因插件侧 + hostFatal 空 + 未跑完" "SIGKILL|PLUGIN_REGRESSION|0|false" "$(jk17 killed '.signal+"|"+c.attribution+"|"+c.hostFatal+"|"+c.completed')"
assert "🔴-1 反向反证（生产口径）：失败项 plugin.abnormal_termination + 不得假绿" "true|false" "$(jk17 killed '.fails.includes("plugin.abnormal_termination")+"|"+c.ok')"
assert "🔴-1 反向反证（旧口径 SIGTERM）：耗时 ≥ 2×timeout（超时被探针处理器吞掉 ⇒ 形同虚设）" "true" "$(jk17 legacy '.ms >= c.timeout * 2')"
assert "🔴-1 反向反证：SIGTERM 下确实**不是**被超时杀掉的（差异来自 killSignal，非环境噪声）" "false" "$(jk17 legacy '.signal === "SIGKILL"')"

echo "  [18] 🆕 nonce 带外通道（侧信道：只认带 nonce 的报告 + 伪造即判）+ v0.1.9d R28/R26/R24 三形态"
NONCE_OUT="$("$NODE_BIN" --input-type=module -e '
import { interpretProbeStdout } from "'"$ROOT"'/src/harness/host.mjs";
import { createProbeNonce, probeResultLine, probeReportTag, PROBE_RESULT_MARKER, PLUGIN_PROBE_FORGED_RESULT_CHECK } from "'"$ROOT"'/src/harness/contract.mjs";
import { randomBytes } from "node:crypto";
const { value } = createProbeNonce(randomBytes);
const good = { checks: [{ name: "host.tools_ready", status: "pass" }], errors: [], hostFatal: [], ok: true, runCompleted: true, phase: "plugin-integration" };
const forgedLine = "__DSH_PROBE__" + JSON.stringify({ checks: [{ name: "plugin.loaded", status: "pass" }], errors: [], hostFatal: [], ok: true, runCompleted: true, phase: "plugin-integration" }) + "\n";
const realLine = probeResultLine(value, JSON.stringify(good)) + "\n";
// ① 真报告（带 nonce）→ 认；伪造裸 marker → 判伪造
const a = { checks: [], errors: [], hostFatal: [], phase: "host-assembly" };
interpretProbeStdout(a, forgedLine + realLine, { nonce: value });
// ② 只有裸 marker（无 nonce 传入）→ 退化为历史行为（认裸 marker）
const b = { checks: [], errors: [], hostFatal: [], phase: "host-assembly" };
interpretProbeStdout(b, realLine.replace(PROBE_RESULT_MARKER + probeReportTag(value, JSON.stringify(good)) + ":", "__DSH_PROBE__"), {});
// ③ nonce 随机性：两次生成必须不同
const n2 = createProbeNonce(randomBytes);
console.log([
  a.checks.some((c) => c.name === PLUGIN_PROBE_FORGED_RESULT_CHECK && c.status === "fail"),
  a.ok === false,
  a.checks.some((c) => c.name === "host.tools_ready" && c.status === "pass"),
  b.checks.length === 1 && b.ok === true,
  value !== n2.value,
].join("|"));
')"
assert "伪造裸 marker 被判 plugin.probe_result_forged（真缺陷不再被绿卡掩盖）" "true" "$(echo "$NONCE_OUT" | cut -d'|' -f1)"
assert "伪造 ⇒ ok=false（不放行，绝不当成通过）" "true" "$(echo "$NONCE_OUT" | cut -d'|' -f2)"
assert "带 nonce 的真报告仍被正确读取（通道不误伤正常路径）" "true" "$(echo "$NONCE_OUT" | cut -d'|' -f3)"
assert "无 nonce（离线/手工调用）→ 退化为历史行为（认裸 marker）" "true" "$(echo "$NONCE_OUT" | cut -d'|' -f4)"
assert "nonce 值每次随机（固定值 = 没设防）" "true" "$(echo "$NONCE_OUT" | cut -d'|' -f5)"

# 端到端：伪造夹具经**真协议**跑（宿主生成 nonce + 探针带 nonce 输出 + 宿主只认带 nonce 行）
FORGED_OUT="$("$NODE_BIN" --input-type=module -e '
import path from "node:path";
import { runOfflineProbe } from "'"$ROOT"'/tests/offline-probe-harness.mjs";
const r = runOfflineProbe({ pluginPath: path.join("'"$ROOT"'", "tests/fixtures/plugin-forged-result-plugin.mjs"), expectedTools: ["demo_echo"] });
const fails = r.result.checks.filter((c) => c.status === "fail").map((c) => c.name);
console.log([r.attribution, r.result.hostFatal.length, fails.includes("plugin.probe_result_forged"), fails.includes("registry.exact"), r.result.ok === true].join("|"));
')"
assert "伪造夹具（真协议）：归因 PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(echo "$FORGED_OUT" | cut -d'|' -f1)"
assert "伪造夹具（真协议）：hostFatal 为空（不甩锅上游）" "0" "$(echo "$FORGED_OUT" | cut -d'|' -f2)"
assert "伪造夹具（真协议）：失败项含 plugin.probe_result_forged" "true" "$(echo "$FORGED_OUT" | cut -d'|' -f3)"
assert "伪造夹具（真协议）：真实缺陷 registry.exact 仍被抓住（绿卡没掩盖它）" "true" "$(echo "$FORGED_OUT" | cut -d'|' -f4)"
assert "伪造夹具（真协议）：**不得**判通过" "false" "$(echo "$FORGED_OUT" | cut -d'|' -f5)"
# v0.1.9d 新增三形态（评审复评 R24 / R26 / R28）——都是**离线**可判的（秒级，不吃 CI 额度）
assert "R28 防线被顶替：判插件侧 plugin.process_defense_tampered" "true" "$(j defenseTamper '.fails.includes("plugin.process_defense_tampered")')"
assert "R28 防线被顶替：hostFatal 为空 + 完成位仍 true（探针跑完了，只是不知道）" "0|true" "$(j defenseTamper '.hostFatal+"|"+c.completed')"
assert "R28 防线被顶替：归因 PLUGIN_REGRESSION（不放行）" "PLUGIN_REGRESSION" "$(j defenseTamper '.attribution')"
assert "R24 同步死循环：宿主二次终止（probeExit.signal=SIGKILL）" "SIGKILL" "$(j syncLoop '.exitSignal')"
assert "R24 同步死循环：按相位信标归因插件侧 + hostFatal 为空" "true|0" "$(j syncLoop '.fails.includes("plugin.abnormal_termination")+"|"+c.hostFatal')"
assert "R24 同步死循环：完成位 false（未跑完不得判通过）" "false" "$(j syncLoop '.completed')"
assert "R24 同步死循环：归因 PLUGIN_REGRESSION（有信标 ⇒ 不判上游漂移）" "PLUGIN_REGRESSION" "$(j syncLoop '.attribution')"

# 🔴-A（评审复评）：**探针端**「无 nonce 仍出报告」回归。
# 为什么补：旧缺陷是 `probe-template.mjs` 用了 `PROBE_RESULT_MARKER` 但**没 import** ⇒ 任何
# 不带 nonce 的调用（stdin 不可读 / 手工直跑 / 旧宿主）都 `ReferenceError` 硬崩、无结构化结果、
# 被归因成 `UPSTREAM_DRIFT`（探针**自身**缺陷甩锅上游）。而既有 [13] 只测了**解释端**的
# 「无 nonce 退化」，给探针做不到的承诺开了绿灯 —— 故必须在**探针端**补一条。
NONONCE_OUT="$("$NODE_BIN" --input-type=module -e "
import path from 'node:path';
import { runOfflineProbe } from '$ROOT/tests/offline-probe-harness.mjs';
const r = runOfflineProbe({ pluginPath: path.join('$ROOT', 'tests/fixtures/demo-plugin.mjs'), expectedTools: ['demo_echo', 'demo_status'], stdinUnreadable: true });
const checks = r.result.checks;
console.log([
  r.exit.status,
  checks.length,
  checks.filter((c) => c.status === 'pass').length,
  r.result.hostFatal.length,
  r.result.ok === true,
  r.attribution === 'UPSTREAM_DRIFT',
  r.result.runCompleted === true,
].join('|'));
")"
assert "🔴-A 无 nonce（stdin 不可读）：探针**不得**硬崩（rc=0）" "0" "$(echo "$NONONCE_OUT" | cut -d'|' -f1)"
assert "🔴-A 无 nonce：仍出**完整**结构化报告（17 项，不是 checks 归零）" "17" "$(echo "$NONONCE_OUT" | cut -d'|' -f2)"
assert "🔴-A 无 nonce：健康插件仍 17/17 全绿" "17" "$(echo "$NONONCE_OUT" | cut -d'|' -f3)"
assert "🔴-A 无 nonce：hostFatal 为空（探针自身缺陷**不得**写成宿主侧信号）" "0" "$(echo "$NONONCE_OUT" | cut -d'|' -f4)"
assert "🔴-A 无 nonce：完成位=true（跑完了）" "true" "$(echo "$NONONCE_OUT" | cut -d'|' -f7)"
assert "🔴-A 无 nonce：**不得**归因 UPSTREAM_DRIFT（不甩锅上游）" "false" "$(echo "$NONONCE_OUT" | cut -d'|' -f6)"


echo "  [19] 🆕 批 1.5：结果通道可见化 + 降级不得判 PASS + §3 反例固化 + exit 钩子台账"
# 四项分别对应复评裁定的批 1.5 清单：
#   ② 通道可见化（`resultChannel` 落进报告）/ 降级不得放行；
#   ④ §3 反例（真宿主 PoC）固化并进闸门（离线侧先断言夹具自述与关键行为）；
#   ⑧ `'exit'` 钩子纳入 `wrapProcessDefenseApis()` 台账（原先**不可判定**）。
#
# 为什么降级必须能判红（评审 🔴-R2）：`writeResult()` 的返回值原被调用点**丢弃**、
# `out` 里没有任何通道字段 ⇒ 报告里看不到这次走的是哪条通道；而装配器在「结果通道为空」时
# **回落到 stdout** ⇒ 降级等于**静默把防线关掉**（实测：无 fd3 的离线台上 nonce 伪造 +
# `SIGKILL` ⇒ `ok=true / runCompleted=true / hostFatal=0`，**放行**）。
CHANNEL_OUT="$("$NODE_BIN" --input-type=module -e '
import path from "node:path";
import { runOfflineProbe } from "'"$ROOT"'/tests/offline-probe-harness.mjs";
const healthy = path.join("'"$ROOT"'", "tests/fixtures/demo-plugin.mjs");
const tools = ["demo_echo", "demo_status"];
const normal = runOfflineProbe({ pluginPath: healthy, expectedTools: tools });
const degraded = runOfflineProbe({ pluginPath: healthy, expectedTools: tools, noResultChannel: true });
console.log(JSON.stringify({
  normalChannel: normal.result.resultChannel,
  normalOk: normal.result.ok === true,
  normalAttr: normal.attribution,
  degradedChannel: degraded.result.resultChannel,
  degradedOk: degraded.result.ok === true,
  degradedAttr: degraded.attribution,
  degradedHostFatal: degraded.result.hostFatal.length,
  degradedCompleted: degraded.result.runCompleted === true,
  degradedChecks: degraded.result.checks.length,
}));
')"
jc() { echo "$CHANNEL_OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(eval('r$1'))})"; }
assert "正常路径：resultChannel=fd3（通道形态落进报告，排障可见）" "fd3" "$(jc '.normalChannel')"
# 注：离线台的 `attribution` 来自 `attributionDetail()`（**只在失败路径**判归因），健康插件无失败项
# ⇒ 返回 UNKNOWN 属预期；「判 PASS」是 `verifyChannel()` 在 `probe.ok` 为真时的分支（真宿主侧断言）。
# 这里断言的是**新增通道字段不误伤正常路径**：ok 仍为真、无宿主侧信号。
assert "正常路径：ok=true（新增通道字段不误伤正常路径）" "true" "$(jc '.normalOk')"
assert "降级路径：resultChannel=stdout-degraded（**显式可见**，不静默）" "stdout-degraded" "$(jc '.degradedChannel')"
assert "降级路径：**不得判 PASS**（ok=false）" "false" "$(jc '.degradedOk')"
assert "降级路径：归因 UPSTREAM_DRIFT + hostFatal 非空（环境限制 → 宿主/环境侧信号，AMBER 不放行）" "UPSTREAM_DRIFT|1" "$(jc '.degradedAttr+"|"+r.degradedHostFatal')"
assert "降级路径：完成位仍 true（探针跑完了——它只是**知道**通道降级）" "true" "$(jc '.degradedCompleted')"
assert "降级路径：17 项检查仍在（降级不丢报告，只降判决）" "17" "$(jc '.degradedChecks')"

# §3 反例固化：真宿主 PoC 夹具（离线先断言其**自述与关键行为**，真宿主断言见闸门）
POC_SRC="$ROOT/tests/fixtures/plugin-host-tamper-poc-plugin.mjs"
assert "§3 反例夹具存在（复评要求的真宿主 PoC 固化）" "yes" "$([[ -f "$POC_SRC" ]] && echo yes || echo no)"
assert "§3 反例夹具：真的反读 /proc/self/environ（原始 PoC 第一步）" "yes" "$(grep -q '/proc/self/environ' "$POC_SRC" && echo yes || echo no)"
assert "§3 反例夹具：真的反读 /proc/self/cmdline（argv 面）" "yes" "$(grep -q '/proc/self/cmdline' "$POC_SRC" && echo yes || echo no)"
assert "§3 反例夹具：真的向 fd3 写伪造结果" "yes" "$(grep -q 'writeSync(3,' "$POC_SRC" && echo yes || echo no)"
assert "§3 反例夹具：真的摘掉 exit 钩子" "yes" "$(grep -q "removeAllListeners('exit')" "$POC_SRC" && echo yes || echo no)"
assert "§3 反例夹具：真的 process.exit(0) 抢跑" "yes" "$(grep -q 'process.exit(0)' "$POC_SRC" && echo yes || echo no)"

# 出口钩子台账（批 1.5 第 8 项）：**行为级**——只摘 `exit` 钩子的夹具必须被判出（原先不可判定）
HOOK_OUT="$("$NODE_BIN" --input-type=module -e '
import path from "node:path";
import { runOfflineProbe } from "'"$ROOT"'/tests/offline-probe-harness.mjs";
const r = runOfflineProbe({ pluginPath: path.join("'"$ROOT"'", "tests/fixtures/plugin-exit-hook-tamper-plugin.mjs"), expectedTools: ["demo_echo"] });
const fails = r.result.checks.filter((c) => c.status === "fail").map((c) => c.name);
console.log([r.attribution, fails.includes("plugin.process_defense_tampered"), r.result.hostFatal.length, r.result.runCompleted === true, r.result.ok === true].join("|"));
')"
assert "出口钩子被摘（只摘 exit，其余健康）：判 plugin.process_defense_tampered（行为级，原先不可判定）" "PLUGIN_REGRESSION|true|0|true|false" "$HOOK_OUT"

# 出口钩子台账（批 1.5 第 8 项）：`'exit'` 必须在 wrap 的记账范围内 + 身份检查清单里
PROBE_SRC="$ROOT/src/harness/probe-template.mjs"
assert "批 1.5：wrapProcessDefenseApis 的记账事件含 exit（原先出口钩子摘除**不可判定**）" "yes"   "$(grep -q "const targets = \['uncaughtException', 'unhandledRejection', 'exit'\]" "$PROBE_SRC" && echo yes || echo no)"
assert "批 1.5：收尾身份检查的事件清单含 exit" "yes"   "$(grep -q "for (const event of \['uncaughtException', 'unhandledRejection', 'exit'\])" "$PROBE_SRC" && echo yes || echo no)"
assert "批 1.5：exit 钩子具名登记（身份检查的锚点）" "yes"   "$(grep -q "process.on('exit', defenseHandlers.exit)" "$PROBE_SRC" && echo yes || echo no)"

# 段落编号唯一性守卫（评审 🟡-R3②：`test_offline.sh` 曾有**两个 `[13]`**，编号不能再当索引锚）
DUP_SECTIONS="$(grep -oE '^echo "  \[[0-9]+\]' "$ROOT/tests/test_offline.sh" | sed -E 's/.*\[([0-9]+)\].*/\1/' | sort | uniq -d | tr '\n' ',')"
assert "段落编号唯一（重复编号 = 索引不可用，回退即红）" "" "$DUP_SECTIONS"
SECTION_18="$(grep -cE '^echo "  \[18\]' "$ROOT/tests/test_offline.sh")"
assert "文档声称的 [18] 段**真实存在**（曾指向不存在的产物 = 文档撒谎）" "1" "$SECTION_18"

echo "  [20] 🔴 必修-4 同族假绿（猴子补丁 JSON.stringify：加载期捕获 + 退出码交叉）"
# 为什么必须有（评审复评 🔴 必修-4）：R26 的 nonce 侧信道挡「反读凭据 + 冒用协议」，
# 但探针与插件**同进程** ⇒ 插件还能改**序列化函数本身**。实测（v0.2.2 tip）子进程 exit status=1
# 而报告 ok=true / 17 项全 pass ⇒ 失败被吞、绿卡被采信。收口两条**并集**（各自可独立回退即红）。
STRINGIFY_OUT="$("$NODE_BIN" --input-type=module -e '
import path from "node:path";
import { runOfflineProbe, runOfflineProbeWithSources } from "'"$ROOT"'/tests/offline-probe-harness.mjs";
import { readFileSync } from "node:fs";
const ROOT = "'"$ROOT"'";
const fixture = path.join(ROOT, "tests/fixtures/plugin-stringify-tamper-plugin.mjs");
const probeSrc = readFileSync(path.join(ROOT, "src/harness/probe-template.mjs"), "utf8");
const hostSrc = readFileSync(path.join(ROOT, "src/harness/host.mjs"), "utf8");
const probeOf = (r) => {
  const fails = r.result.checks.filter((c) => c.status === "fail").map((c) => c.name);
  return { attribution: r.attribution, ok: r.result.ok === true, hostFatal: r.result.hostFatal.length,
    completed: r.result.runCompleted, fails, exitStatus: r.exit.status, exitSignal: r.exit.signal };
};
// ① 生产口径（两条防线都在）
const fixed = probeOf(runOfflineProbe({ pluginPath: fixture, expectedTools: ["demo_echo"] }));
// ② 变异 A：探针退回「每次取全局 JSON.stringify」⇒ 报告被替换，由**退出码交叉**兜住
const mutatedProbe = probeSrc.replace("const STRINGIFY = JSON.stringify;", "const STRINGIFY = (v) => JSON.stringify(v);");
const mutatedA = probeOf(await runOfflineProbeWithSources({ probeSource: mutatedProbe, pluginPath: fixture, expectedTools: ["demo_echo"] }));
// ③ 变异 B：关掉装配器退出码交叉 ⇒ 由**探针加载期捕获**独立兜住
const mutatedHost = hostSrc.replace("if (payload.ok === true && exitAbnormal) {", "if (false && payload.ok === true && exitAbnormal) {");
const mutatedB = probeOf(await runOfflineProbeWithSources({ pluginPath: fixture, expectedTools: ["demo_echo"], hostSource: mutatedHost }));
// ④ 双回退（残留边界，写进文档，不当承诺）：两条都关 ⇒ 复现「绿卡被采信」
const bothOff = probeOf(await runOfflineProbeWithSources({ probeSource: mutatedProbe, pluginPath: fixture, expectedTools: ["demo_echo"], hostSource: mutatedHost }));
// ⑤ 反向护栏：健康插件在同参数下仍 17/17（防过度修正）
const healthy = runOfflineProbe({ pluginPath: path.join(ROOT, "tests/fixtures/demo-plugin.mjs"), expectedTools: ["demo_echo", "demo_status"] });
console.log(JSON.stringify({
  fixed, mutatedA, mutatedB, bothOff,
  healthy: { pass: healthy.result.checks.filter((c) => c.status === "pass").length,
    fails: healthy.result.checks.filter((c) => c.status === "fail").length,
    completed: healthy.result.runCompleted, hostFatal: healthy.result.hostFatal.length, ok: healthy.result.ok === true },
}));
')"
k20() { echo "$STRINGIFY_OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);const c=r['$1'];console.log(eval('c$2'))})"; }
assert "🔴-4 生产口径：真缺陷 registry.exact 仍被判失败（绿卡不得掩盖它）" "true" "$(k20 fixed '.fails.includes("registry.exact")')"
assert "🔴-4 生产口径：归因 PLUGIN_REGRESSION + hostFatal 为空 + 不放行" "PLUGIN_REGRESSION|0|false" "$(k20 fixed '.attribution+"|"+c.hostFatal+"|"+c.ok')"
assert "🔴-4 生产口径：探针自己判了失败（退出码 1 被装配器记录下来）" "1" "$(k20 fixed '.exitStatus')"
assert "🔴-4 变异回退 A（退回全局序列化）：不得假绿" "false" "$(k20 mutatedA '.ok')"
assert "🔴-4 变异回退 A：由**退出码交叉**兜住（plugin.exit_code_mismatch）" "true" "$(k20 mutatedA '.fails.includes("plugin.exit_code_mismatch")')"
assert "🔴-4 变异回退 A：归因仍 PLUGIN_REGRESSION（不放行）" "PLUGIN_REGRESSION" "$(k20 mutatedA '.attribution')"
assert "🔴-4 变异回退 B（关掉退出码交叉）：不得假绿（探针侧捕获独立兜住）" "false" "$(k20 mutatedB '.ok')"
assert "🔴-4 变异回退 B：真缺陷 registry.exact 仍被判失败" "true" "$(k20 mutatedB '.fails.includes("registry.exact")')"
assert "🔴-4 双回退（残留边界）：复现「绿卡被采信」（两条防线都关 ⇒ ok=true）——口径不得越权承诺" "true" "$(k20 bothOff '.ok')"
assert "🔴-4 反向护栏：健康插件同参数下仍 17/17 全绿 + 跑完" "17|0|true|0" "$(k20 healthy '.pass+"|"+c.fails+"|"+c.completed+"|"+c.hostFatal')"

echo "  [21] 🔴-R3′ 通道重定向 + 压退出码（宿主侧通道观测交叉校验）"
# 为什么必须有（评审复评 🔴-R3′，收窄后的活口）：`plugin.exit_code_mismatch` 判的是「报告 ok=true
# 而退出码非 0」——但**退出码与报告同属探针进程的可写状态**：插件在 `'exit'` 钩子里
# `process.exitCode = 0` 即可压掉，于是旧实现下**GREEN 放行**（真缺陷被绿卡掩盖）。
# 完整形态（夹具 `plugin-channel-redirect-plugin`）：`closeSync(3)` + `openSync(<file>)` 把 fd3
# 换成普通文件 ⇒ 宿主侧管道读端只见 EOF；探针收尾把**真报告**写进那个文件 ⇒ 插件在 `exit`
# 钩子里读回它（**连 nonce 前缀一起拿到**，不必反读 env / argv）；再用该前缀把绿卡写进 stdout。
# 收口判据 = **宿主侧通道观测**（只依赖宿主进程看到的东西，插件压不掉）。
REDIRECT_OUT="$("$NODE_BIN" --input-type=module -e '
import path from "node:path";
import { runOfflineProbe, runOfflineProbeWithSources } from "'"$ROOT"'/tests/offline-probe-harness.mjs";
import { readFileSync } from "node:fs";
const ROOT = "'"$ROOT"'";
const fixture = path.join(ROOT, "tests/fixtures/plugin-channel-redirect-plugin.mjs");
const hostSrc = readFileSync(path.join(ROOT, "src/harness/host.mjs"), "utf8");
const snap = (r) => ({
  attribution: r.attribution, ok: r.result.ok === true, hostFatal: r.result.hostFatal.length,
  completed: r.result.runCompleted, exitStatus: r.exit.status,
  fails: r.result.checks.filter((c) => c.status === "fail").map((c) => c.name),
});
// ① 生产口径：两段式夹具（all = 重定向 + 压退出码；no-squelch = 只重定向）
process.env.DSH_CHANNEL_REDIRECT_MODE = "all";
const fixedAll = snap(runOfflineProbe({ pluginPath: fixture, expectedTools: ["demo_echo"] }));
process.env.DSH_CHANNEL_REDIRECT_MODE = "no-squelch";
const fixedNoSquelch = snap(runOfflineProbe({ pluginPath: fixture, expectedTools: ["demo_echo"] }));
// ② 变异 A：把**整条交叉校验**关掉（主判据 + 辅判据一起）。
//    ⚠️ v0.2.7（🔴-R3′ 4.2 并集）：**只**关判据已**不再**复现假绿——**凭据改造**（正文绑定标签）
//    独立兜住（偷到的标签配自造正文 ⇒ 凭据无效 ⇒ 判 `plugin.probe_result_forged`）。
//    ⇒ 两条腿**并集**：缺任一条仍不放行（比单腿更强）。双回退（+ 凭据退回旧口径）见 ②b。
const mutatedHost = hostSrc.replace(
  "const redirectEvidence = !isolated && stdoutMarkers.length > 0",
  "const redirectEvidence = false && !isolated && stdoutMarkers.length > 0");
process.env.DSH_CHANNEL_REDIRECT_MODE = "all";
const offAll = snap(await runOfflineProbeWithSources({ pluginPath: fixture, expectedTools: ["demo_echo"], hostSource: mutatedHost }));
// ③ 变异 A 下**不压退出码**的形态仍不放行（凭据无效 ⇒ 判伪造）
process.env.DSH_CHANNEL_REDIRECT_MODE = "no-squelch";
const offNoSquelch = snap(await runOfflineProbeWithSources({ pluginPath: fixture, expectedTools: ["demo_echo"], hostSource: mutatedHost }));
// ②b 双回退（判据关掉 + 凭据退回旧口径）⇒ 复现旧实现的假绿（「两条腿都承重」的可执行证据）
const legacyProbeSrc21 = readFileSync(path.join(ROOT, "src/harness/probe-template.mjs"), "utf8").replace(
  "probeResultLine(nonceValue, body)",
  "nonceValue ? PROBE_RESULT_MARKER + nonceValue + \u0027:\u0027 + body : PROBE_RESULT_MARKER + body");
const legacyHostSrc21 = mutatedHost.replace(
  "return { ok: tag === probeReportTag(nonce, body), body };",
  "return { ok: tag === nonce, body };");
process.env.DSH_CHANNEL_REDIRECT_MODE = "all";
const doubleBack21 = snap(await runOfflineProbeWithSources({ pluginPath: fixture, expectedTools: ["demo_echo"], probeSource: legacyProbeSrc21, hostSource: legacyHostSrc21 }));
const doubleBack21Changed = legacyProbeSrc21 !== readFileSync(path.join(ROOT, "src/harness/probe-template.mjs"), "utf8") && legacyHostSrc21 !== mutatedHost;
// ③b 形态 C（🔴-R3 附带 / 评审「下一步要求 ③」）：**自报降级 ⇒ 甩锅上游**（宿主侧 fd3 能力实测）
process.env.DSH_CHANNEL_REDIRECT_MODE = "degrade-claim";
const fixedDegradeClaim = snap(runOfflineProbe({ pluginPath: fixture, expectedTools: ["demo_echo"] }));
// 变异 B′：**只**关「自报降级」分支的三条判据（能力实测 / 宿主侧观测 / 「早探测可写 → 收尾不可写」）
// —— 主判据仍在 ⇒ 该形态仍被主判据兜住（**防御纵深**：两条独立证据链，删一处不放行）。
const mutatedDegradeOnly = hostSrc
  .replace(
    "if (result.resultChannelDegraded && fd3Usable === true && fd3Provided !== false) {",
    "if (false && result.resultChannelDegraded && fd3Usable === true && fd3Provided !== false) {")
  .replace(
    "if (result.resultChannelDegraded && options.resultChannelProvided === true) {",
    "if (false && result.resultChannelDegraded && options.resultChannelProvided === true) {")
  .replace(
    "const channelTampered = closedByPlugin || channelProvidedByHost;",
    "const channelTampered = false;");
const offDegradeClaimMainOff = snap(await runOfflineProbeWithSources({ pluginPath: fixture, expectedTools: ["demo_echo"], hostSource: mutatedDegradeOnly }));
// 变异 B：**回退即红**——把主判据 + 降级分支**全部**退回（= 收口前的口径）⇒ 必须复现「甩锅上游」。
// ⚠️ 凭据也退回旧口径（否则「偷到的标签」验不过 ⇒ 走不到降级分支那一层，见 🔴-R3′ 4.2）。
const mutatedDegrade = mutatedDegradeOnly.replace(
  "const redirectEvidence = !isolated && stdoutMarkers.length > 0",
  "const redirectEvidence = false && !isolated && stdoutMarkers.length > 0");
const legacyHostDegrade = mutatedDegrade.replace(
  "return { ok: tag === probeReportTag(nonce, body), body };",
  "return { ok: tag === nonce, body };");
const legacyProbeDegrade = readFileSync(path.join(ROOT, "src/harness/probe-template.mjs"), "utf8").replace(
  "probeResultLine(nonceValue, body)",
  "nonceValue ? PROBE_RESULT_MARKER + nonceValue + \u0027:\u0027 + body : PROBE_RESULT_MARKER + body");
const offDegradeClaim = snap(await runOfflineProbeWithSources({ pluginPath: fixture, expectedTools: ["demo_echo"], probeSource: legacyProbeDegrade, hostSource: legacyHostDegrade }));
delete process.env.DSH_CHANNEL_REDIRECT_MODE;
// ③c 反向护栏：**真**降级（回归台故意不给 fd3）仍按环境限制处理，不得误判篡改
const realDegrade = runOfflineProbe({ pluginPath: path.join(ROOT, "tests/fixtures/demo-plugin.mjs"), expectedTools: ["demo_echo", "demo_status"], noResultChannel: true });
// ③d 判据级最小复现（脱离真宿主）：自称降级 + 宿主侧实测可用 ⇒ 判篡改（不甩锅）
const { interpretProbeStdout: ips, probeFd3Capability: cap } = await import(ROOT + "/src/harness/host.mjs");
const { createProbeNonce: mkNonce, probeResultLine: mkLine } = await import(ROOT + "/src/harness/contract.mjs");
const { randomBytes: rb } = await import("node:crypto");
const n2 = mkNonce(rb).value;
const degPayload = (rc) => JSON.stringify({ checks: [{ name: "host.tools_ready", status: "pass" }], errors: [], hostFatal: [], ok: true, runCompleted: true, resultChannel: rc, resultChannelAtStart: rc });
const synth = (opts) => { const r = { checks: [], errors: [], hostFatal: [], phase: "host-assembly" }; ips(r, mkLine(n2, degPayload("stdout-degraded")) + "\n", { resultFd: "", nonce: n2, ...opts }); return { ok: r.ok, hostFatal: r.hostFatal.length, fails: r.checks.filter((c) => c.status === "fail").map((c) => c.name) }; };
const synthFake = synth({ fd3Usable: true, fd3Provided: true });
const synthReal = synth({ fd3Usable: true, fd3Provided: false });
const synthLegacy = synth({});
const capVal = cap();
// ④ 反向护栏：健康插件同参数下仍 17/17（防过度修正）
const healthy = runOfflineProbe({ pluginPath: path.join(ROOT, "tests/fixtures/demo-plugin.mjs"), expectedTools: ["demo_echo", "demo_status"] });
console.log(JSON.stringify({
  fd3Capability: capVal,
  fixedAll, fixedNoSquelch, offAll, offNoSquelch, doubleBack21, doubleBack21Changed, fixedDegradeClaim, offDegradeClaim, offDegradeClaimMainOff,
  realDegrade: { attribution: realDegrade.attribution, hostFatal: realDegrade.result.hostFatal.length, tampered: realDegrade.result.checks.some((c) => c.name === "plugin.protocol_injection") },
  synthFake, synthReal, synthLegacy,
  healthy: {
    pass: healthy.result.checks.filter((c) => c.status === "pass").length,
    fails: healthy.result.checks.filter((c) => c.status === "fail").length,
    completed: healthy.result.runCompleted, hostFatal: healthy.result.hostFatal.length, ok: healthy.result.ok === true,
  },
}));
')"
k21() { echo "$REDIRECT_OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);const c=r['$1'];console.log(eval('c$2'))})"; }
assert "🔴-R3′ 生产口径（all：重定向 + 压退出码）：不得假绿（ok=false）" "false" "$(k21 fixedAll '.ok')"
assert "🔴-R3′ 生产口径（all）：判 plugin.protocol_injection（宿主侧通道观测命中）" "true" "$(k21 fixedAll '.fails.includes("plugin.protocol_injection")')"
assert "🔴-R3′ 生产口径（all）：归因 PLUGIN_REGRESSION + hostFatal 为空 + 未跑完" "PLUGIN_REGRESSION|0|false" "$(k21 fixedAll '.attribution+"|"+c.hostFatal+"|"+c.completed')"
assert "🔴-R3′ 生产口径（all）：插件压掉的退出码确实为 0（证明退出码交叉**不再**是唯一兜底）" "0" "$(k21 fixedAll '.exitStatus')"
assert "🔴-R3′ 生产口径（no-squelch：只重定向）：同样判 plugin.protocol_injection" "true" "$(k21 fixedNoSquelch '.fails.includes("plugin.protocol_injection")')"
assert "🔴-R3′ 变异回退（并集）：**只**关判据 ⇒ 仍不得假绿（凭据改造独立兜住）" "false" "$(k21 offAll '.ok')"
assert "🔴-R3′ 变异回退（并集）：失败项为 plugin.probe_result_forged（凭据无效）" "true" "$(k21 offAll '.fails.includes("plugin.probe_result_forged")')"
assert "🔴-R3′ 双回退自证：两处变异确实改动了源码（否则本自证空转）" "true" "$(k21 doubleBack21Changed '.toString()')"
assert "🔴-R3′ 双回退（判据 + 凭据口径）：**复现旧实现的假绿**（ok=true，两条腿都承重）" "true" "$(k21 doubleBack21 '.ok')"
assert "🔴-R3′ 变异回退：不压退出码的形态在变异下仍不放行" "false" "$(k21 offNoSquelch '.ok')"
assert "🔴-R3′ 反向护栏：健康插件同参数下仍 17/17 全绿 + 跑完" "17|0|true|0" "$(k21 healthy '.pass+"|"+c.fails+"|"+c.completed+"|"+c.hostFatal')"
# ---- 🔴-R3 附带（评审「下一步要求 ③」）：**自报降级 ⇒ 甩锅上游** ----
# 插件伪造报告自称 stdout-degraded（=「本环境没有 fd3」）⇒ 旧实现下宿主落 hostFatal[]
# ⇒ UPSTREAM_DRIFT / AMBER（**插件 tamper 被报成环境/上游问题，修错方向**）。
# 收口 = 宿主侧 **fd3 能力独立实测**（probeFd3Capability）：实测可用却自报不可用 ⇒ 自报与事实矛盾。
assert "🔴-R3③ 判据级：自称降级 + 宿主侧实测可用 ⇒ 判 plugin.protocol_injection（不甩锅上游）" "true" "$(k21 synthFake '.fails.includes("plugin.protocol_injection")')"
assert "🔴-R3③ 判据级：**不得**落 hostFatal[]（插件 tamper 不报成环境/上游问题）" "0" "$(k21 synthFake '.hostFatal')"
assert "🔴-R3③ 判据级：真降级（宿主未提供 fd3）⇒ 不误判篡改" "false" "$(k21 synthReal '.fails.includes("plugin.protocol_injection")')"
assert "🔴-R3③ 判据级：真降级仍落 hostFatal（AMBER 不放行）" "1" "$(k21 synthReal '.hostFatal')"
assert "🔴-R3③ 判据级：未传新选项（老装配器 / 合成输入）⇒ 判据不启用（向后兼容）" "false" "$(k21 synthLegacy '.fails.includes("plugin.protocol_injection")')"
assert "🔴-R3③ 行为（自报降级甩锅）：归因**不得** UPSTREAM_DRIFT" "PLUGIN_REGRESSION" "$(k21 fixedDegradeClaim '.attribution')"
assert "🔴-R3③ 行为（自报降级甩锅）：hostFatal 为空 + 判 plugin.protocol_injection" "0|true" "$(k21 fixedDegradeClaim '.hostFatal+"|"+c.fails.includes("plugin.protocol_injection")')"
assert "🔴-R3③ 变异回退（三条判据全退回）：**复现甩锅上游**（UPSTREAM_DRIFT / AMBER）" "UPSTREAM_DRIFT" "$(k21 offDegradeClaim '.attribution')"
assert "🔴-R3③ 防御纵深：只关降级分支 ⇒ 仍被**主判据**兜住（判 plugin.protocol_injection / 不放行）" "true|false" "$(k21 offDegradeClaimMainOff '.fails.includes("plugin.protocol_injection")+"|"+c.ok')"
assert "🔴-R3③ 变异回退：此时 hostFatal 非空（责任被推给环境）" "true" "$(k21 offDegradeClaim '.hostFatal > 0')"
assert "🔴-R3③ 反向护栏：**真**降级（离线台故意不给 fd3）仍判 UPSTREAM_DRIFT + hostFatal 非空 + 不误判篡改" "UPSTREAM_DRIFT|1|false" "$(k21 realDegrade '.attribution+"|"+r.realDegrade.hostFatal+"|"+r.realDegrade.tampered')"
assert "🔴-R3③ 宿主侧 fd3 能力实测可用（本环境；判据的前提）" "true" "$(echo "$REDIRECT_OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).fd3Capability)})")"

# 夹具自检：否则上面的行为断言空转
REDIRECT_FIXTURE="$ROOT/tests/fixtures/plugin-channel-redirect-plugin.mjs"
assert "🔴-R3′ 夹具存在（真宿主侧进闸门的对象）" "yes" "$([[ -f "$REDIRECT_FIXTURE" ]] && echo yes || echo no)"
assert "🔴-R3′ 夹具：真的把 fd 3 换成普通文件（closeSync(3) + openSync）" "yes" "$(grep -q 'closeSync(3)' "$REDIRECT_FIXTURE" && grep -q 'openSync(REDIRECT_PATH' "$REDIRECT_FIXTURE" && echo yes || echo no)"
assert "🔴-R3′ 夹具：真的从重定向文件里读回探针的**真报告**（拿到 nonce 前缀）" "yes" "$(grep -q 'readFileSync(REDIRECT_PATH' "$REDIRECT_FIXTURE" && echo yes || echo no)"
assert "🔴-R3′ 夹具：真的把伪造绿卡写进 stdout" "yes" "$(grep -q 'writeSync(1,' "$REDIRECT_FIXTURE" && echo yes || echo no)"
assert "🔴-R3′ 夹具：真的压退出码（R3′ 相对 R3 的唯一增量）" "yes" "$(grep -q 'process.exitCode = 0' "$REDIRECT_FIXTURE" && echo yes || echo no)"
assert "🔴-R3′ 夹具：真缺陷（多注册 demo_extra ⇒ registry.exact 应红）" "yes" "$(grep -q 'demo_extra' "$REDIRECT_FIXTURE" && echo yes || echo no)"

echo "  [22] 🔴-R3：结果通道**被重定向**（交叉校验）+ §三 同源形态（自报降级甩锅上游）"
# 为什么单列（评审复评 🔴-R3，**放行级假绿**）：插件 `closeSync(3)` + `openSync(sink,'w')`
# **抢占 fd 号 3** ⇒ 探针的 `writeSync(3, …)` 写进**插件的文件**（写成功 ⇒ 自报 `fd3`，对重定向
# 一无所知）；宿主侧那条 pipe 于是为空 ⇒ 装配器回落 stdout ⇒ 插件在 exit 钩子里读回真报告、
# 取 nonce、向 stdout 写**带正确 nonce** 的绿卡 ⇒ 收口前实测 **GREEN / PASS（放行）**。
#
# 本段是**离线合成输入**那一半（真宿主夹具那一半见闸门 `tests/gate_plugin_side.sh` 与
# `tests/test_e2e_regression.mjs` [8h]）：直接把「宿主侧观测 + stdout/结果通道文本」喂给
# 装配器的**真实实现**，断言判据本身；再用**变异回退**证明「删该判据即红」。
R3_OUT="$("$NODE_BIN" --input-type=module -e '
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { interpretProbeStdout } from "'"$ROOT"'/src/harness/host.mjs";
import { attributeFailure } from "'"$ROOT"'/src/verify/runner.mjs";
import { createProbeNonce, probeResultLine } from "'"$ROOT"'/src/harness/contract.mjs";
import { runOfflineProbe, runOfflineProbeWithSources } from "'"$ROOT"'/tests/offline-probe-harness.mjs";
const ROOT = "'"$ROOT"'";
const channel = { label: "stable", line: "0.1.5" };
const nonce = createProbeNonce(randomBytes).value;
const payload = (extra = {}) => JSON.stringify({
  checks: [{ name: "host.tools_ready", status: "pass" }], errors: [], hostFatal: [],
  ok: true, runCompleted: true, phase: "plugin-integration", resultChannel: "fd3", ...extra,
});
const fresh = () => ({ checks: [], errors: [], hostFatal: [], phase: "host-assembly" });
const probeOf = (r) => ({
  fails: r.checks.map((c) => c.name + ":" + c.status), ok: r.ok === true, completed: r.runCompleted,
  hostFatal: r.hostFatal.length, attribution: attributeFailure(r, channel, "stable"), resultChannel: r.resultChannel,
});
// ① 正向（宿主给了 fd3 却为空 + stdout 有匹配 nonce 行）⇒ 判重定向
const fwd = fresh();
interpretProbeStdout(fwd, probeResultLine(nonce, payload()) + "\n", { resultFd: "", nonce, resultChannelProvided: true });
// ② 反向护栏（宿主**真的**没给 fd3 + 自称降级）⇒ 真降级，不得误判篡改
const rev = fresh();
interpretProbeStdout(rev, probeResultLine(nonce, payload({ resultChannel: "stdout-degraded" })) + "\n", { resultFd: "", nonce, resultChannelProvided: false });
// ③ §三（宿主给了 fd3 却自报降级 + 伪造 hostFatal）⇒ 判篡改、不甩锅
const deg = fresh();
interpretProbeStdout(deg, probeResultLine(nonce, payload({ resultChannel: "stdout-degraded", resultChannelAtStart: undefined, hostFatal: ["上游契约变更（伪造）"] })) + "\n", { resultFd: "", nonce, resultChannelProvided: true });
// ④ 正常路径（fd3 有内容 / stdout 只有日志）⇒ 不得误判
const okp = fresh();
interpretProbeStdout(okp, "__DSH_PROBE_PHASE__plugin-integration\n日志\n", { resultFd: probeResultLine(nonce, payload()) + "\n", nonce, resultChannelProvided: true });
// ⑤ 真宿主夹具（离线台 = 真 spawn + 假宿主 + 装配器真实实现）
const fRedir = runOfflineProbe({ pluginPath: path.join(ROOT, "tests/fixtures/plugin-channel-redirect-plugin.mjs"), expectedTools: ["demo_echo"] });
const fDeg = runOfflineProbe({ pluginPath: path.join(ROOT, "tests/fixtures/plugin-channel-degrade-forge-plugin.mjs"), expectedTools: ["demo_echo"] });
// ⑥ 变异回退（**删该判据即红**）：把交叉校验整条关掉 ⇒ 重定向形态必须复现假绿
const hostSrc = readFileSync(path.join(ROOT, "src/harness/host.mjs"), "utf8");
const mutated = hostSrc.replace(
  "const redirectEvidence = !isolated && stdoutMarkers.length > 0",
  "const redirectEvidence = false && !isolated && stdoutMarkers.length > 0",
);
const mutProbeOf = (r) => ({ ok: r.result.ok === true, pass: r.result.checks.filter((c) => c.status === "pass").length, attribution: r.attribution });
const mutatedRun = mutProbeOf(await runOfflineProbeWithSources({ pluginPath: path.join(ROOT, "tests/fixtures/plugin-channel-redirect-plugin.mjs"), expectedTools: ["demo_echo"], hostSource: mutated }));
// ⑥b 双回退（判据 + 凭据一起退回旧口径）⇒ 复现旧实现的假绿（两条腿都承重）
const legacyHost22 = mutated.replace(
  "return { ok: tag === probeReportTag(nonce, body), body };",
  "return { ok: tag === nonce, body };");
const legacyProbe22 = readFileSync(path.join(ROOT, "src/harness/probe-template.mjs"), "utf8").replace(
  "probeResultLine(nonceValue, body)",
  "nonceValue ? PROBE_RESULT_MARKER + nonceValue + \u0027:\u0027 + body : PROBE_RESULT_MARKER + body");
const mutatedRun2 = mutProbeOf(await runOfflineProbeWithSources({ pluginPath: path.join(ROOT, "tests/fixtures/plugin-channel-redirect-plugin.mjs"), expectedTools: ["demo_echo"], probeSource: legacyProbe22, hostSource: legacyHost22 }));
console.log(JSON.stringify({
  fwd: probeOf(fwd), rev: probeOf(rev), deg: probeOf(deg), okp: probeOf(okp),
  fixtureRedirect: { attribution: fRedir.attribution, ok: fRedir.result.ok === true, fails: fRedir.result.checks.map((c) => c.name + ":" + c.status), hostFatal: fRedir.result.hostFatal.length, completed: fRedir.result.runCompleted, resultChannel: fRedir.result.resultChannel },
  fixtureDegrade: { attribution: fDeg.attribution, ok: fDeg.result.ok === true, fails: fDeg.result.checks.map((c) => c.name + ":" + c.status), hostFatal: fDeg.result.hostFatal.length, completed: fDeg.result.runCompleted },
  mutation: { changed: mutated !== hostSrc, run: mutatedRun, changed2: legacyProbe22 !== readFileSync(path.join(ROOT, "src/harness/probe-template.mjs"), "utf8") && legacyHost22 !== mutated, run2: mutatedRun2 },
}));
')"
k22() { echo "$R3_OUT" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(eval('r$1'))})"; }
assert "🔴-R3 合成输入（正向）：宿主已给 fd3 却为空 + stdout 有匹配 nonce 行 ⇒ 判 plugin.protocol_injection" "plugin.protocol_injection:fail" "$(k22 '.fwd.fails.join(",")')"
assert "🔴-R3 合成输入（正向）：不采信任何一条（只剩篡改证据）+ 不放行" "false|false" "$(k22 '.fwd.ok+"|"+r.fwd.completed')"
assert "🔴-R3 合成输入（正向）：hostFatal 为空（不甩锅上游）" "0" "$(k22 '.fwd.hostFatal')"
assert "🔴-R3 合成输入（正向）：归因 PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(k22 '.fwd.attribution')"
assert "🔴-R3 合成输入（正向）：通道形态可见化为 fd3-redirected" "fd3-redirected" "$(k22 '.fwd.resultChannel')"
assert "🔴-R3 反向护栏：宿主**真的**没给 fd3 + 自称降级 ⇒ 真降级不误伤（不判篡改）" "false" "$(k22 '.rev.fails.some((x) => x.startsWith("plugin.protocol_injection"))')"
assert "🔴-R3 反向护栏：真降级仍落宿主/环境侧（hostFatal 非空 ⇒ AMBER 不放行）" "UPSTREAM_DRIFT|true" "$(k22 '.rev.attribution+"|"+(r.rev.hostFatal>0)')"
assert "🔴-R3 §三（同源）：宿主给了 fd3 却自报降级 ⇒ 判篡改（收口前实测甩锅上游）" "plugin.protocol_injection:fail|PLUGIN_REGRESSION|0" "$(k22 '.deg.fails.join(",")+"|"+r.deg.attribution+"|"+r.deg.hostFatal')"
assert "🔴-R3 反向护栏：正常路径（fd3 有内容 / stdout 只有日志）不误判" "host.tools_ready:pass|true" "$(k22 '.okp.fails.join(",")+"|"+r.okp.ok')"
assert "🔴-R3 真宿主夹具（离线台）：重定向 ⇒ PLUGIN_REGRESSION / 不放行 / hostFatal=0 / 完成位 false" "PLUGIN_REGRESSION|false|0|false" "$(k22 '.fixtureRedirect.attribution+"|"+r.fixtureRedirect.ok+"|"+r.fixtureRedirect.hostFatal+"|"+r.fixtureRedirect.completed')"
assert "🔴-R3 真宿主夹具（离线台）：§三 同源形态 ⇒ PLUGIN_REGRESSION / 不放行 / hostFatal=0" "PLUGIN_REGRESSION|false|0|false" "$(k22 '.fixtureDegrade.attribution+"|"+r.fixtureDegrade.ok+"|"+r.fixtureDegrade.hostFatal+"|"+r.fixtureDegrade.completed')"
assert "🔴-R3 变异自证：变异确实改动了源码（否则下面的断言空转）" "true" "$(k22 '.mutation.changed')"
assert "🔴-R3 变异回退（并集）：**只**关交叉校验 ⇒ 仍不得假绿（凭据改造独立兜住）" "false" "$(k22 '.mutation.run.ok')"
assert "🔴-R3 双回退自证：两处变异确实改动了源码" "true" "$(k22 '.mutation.changed2')"
assert "🔴-R3 双回退（判据 + 凭据口径）：**复现旧实现的假绿**（ok=true，两条腿都承重）" "true" "$(k22 '.mutation.run2.ok')"
assert "🔴-R3 双回退：复现的绿卡里 17 项全 pass（真缺陷被掩盖）" "17" "$(k22 '.mutation.run2.pass')"

echo
echo "▶ 离线单元测试结果：PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
