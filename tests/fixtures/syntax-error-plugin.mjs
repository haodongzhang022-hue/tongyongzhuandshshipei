/**
 * 负例插件：**语法错误**（连 import 都进不去）。
 *
 * 期望归因：`PLUGIN_REGRESSION`（插件侧问题），且**不得**因探针错误串里出现路径/命令
 * 而误判成 `UPSTREAM_DRIFT`（评审 🔴-B 的失效面）。
 */
export function apply(ctx) {
  this is not valid javascript ((
}
