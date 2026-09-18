/**
 * DSH 宿主版本线探测（flavor detection）。
 *
 * ## 为什么不用 `import`
 * 插件**不得** `import` 任何 `@deepseek-ai/*` 运行时符号——那会把 peer 版本
 * 钉死在产物里，正是「每适配一次新版就得改一次代码」的根因之一。本模块只
 * 读取**已就绪的宿主实例**上的公开投影。
 *
 * ## 指纹（实测三条线）
 * `ctx.tools.constructor.Config`（schemastery schema）的 `toString()` 投影：
 * ```
 * legacy (0.1.1 线)  → { mode?: "native" | "code" | "both", maxParallelSubCalls?: number }
 * modern (0.1.5/0.1.6 线) → { mode?: "native" | "ptc"  | "both", maxParallelSubCalls?: number }
 * ```
 * `code` → legacy；`ptc` → modern；两者都不命中 → unknown（按兼容路径注册，
 * **不抛错、不阻断加载**——未知不等于不兼容）。
 *
 * @module dsh-adapt-hub/detect/flavor
 */

/** @typedef {'modern'|'legacy'|'unknown'} DshFlavor */

/** 宿主探测结果。 */
export class HostProfile {
  /**
   * @param {DshFlavor} flavor 版本线
   * @param {string} evidence 人类可读依据（排障用）
   * @param {Record<string, unknown>} signals 结构化信号（机器可读）
   */
  constructor(flavor, evidence, signals) {
    /** @type {DshFlavor} */
    this.flavor = flavor;
    /** @type {string} */
    this.evidence = evidence;
    /** @type {Record<string, unknown>} */
    this.signals = signals;
  }

  /** 是否为新版线（PTC mode）。 */
  get isModern() {
    return this.flavor === 'modern';
  }

  /** 是否为旧版线（Code mode）。 */
  get isLegacy() {
    return this.flavor === 'legacy';
  }

  /** 是否无法判定。 */
  get isUnknown() {
    return this.flavor === 'unknown';
  }

  /** 序列化为纯 JSON（供报告 / 二级信息输出）。 */
  toJSON() {
    return { flavor: this.flavor, evidence: this.evidence, signals: this.signals };
  }
}

/**
 * 探测宿主版本线。
 *
 * @param {unknown} tools `ctx.tools`（ToolRuntime 实例）；缺失时返回 unknown
 * @returns {HostProfile}
 */
export function detectHostFlavor(tools) {
  const signals = {};
  if (!tools || typeof tools !== 'object') {
    return new HostProfile('unknown', 'ctx.tools 未就绪（宿主未装配 ToolRuntime）', signals);
  }

  // 信号 1：Config schema 投影（主指纹）
  let rendered = '';
  try {
    const cfg = /** @type {{ constructor?: { Config?: unknown } }} */ (tools).constructor?.Config;
    if (cfg && typeof cfg.toString === 'function') rendered = String(cfg);
  } catch {
    rendered = '';
  }
  signals.configProjection = rendered.slice(0, 400);

  if (/["']ptc["']/.test(rendered)) {
    return new HostProfile('modern', `tools.Config.mode ~ ${rendered}`, signals);
  }
  if (/["']code["']/.test(rendered)) {
    return new HostProfile('legacy', `tools.Config.mode ~ ${rendered}`, signals);
  }

  // 信号 2：保留名拒绝措辞（Config 不可读时的兜底指纹）
  // 注意：兜底探测会真的调用 `tools.register`，因此**探测后必须立即 dispose**，
  // 不得在宿主上残留探测工具（否则一次探测即污染宿主工具目录）。
  try {
    const disposer = tools.register({
      name: 'run_code',
      description: 'flavor-probe',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
      execute: async () => ({}),
    });
    signals.reservedProbe = 'accepted';
    // 接受保留名的宿主（正是本中台要侦测的上游漂移）：立即卸载，不留副作用
    if (typeof disposer === 'function') {
      try { disposer(); signals.reservedProbeDisposed = true; } catch { signals.reservedProbeDisposed = false; }
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    signals.reservedProbe = message;
    if (/PTC mode/i.test(message)) return new HostProfile('modern', `reserved-name probe: ${message}`, signals);
    if (/Code Mode/i.test(message)) return new HostProfile('legacy', `reserved-name probe: ${message}`, signals);
  }

  return new HostProfile('unknown', `无法从宿主投影判定版本线（configProjection=${JSON.stringify(rendered.slice(0, 120))}）`, signals);
}

/**
 * 按探测结果选择适配路径（未知 → 走兼容路径，绝不抛错）。
 *
 * @template T
 * @param {HostProfile} profile 探测结果
 * @param {{ modern?: () => T, legacy?: () => T, fallback: () => T }} branches 分支
 * @returns {T}
 */
export function adaptByFlavor(profile, branches) {
  if (profile.isModern && branches.modern) return branches.modern();
  if (profile.isLegacy && branches.legacy) return branches.legacy();
  return branches.fallback();
}
