/**
 * 二级信息汇报（供人类观察者快速俯瞰 + AI 稳定解析）。
 *
 * 同一份结构化数据出两个视图：
 * - `toJson`：机器可读（AI 优先，可索引、可 diff）；
 * - `toMarkdown`：人类俯瞰（状态灯 + 风险 + 决策 + 索引）。
 *
 * @module dsh-adapt-hub/report/secondary
 */

import { RESULT_CHANNEL_FD3_REDIRECTED } from '../harness/contract.mjs';

const LAMP = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️' };

/**
 * 通道报告 → 二级信息视图。
 *
 * @param {object} report verifyAll 的产物
 * @returns {object} 结构化二级信息
 */
export function buildSecondary(report) {
  const channels = report.channels ?? [];
  const summary = report.summary ?? {};
  const risks = [];

  for (const channel of channels) {
    // 结果通道降级（批 1.5 / 🔴-R2）：**必须显式可见**——降级后 stdout 上的结果行不再构成
    // 篡改证据，故本轮结论不可信。独立成一条风险（即便 channel.ok 为假也已由下面的通用分支覆盖，
    // 这里保证「降级」这件事**不会**被淹没在别的失败原因里）。
    if (channel.resultChannelDegraded === true) {
      // 🔴-R3③：降级有**两种完全相反**的成因，报告必须分开说，否则人会把「插件篡改通道」读成「环境限制」：
      // - 自报降级 + **宿主侧 fd3 能力实测可用** ⇒ 自报与事实矛盾 ⇒ 插件关闭/替换了通道
      //   （落插件侧 check `plugin.protocol_injection`，归因 PLUGIN_REGRESSION）；
      // - 真降级（宿主未提供 / 实测不可用）⇒ 环境限制 ⇒ `hostFatal[]` ⇒ UPSTREAM_DRIFT（AMBER）。
      const tampered = (channel.checks ?? []).some((c) => c.name === 'plugin.protocol_injection' && c.status === 'fail');
      risks.push({
        severity: 'HIGH',
        channel: channel.channel,
        attribution: channel.attribution,
        description: tampered
          ? `${channel.label ?? channel.channel} 报告**自称**结果通道降级（\`${channel.resultChannel}\`），但宿主侧 fd3 能力**实测可用** ⇒ 自报与事实矛盾 ⇒ 通道是在插件代码运行期间被**关闭/替换**的（判插件侧 \`plugin.protocol_injection\`），本轮结论**不可信**（不得判 PASS）`
          : `${channel.label ?? channel.channel} 结构化结果的**通道降级**（\`${channel.resultChannel}\`）：fd3 不可用 ⇒ 结果走 stdout，「stdout 上出现结果行」不再构成篡改证据 ⇒ 本轮结论**不可信**（不得判 PASS）`,
        reasons: [`resultChannel=${channel.resultChannel}`, `resultChannelAtStart=${channel.resultChannelAtStart ?? 'null'}`, `protocolInjection=${tampered}`],
        mitigation: tampered
          ? '插件侧问题：不要关闭 / 重定向探针的结果通道（fd3），也不要伪造报告里的 resultChannel 字段'
          : '修环境（容器 / Windows 需支持 fd3）或改用支持独立 fd 的执行方式；降级运行**不得**作为放行依据',
        hostFatal: channel.hostFatal ?? [],
        errors: channel.errors ?? [],
      });
    }
    // 🔴-R3 通道**被重定向**（宿主侧观测结论，非探针自报）：与「降级」**必须区分**——
    // 降级 = 宿主没给 fd3（环境限制，归因上游）；重定向 = 宿主给了 fd3、却被插件换掉（归因插件）。
    // 独立成一条风险，保证这件事不会被淹没在别的失败原因里。
    if (channel.resultChannel === RESULT_CHANNEL_FD3_REDIRECTED) {
      risks.push({
        severity: 'HIGH',
        channel: channel.channel,
        attribution: channel.attribution,
        description: channel.resultChannelDegradeClaimed === true
          // 🔴-R3 §三（**同源**成因）：报告**自称**降级，而宿主侧观测/实测说明 fd3 **可用**
          // ⇒ 自报与事实矛盾（不是环境限制）⇒ 报告层必须点明，否则人会把插件篡改读成「修环境」。
          ? `${channel.label ?? channel.channel} 报告**自称**结果通道降级（\`stdout-degraded\`，即「本环境没有 fd3」），但宿主侧 fd3 **实测可用 / 本次已作为管道提供** ⇒ **自报与事实矛盾** ⇒ 通道是在插件代码运行期间被**关闭/替换**的（判插件侧 \`plugin.protocol_injection\`），本轮结论**不可信**（不得判 PASS）`
          : `${channel.label ?? channel.channel} 结果通道**被重定向**（\`${channel.resultChannel}\`，**宿主侧观测结论**）：宿主已把 fd3 作为管道交给探针，fd3 却为空、stdout 上出现匹配 nonce 的结果行 ⇒ 探针写进的是插件的文件，本轮结果**整体不可信**（不采信任何一条）`,
        reasons: [
          `resultChannel=${channel.resultChannel}`,
          `resultChannelAtStart=${channel.resultChannelAtStart ?? 'null'}`,
          '判据：宿主侧观测（probeSpawnOptions().stdio[3] === \'pipe\'）与报告自称互相矛盾 ⇒ plugin.protocol_injection',
        ],
        mitigation: channel.resultChannelDegradeClaimed === true
          ? '**插件侧**问题：不要关闭 / 重定向探针的结果通道（fd3），也不要伪造报告里的 resultChannel 字段；**不得**把本形态当成环境降级（降级 = 宿主没给 fd3）'
          : '查插件（或其依赖）是否关闭/替换了探针的结果 fd（closeSync(3) / 重定向 fd3）；**不得**把本形态当成环境降级（降级 = 宿主没给 fd3）',
        hostFatal: channel.hostFatal ?? [],
        errors: channel.errors ?? [],
      });
    }
    if (channel.ok) continue;
    const isDrift = channel.attribution === 'UPSTREAM_DRIFT';
    const isUnknown = channel.attribution === 'UNKNOWN';
    risks.push({
      severity: isDrift ? 'MEDIUM' : isUnknown ? 'MEDIUM' : 'HIGH',
      channel: channel.channel,
      attribution: channel.attribution,
      description: isDrift
        ? `${channel.label ?? channel.channel} 验收失败，归因「上游契约漂移」——上游变了，非插件 bug`
        : isUnknown
          ? `${channel.label ?? channel.channel} 验收失败，但**无法归因**（探针未给出可识别的失败 check，可能被外力打断）`
          : `${channel.label ?? channel.channel} 验收失败，归因「插件回归」——需修插件`,
      // 归因理由链（可审计：判据依据哪些信号，而不是让人猜）
      reasons: channel.attributionReasons ?? [],
      mitigation: isDrift
        ? '按 registry/contract-snapshots 的漂移项更新兼容层与钉版，再重跑验收'
        : isUnknown
          ? '看原始 errors 与探针退出实况（probeExit），人工判定后再跑；禁止改验收标准来「过」'
          : '定位失败 check（见 checks[].name）并修复插件；禁止改验收标准来「过」',
      hostFatal: channel.hostFatal ?? [],
      errors: channel.errors ?? [],
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    plugin: report.plugin,
    verdict: summary.verdict ?? 'UNKNOWN',
    channels: channels.map((channel) => ({
      channel: channel.channel,
      label: channel.label,
      line: channel.line,
      status: channel.ok ? 'pass' : 'fail',
      lamp: channel.ok ? LAMP.pass : LAMP.fail,
      attribution: channel.attribution,
      flavor: channel.profile?.flavor ?? null,
      checksPassed: (channel.checks ?? []).filter((c) => c.status === 'pass').length,
      checksSkipped: (channel.checks ?? []).filter((c) => c.status === 'skip').length,
      checksTotal: (channel.checks ?? []).length,
      attributionReasons: channel.attributionReasons ?? [],
      durationMs: channel.durationMs,
      // 结果通道形态（批 1.5 / 🔴-R2）：'fd3' | 'stdout-degraded'；降级 ⇒ 结论不可信。
      resultChannel: channel.resultChannel ?? null,
      resultChannelDegraded: channel.resultChannelDegraded === true,
      // 🔴-R3：通道**被重定向**（宿主侧观测结论）——与降级分开可见，两者归因不同。
      resultChannelRedirected: channel.resultChannel === RESULT_CHANNEL_FD3_REDIRECTED,
      // 「报告**自称**降级」这一成因（🔴-R3 §三）：与「真环境限制」相反 ⇒ 报告层分开说。
      resultChannelDegradeClaimed: channel.resultChannelDegradeClaimed === true,
      failedChecks: (channel.checks ?? []).filter((c) => c.status === 'fail').map((c) => ({ name: c.name, detail: c.detail })),
      // nonce 带外通道形态（stdin / 其它）——R26 的口径可见性（排障时看得到「nonce 走哪条通道」）
      probeNonceChannel: channel.probeNonceChannel ?? null,
      // 宿主/环境侧致命信号（**结构化**；归因判据只读它，errors 仅作日志——见 docs/RISKS.md R7/R13）
      hostFatal: channel.hostFatal ?? [],
      errors: channel.errors ?? [],
    })),
    summary: {
      total: summary.total ?? 0,
      passed: summary.passed ?? 0,
      failed: summary.failed ?? 0,
      upstreamDrift: summary.upstreamDrift ?? [],
      pluginRegression: summary.pluginRegression ?? [],
      unknown: summary.unknown ?? [],
    },
    risks,
    decisions: [
      { item: '双通道验收口径（stable 必过 / dev 必跑且归因）', state: '已定' },
      { item: 'legacy 历史线是否长期保留', state: '需人拍板', note: '官方已不再演进 0.1.1 线，保留仅作回归守门' },
      { item: 'stable 通道事实基线取 next(0.1.5-rc.2) 而非 latest(0.0.1-rc.1 残留)', state: '需人拍板' },
    ],
  };
}

/**
 * 结构化二级信息 → Markdown（人类俯瞰）。
 *
 * @param {object} secondary buildSecondary 的产物
 * @returns {string} Markdown
 */
export function toMarkdown(secondary) {
  const lines = [];
  lines.push('📊 **DSH 适配中台 · 状态快照**');
  lines.push('');
  lines.push(`- 结论：**${secondary.verdict}**（通过 ${secondary.summary.passed}/${secondary.summary.total}）`);
  lines.push(`- 被测插件：\`${secondary.plugin}\``);
  lines.push(`- 生成时间：${secondary.generatedAt}`);
  lines.push('');
  lines.push('▶ **通道状态**');
  lines.push('');
  lines.push('| 通道 | 版本线 | 状态 | 归因 | 版本线探测 | 检查项 | 耗时 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const channel of secondary.channels) {
    const skipped = channel.checksSkipped ? `（跳过 ${channel.checksSkipped}）` : '';
    const degraded = channel.resultChannelDegraded
      ? `（⚠️ 通道降级：${channel.resultChannel}）`
      : channel.resultChannel === RESULT_CHANNEL_FD3_REDIRECTED
        ? '（⚠️ 结果通道**被重定向**：fd3-redirected）'
        : '';
    lines.push(
      `| ${channel.lamp} ${channel.label ?? channel.channel} | ${channel.line} | ${channel.status} | ${channel.attribution} | ${channel.flavor ?? '-'} | ${channel.checksPassed}/${channel.checksTotal}${skipped} | ${channel.durationMs}ms${degraded} |`,
    );
  }
  lines.push('');

  if (secondary.channels.some((c) => c.failedChecks.length > 0)) {
    lines.push('▶ **失败检查项**');
    lines.push('');
    for (const channel of secondary.channels) {
      if (channel.failedChecks.length === 0) continue;
      lines.push(`- \`${channel.channel}\``);
      for (const check of channel.failedChecks) lines.push(`  - ❌ \`${check.name}\`：${check.detail}`);
    }
    lines.push('');
  }

  lines.push('▶ **风险清单**');
  lines.push('');
  if (secondary.risks.length === 0) lines.push('- 无未处置风险');
  for (const risk of secondary.risks) {
    lines.push(`- [${risk.severity}] ${risk.description}`);
    for (const reason of risk.reasons ?? []) lines.push(`  - 判据：${reason}`);
    lines.push(`  - 规避：${risk.mitigation}`);
  }
  lines.push('');

  lines.push('▶ **决策摘要**');
  lines.push('');
  for (const decision of secondary.decisions) {
    lines.push(`- ${decision.state}：${decision.item}${decision.note ? `（${decision.note}）` : ''}`);
  }
  lines.push('');
  lines.push('▶ **索引**');
  lines.push('');
  lines.push('- 通道钉版表：`registry/channels.json`');
  lines.push('- 契约指纹基线：`registry/contract-snapshots/latest.json`');
  lines.push('- 验收执行器：`src/verify/runner.mjs`');
  lines.push('- 隔离宿主装配：`src/harness/host.mjs`');
  lines.push('- 契约兼容层：`src/compat/`');
  lines.push('- 设计文档：`docs/ARCHITECTURE.md`');
  return `${lines.join('\n')}\n`;
}
