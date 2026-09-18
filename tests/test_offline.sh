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

echo "  [5] 归因判定（上游漂移 vs 插件回归）"
OUT="$("$NODE_BIN" --input-type=module -e "
import { attributeFailure } from '$ROOT/src/verify/runner.mjs';
const ch = { label: 'x', line: '0.1.6' };
console.log(attributeFailure({ errors:['npm ETARGET notarget'], profile:null, checks:[] }, ch, 'dev'));
console.log(attributeFailure({ errors:['host.tools_ready: ctx.tools 未就绪'], profile:{flavor:'unknown'}, checks:[] }, ch, 'dev'));
console.log(attributeFailure({ errors:['registry.exact: 期望 a / 实得 b'], profile:{flavor:'modern'}, checks:[] }, ch, 'dev'));
console.log(attributeFailure({ errors:['dispatch.execute_ok: Error'], profile:{flavor:'modern'}, checks:[] }, ch, 'dev'));
")"
assert "钉版缺失 → UPSTREAM_DRIFT" "UPSTREAM_DRIFT" "$(echo "$OUT" | sed -n 1p)"
assert "宿主未就绪 → UPSTREAM_DRIFT" "UPSTREAM_DRIFT" "$(echo "$OUT" | sed -n 2p)"
assert "工具清单不符 → PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 3p)"
assert "dispatch 失败 → PLUGIN_REGRESSION" "PLUGIN_REGRESSION" "$(echo "$OUT" | sed -n 4p)"

echo "  [6] 汇报渲染（二级信息）"
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

echo
echo "▶ 离线单元测试结果：PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
