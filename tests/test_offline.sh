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
import { PROBE_PHASE, recordProbeException } from '$ROOT/src/harness/contract.mjs';
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
const known = new Set([...HOST_SIDE_CHECKS, ...CONTRACT_SIDE_CHECKS, ...PLUGIN_SIDE_CHECKS,
  'host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed',
  'guard.reserved_name', 'compat.schema_flatten', 'guard.reserved_rejected',
  'plugin.loaded', 'plugin.apply_ok', 'plugin.definitions_ok', 'registry.exact',
  'dispatch.execute_ok', 'dispatch.render_projected', 'dispatch.echo_payload', 'dispatch.abort_semantics',
  'lifecycle.disposer_count', 'lifecycle.registered', 'lifecycle.dispose']);
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

echo
echo "▶ 离线单元测试结果：PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
