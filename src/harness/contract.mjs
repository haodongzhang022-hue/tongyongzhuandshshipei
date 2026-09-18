/**
 * 契约指纹采集（上游漂移侦测的基线来源）。
 *
 * ## 为什么单独成模块
 * 采集要在**真实宿主**上真的调用 `tools.register()` 才能拿到上游措辞；
 * 而「注册了就必须卸载」是本模块最容易写错、也最容易把归因带跑的地方
 * （残留的探测工具会污染被测插件的工具清单 → 假失败 → 责任甩给插件）。
 * 因此把采集逻辑抽成**可离线单测**的纯函数：探针（真宿主）与离线单测
 * （假 `tools`）共用同一份实现，回归防线才不会只存在于真宿主 E2E 里。
 *
 * ## 纪律
 * - 每次探测 `register()` 成功后**立即 dispose**（`finally` 保证，抛错也卸）；
 * - 采集结果只反映上游**措辞**，不保留任何宿主副作用。
 *
 * @module dsh-adapt-hub/harness/contract
 */

/**
 * 三条契约探测（字段名与 `watch/upstream.mjs` 的 `CONTRACT_FIELDS` 对齐）。
 *
 * @type {{field: string, accepted: string, definition: () => object}[]}
 */
export const CONTRACT_PROBES = [
  {
    field: 'reservedName',
    accepted: 'ACCEPTED(unexpected)',
    definition: () => ({
      name: 'run_code',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} }, render: () => [] },
      execute: async () => ({}),
    }),
  },
  {
    field: 'schemaSubset',
    accepted: 'ACCEPTED(unexpected)',
    definition: () => ({
      name: 'probe_bad_schema',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { a: { type: 'json' } } }, render: () => [] },
      execute: async () => ({}),
    }),
  },
  {
    field: 'outputShape',
    accepted: 'render-optional',
    definition: () => ({
      name: 'probe_no_render',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {} } },
      execute: async () => ({}),
    }),
  },
];

/**
 * 归因判据表（**唯一事实源**，探针与 `verify/runner` 共用）。
 *
 * 为什么要放在这里：探针（临时目录里跑）与执行器（仓库里跑）必须用**同一份**名单，
 * 否则一侧新增 check 而另一侧忘了登记，就会退化成「未知失败 → 不归因」甚至误判。
 * 放在被拷进临时目录的 `contract.mjs` 里，两侧 import 同一份。
 */

/** 宿主/环境侧致命前缀（由探针与装配器显式标注；插件侧错误**永远不会**带此前缀）。 */
export const HOST_FATAL_PREFIX = 'fatal(host)';

/** 宿主/环境侧检查项（失败即判上游漂移：宿主未就绪 / 版本线不可判定 / 契约探测未卸载）。 */
export const HOST_SIDE_CHECKS = ['host.tools_ready', 'detect.flavor_known', 'contract.probe_disposed'];

/** 中台自身契约检查项（失败是否算上游漂移，取决于契约基线是否漂移）。 */
export const CONTRACT_SIDE_CHECKS = ['guard.reserved_name', 'compat.schema_flatten'];

/**
 * 插件侧**硬证据**检查项：失败即插件违反宿主硬约束，判 `PLUGIN_REGRESSION`，
 * **优先于任何漂移相关性**（漂移窗口内也必须成立，见评审 🔴-C）。
 *
 * 纪律：**精确 check 名，不做前缀通配**。
 * - `guard.reserved_rejected`：插件声明了 DSH 保留名（插件侧违规，与上游契约无关）；
 * - `guard.reserved_name` **不在**此列：它是中台自检（hub 自身护栏坏了），
 *   不是插件违规；把它算进硬证据会过度修正（评审 🟡-1）。
 *
 * 反例（为什么必须优先）：上游若放宽保留名校验（`reservedName` 漂移），
 * `guard.reserved_rejected` 仍会 fail——若让漂移相关性先判，插件侧硬违规会被
 * 吞成 `UPSTREAM_DRIFT`/AMBER，责任被甩给上游（历史缺陷 🔴-C）。
 *
 * @type {readonly string[]}
 */
export const PLUGIN_HARD_EVIDENCE = ['guard.reserved_rejected'];

/** 插件侧检查项（失败即判插件回归；归因优先级低于宿主侧与插件侧硬证据）。 */
export const PLUGIN_SIDE_CHECKS = [
  'plugin.loaded',
  'plugin.apply_ok',
  'plugin.definitions_ok',
  'registry.exact',
  'dispatch.execute_ok',
  'dispatch.render_projected',
  'dispatch.echo_payload',
  'dispatch.abort_semantics',
  'lifecycle.disposer_count',
  'lifecycle.registered',
  'lifecycle.dispose',
  'guard.reserved_rejected',
];

/** 探测工具名（用于残留自检；这三个名字不得出现在被测插件可见的工具清单里）。 */
export const CONTRACT_PROBE_NAMES = ['run_code', 'probe_bad_schema', 'probe_no_render'];

/**
 * 采集契约指纹。
 *
 * @param {{ register: (definition: object) => unknown, schemas?: () => {name:string}[] }} tools 宿主 `ctx.tools`
 * @returns {{contract: Record<string,string>, probes: {field:string,accepted:boolean,disposed:boolean}[], residue: string[]}}
 *   - `contract`：字段 → 上游措辞（被接受时记 `ACCEPTED(unexpected)` / `render-optional`）；
 *   - `probes`：每个探测的接受/卸载实况（排障与单测用）；
 *   - `residue`：采集后仍在宿主工具清单里的探测工具名（**正常必须为空**）。
 */
export function collectContract(tools) {
  const contract = {};
  const probes = [];

  for (const probe of CONTRACT_PROBES) {
    let disposer;
    let accepted = false;
    let disposed = false;
    try {
      disposer = tools.register(probe.definition());
      accepted = true;
      contract[probe.field] = probe.accepted;
    } catch (error) {
      contract[probe.field] = String(error?.message ?? error);
    } finally {
      // 关键：上游若「接受」了探测定义，注册就真的生效了——必须立即卸载，
      // 否则残留工具会污染被测插件的工具清单（历史上正是这条把插件误判成回归）。
      if (typeof disposer === 'function') {
        try { disposer(); disposed = true; } catch { disposed = false; }
      }
      probes.push({ field: probe.field, accepted, disposed });
    }
  }

  let residue = [];
  if (typeof tools?.schemas === 'function') {
    try {
      residue = tools
        .schemas()
        .map((schema) => schema?.name)
        .filter((name) => CONTRACT_PROBE_NAMES.includes(name));
    } catch {
      residue = [];
    }
  }

  return { contract, probes, residue };
}
