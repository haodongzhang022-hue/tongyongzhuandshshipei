/**
 * 负例插件：**插件把探针挂住**（评审 §二 枚举 ①②③ 之外的**第 4 个进程边界出口**）。
 *
 * `apply()` 返回一个**永不 resolve** 的 Promise，并持有活动句柄（`setInterval`）→
 * 事件循环不空、进程不会自然退出。两条实测事实使它成为真活口：
 * 1. **SIGTERM 默认终止不触发 `process.on('exit')`** → 只接 `exit` 钩子接不住它；
 * 2. 宿主 `execFileSync` 的 timeout 路径用 SIGTERM 杀进程，并**丢弃**被杀后写出的 stdout
 *    → 即便探针装了 SIGTERM 钩子，输出也拿不到（实测）。
 *
 * 历史行为：探针无归属地死掉 → 装配器只能记「探针未输出结构化结果」→ `hostFatal[]` 非空 →
 * 判 `UPSTREAM_DRIFT`/AMBER（插件把探针挂住却甩给上游）。
 *
 * 期望行为（本 PR 收口后）：
 * - 探针**自持看门狗**（阈值 = 宿主 timeout 的 80%，早于宿主 kill）在仍活着时写出结果；
 * - 归因 `PLUGIN_REGRESSION`、`verdict = RED`；
 * - `hostFatal[]` **必须为空**；`probeCompleted=false`；`escapedBy = timeout`；
 * - 失败项为插件侧 check `plugin.early_exit`。
 *
 * 注意：本夹具**不进 CI 闸门**（会吃满 timeout 时长，纯浪费额度）；由
 * `tests/test_e2e_regression.mjs` 用**短 timeout** 直接调 `runHostProbe()` 覆盖。
 */
export const inject = ['tools'];
export const expectedTools = ['demo_echo'];

export function definitions() {
  return [];
}

export function apply(ctx) {
  // 持有活动句柄：进程不会因事件循环空而自然退出。
  setInterval(() => {}, 1000);
  // 永不 resolve：探针 `await plugin.apply(...)` 永远等下去 → 只能靠看门狗 / 宿主 timeout 收尾。
  return new Promise(() => {});
}
