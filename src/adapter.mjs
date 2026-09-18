/**
 * 插件侧一站式适配器：**插件作者唯一需要 import 的入口**。
 *
 * 设计目标（对应需求原话「重复的部分形成一个功能」）：
 * 插件作者只写业务工具定义，**不写**任何版本探测 / schema 压平 / 取消语义 /
 * 保留名规避代码——这些全部收拢到中台，上游一变，改中台一处即可。
 *
 * @module dsh-adapt-hub/adapter
 */

import { assertNotReserved, registerTools } from './compat/tool.mjs';
import { detectHostFlavor } from './detect/flavor.mjs';

/**
 * 创建一个宿主适配器。
 *
 * @param {{ tools: object, effect?: Function }} ctx 宿主上下文（最小面：`tools`）
 * @param {{ prefix?: string, onIssues?: (issues: string[]) => void, onProfile?: (profile: object) => void }} [options] 选项
 * @returns {object} 适配器
 */
export function createAdapter(ctx, options = {}) {
  const profile = detectHostFlavor(ctx?.tools);
  if (typeof options.onProfile === 'function') options.onProfile(profile.toJSON());

  /** @type {Function[]} */
  const disposers = [];
  /** @type {string[]} */
  const registered = [];
  /** @type {string[]} */
  const issues = [];

  return {
    /** 探测到的宿主画像。 */
    profile,

    /**
     * 注册工具定义（可多次调用；`disposeAll()` 可整体卸载）。
     *
     * @param {object[]} definitions 作者侧工具定义
     * @returns {{registered:string[], disposers:Function[], issues:string[], reservedRejected:string[]}}
     */
    register(definitions) {
      const result = registerTools(ctx, definitions, { prefix: options.prefix, profile });
      disposers.push(...result.disposers);
      registered.push(...result.registered);
      issues.push(...result.issues);
      if (result.issues.length > 0 && typeof options.onIssues === 'function') options.onIssues(result.issues);
      return result;
    },

    /**
     * 保留名护栏：命名前自检，避免炸在宿主内部。
     *
     * @param {string} name 工具名
     * @returns {string} 原样返回
     */
    assertNotReserved,

    /** 卸载全部已注册工具。 */
    disposeAll() {
      for (const disposer of disposers.splice(0)) disposer();
      registered.length = 0;
    },

    /** 适配状态（不注册为模型可见工具，避免污染工具目录）。 */
    toJSON() {
      return { profile: profile.toJSON(), registered: [...registered], issues: [...issues] };
    },
  };
}
