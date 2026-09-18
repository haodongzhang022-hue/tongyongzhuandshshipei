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

/**
 * 探针**相位信标**的 stdout 前缀（`__DSH_PROBE_PHASE__<phase>`，独占一行）。
 *
 * 为什么需要：探针被**不可捕获**终止（`SIGKILL` / OOM / 原生 `abort`）时来不及写结构化结果，
 * 装配器只看到「探针未输出结构化结果」。信标把「终止发生在哪一段」变成**证据**：
 * 有信标 ⇒ 插件代码正在运行（落插件侧 check，与「未知相位保守判插件侧」同一取向）；
 * 无信标 ⇒ 宿主装配段（`hostFatal[]`）。
 *
 * ⚠️ 命名纪律：前缀第 13 个字符是 `P`，而结构化结果标记 `__DSH_PROBE__` 要求第 13 个字符是 `_`
 * ⇒ `line.startsWith('__DSH_PROBE__')` **不会**误命中信标行（装配器解析报告因此不受影响）。
 * 该性质由 `tests/test_attribution.mjs` [9.9] 断言（改前缀即红）。
 */
export const PROBE_PHASE_BEACON_PREFIX = '__DSH_PROBE_PHASE__';

/**
 * 探针**结构化结果标记**（人读/日志用；判据实际走 {@link probeResultPrefix} 带 nonce 的形式）。
 *
 * ⚠️ 纪律（🆕 侧信道 / 信任边界）：本字面量**不再**是「谁是探针」的唯一凭据——
 * 插件与探针**共用同一个 stdout**，插件只要 `process.stdout.write('__DSH_PROBE__{...}')`
 * 就能伪造一张绿卡（或反过来把责任甩给上游）。故真正的判据是**带 nonce 的前缀**
 * （{@link probeResultPrefix}）：宿主每次运行生成**随机** nonce，只认带该 nonce 的行。
 *
 * 为什么「随机」而不是固定名：固定名（如 `__DSH_PROBE__`）等于没设防——插件照抄即可。
 * nonce 经**带外通道（stdin）**下发（见 {@link PROBE_NONCE_STDIN_CHANNEL}），
 * **不经 argv / env**（实测：env 通道可被 `/proc/self/environ` 反读、argv 通道出现在 `ps` 里，
 * 两者都让插件伪造出**被采信**的结果行）⇒ 这两条读取面都不成立。
 */
export const PROBE_RESULT_MARKER = '__DSH_PROBE__';

/**
 * 宿主 → 探针传递 nonce 的**带外通道：stdin**（本实现的通道形态）。
 *
 * 协议（侧信道收口）：
 * 1. 宿主生成一个随机 nonce `VALUE`（`randomBytes(16).toString('hex')`）；
 * 2. 宿主把 `VALUE + '\n'` 作为子进程的 **stdin** 输入（`stdio[0] = 'pipe'` + `input`）；
 * 3. 探针启动时 `readFileSync(0, 'utf8')` 读它，**读完立刻 `process.stdin.destroy()`**；
 * 4. 探针输出 `__DSH_PROBE__<VALUE>:{json}`；宿主只认带 `VALUE` 的那一行。
 *
 * ## 为什么走 stdin 而不是 argv / env（实测依据，不是偏好）
 * 本仓曾并行落地过一条 **env 通道**（随机环境变量名经 argv 传、值经 env 传，探针读到后
 * `delete process.env[NAME]`）。**实测该通道可被同进程插件绕过**：`delete` 只改 Node 的
 * 环境视图，**不**改内核里的进程环境块 —— 插件仍可从 **`/proc/self/environ`** 读回 nonce，
 * 进而伪造出**会被采信**的结果行（本仓实测：该形态拿到 `GREEN / PASS / 17 项`）。
 * 同理 argv 通道会出现在 `ps` / `/proc/self/cmdline` 里。
 * stdin 的字节流**不在**进程环境块、也不在 argv 里，故这两条读取面都不成立。
 *
 * ⚠️ 残留边界（不越权承诺，见 `docs/RISKS.md` R26）：stdin 挡的是「从环境块 / argv 反读」；
 * 探针与插件**同进程、同 uid** 这一结构性事实下，插件仍可篡改**其它**全局
 * （猴子补丁 `JSON.stringify` / 直接读探针内存）。彻底隔离需**进程级**方案
 * （独立 fd 通道 / 独立进程签名 / `vm` 隔离 `apply()`）——见 `docs/REDO-PROPOSAL.md`。
 */
export const PROBE_NONCE_STDIN_CHANNEL = 'stdin';

/**
 * 结果通道的**形态取值**（唯一事实源；探针与装配器共用，防两侧字符串漂移）。
 *
 * 为什么需要（批 1.5，评审 🔴-R2「降级是静默的」）：
 * - {@link RESULT_CHANNEL_FD3}：结构化结果走独立 fd3（正常形态，stdout 出现结果行 = 篡改证据）；
 * - {@link RESULT_CHANNEL_STDOUT_DEGRADED}：fd3 不可用 ⇒ **降级**到 stdout。降级后
 *   「stdout 上出现结果行」**不再**构成篡改证据（装配器在通道为空时回落到 stdout），
 *   故**降级运行不得判 PASS**——报告与二级信息里必须能看见 `resultChannel`。
 *
 * 历史缺陷：`writeResult()` 的返回值被调用点**丢弃**、`out` 里没有任何通道字段 ⇒
 * 报告里看不到这次走的是哪条通道，降级等于**静默把防线关掉**（实测：无 fd3 的离线台上
 * nonce 伪造 + `SIGKILL` ⇒ `ok=true / runCompleted=true / hostFatal=0`，**放行**）。
 */
export const RESULT_CHANNEL_FD3 = 'fd3';

/** 降级形态：fd3 不可用，结果走 stdout（见 {@link RESULT_CHANNEL_FD3}）。 */
export const RESULT_CHANNEL_STDOUT_DEGRADED = 'stdout-degraded';

/**
 * **被重定向**形态（🔴-R3）：宿主侧观测到的「探针的结果通道被插件换掉」。
 *
 * ⚠️ 与 {@link RESULT_CHANNEL_FD3} 的关键区别：`fd3` 是**探针自报**的（它写 fd3 成功），
 * 本值是**装配器按宿主侧观测**得出的结论（宿主给的 pipe 为空 + stdout 出现匹配 nonce 的结果行）
 * ——探针对自己被重定向一无所知，故不得把它当作探针自报值使用。
 *
 * 用途：报告与二级信息里**显式可见**（排障时一眼看出「不是环境降级，是通道被换掉了」）。
 */
export const RESULT_CHANNEL_FD3_REDIRECTED = 'fd3-redirected';

/**
 * 生成一次运行的随机 nonce。
 *
 * @param {() => Buffer} randomBytes `node:crypto` 的 `randomBytes`（注入以便离线单测）
 * @returns {{value: string}} nonce 值（十六进制）
 */
export function createProbeNonce(randomBytes) {
  return { value: randomBytes(16).toString('hex') };
}

/**
 * 探针结构化结果的**带 nonce 前缀**（宿主只认它）。
 *
 * @param {string} nonce nonce 值
 * @returns {string} `__DSH_PROBE__<nonce>:` 前缀
 */
export function probeResultPrefix(nonce) {
  return `${PROBE_RESULT_MARKER}${nonce}:`;
}

/**
 * 宿主/环境侧致命信号的**日志前缀**（探针与装配器拼人类可读 `errors[]` 时使用）。
 *
 * ⚠️ 纪律（评审 🔴-C）：此前缀**只许用于人读日志，绝不可作为归因判据的文本扫描目标**。
 * 判据只读结构化字段 {@link HOST_FATAL_FIELD}——否则插件侧错误文本或文件路径里恰好出现
 * `fatal(host)` 字面量，插件 bug 又会被翻案成「上游漂移」（与原 🔴-B 同族）。
 */
export const HOST_FATAL_PREFIX = 'fatal(host)';

/**
 * 宿主/环境侧致命信号的**结构化字段名**（探针 → 装配器 → 执行器 三段同名传递）。
 *
 * 归因判据 1 只读这个字段：`(probe.hostFatal ?? []).length > 0` → `UPSTREAM_DRIFT`。
 *
 * 不变量（**收窄后的准确口径**，🔴 必修-2 口径裁决）：插件侧错误**不得**进该字段——
 * 探针**可捕获**的全部插件侧逃逸形态（同步异常 / 异步异常 / 进程 `exit` / `run()` 被拖住）
 * 都落插件侧 check。唯一的例外是**不可捕获**的进程级终止（`SIGKILL` / OOM / 原生 `abort` /
 * 探针 stdout 被破坏）：那时探针来不及写出结构化结果，装配器按**相位信标**归因——
 * 有信标（插件代码运行期间）→ 插件侧 check `plugin.abnormal_termination`；无信标（宿主装配段）
 * → 落 `hostFatal[]` → `UPSTREAM_DRIFT`/AMBER（**不放行**，人须确认）。
 * 该边界**显式声明**在 `docs/RISKS.md` R21 与 `docs/ADAPTER_GUIDE.md`，不是漏修。
 *
 * ⚠️ **第二类例外（v0.1.9b 收窄，评审复评 H1，既存活口）**：上句的前提是「探针的进程内防线**有效**」。
 * 插件可**单方面关闭**该防线——`process.setUncaughtExceptionCaptureCallback()` 会**停用**
 * `uncaughtException` 监听器（Node 语义），`removeAllListeners('uncaughtException')` 可直接撤销。
 * 实测：装了 captureCallback 的插件在 `apply()` 后抛错 → 探针防线静音 → `run()` 仍正常收尾 →
 * 整轮 **GREEN / PASS / 17 项**（**放行级假绿**，比 AMBER 更危险）。故：
 * **不得**把本不变量写成「永远 / 永不」这类**绝对口径**，也不得据此对外宣称「插件侧错误永不进该字段」。
 * 准确口径 =「**在探针进程内防线未被插件干预的前提下**，插件侧错误不进该字段」。
 * 见 `docs/RISKS.md` R22（放行级假绿）/ R23（防线可被插件撤销或静音）；v0.1.9 修法 A。
 */
export const HOST_FATAL_FIELD = 'hostFatal';

/**
 * 探针执行**相位**（🔴-D：探针兜底写入端的归属判据）。
 *
 * 探针分两段跑，两段的「异常归属」完全不同：
 * - `host-assembly`：宿主包 import / Context 装配 / 契约指纹采集 —— 失败是**宿主/环境侧**；
 * - `plugin-integration`：插件 import / apply / definitions / dispatch / 生命周期 —— 失败是**插件侧**。
 *
 * 历史缺陷（评审三轮 🔴-D）：顶层 catch 不看相位，一律 `pushHostFatal()`，
 * 于是「读插件侧数据时抛出的插件 bug」（未初始化字段 / 抛错 getter）被写进判据字段
 * `hostFatal[]` → 判 `UPSTREAM_DRIFT`/AMBER，把插件 bug 甩给上游，
 * 并盖掉同一次运行里已失败的插件侧 check。
 *
 * @type {{HOST_ASSEMBLY: string, PLUGIN_INTEGRATION: string}}
 */
export const PROBE_PHASE = {
  HOST_ASSEMBLY: 'host-assembly',
  PLUGIN_INTEGRATION: 'plugin-integration',
};

/**
 * 「探针自身未预期异常」在**插件集成相位**的落点 check 名（已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 为什么需要它：插件集成相位里有些异常发生在 `run()` 的 try/catch 之外（读插件侧数据：
 * `tools.schemas()` / `definitions.map()`），逃到顶层 catch 时**没有**对应 check，
 * 若照旧落 `hostFatal[]` 就等于「插件 bug 报成上游漂移」。故给它们一个插件侧 check 名。
 */
export const PLUGIN_PROBE_EXCEPTION_CHECK = 'plugin.unexpected_exception';

/**
 * 探针异常归属路由（**唯一事实源**，探针顶层 catch 与离线回归共用）。
 *
 * 返回值**只给归属与落点**：宿主侧 → `hostFatal[]`（唯一落点由 {@link pushHostFatal} 决定，
 * 此处不再回传字段名——回传会让人以为存在「第二处落点」，评审 🟢 已点名）；插件侧 → check 名。
 *
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @returns {{side: 'host'} | {side: 'plugin', check: string}} 归属：宿主侧写 hostFatal[] / 插件侧写 check
 *
 * 保守取向：**未知相位按插件侧处理**（绝不写 `hostFatal[]`）。
 * 宁可让人多看一眼插件侧失败，也不让一个未确认的信号去开「上游漂移」这道门
 * （那道门直接决定放行/改中台，代价更大）。
 */
export function probeFailureRoute(phase) {
  return phase === PROBE_PHASE.HOST_ASSEMBLY
    ? { side: 'host' }
    : { side: 'plugin', check: PLUGIN_PROBE_EXCEPTION_CHECK };
}

/**
 * 探针「异步异常」的插件侧落点 check 名（已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 与 {@link PLUGIN_PROBE_EXCEPTION_CHECK} 的分工：那个收的是**同步**异常
 * （`run()` 调用栈上，逃到顶层 `catch`）；本名收的是**进程级异步异常**
 * （`uncaughtException` / `unhandledRejection`）——插件在 `apply()` 里排的后台任务
 * / 事件回调 / 预取 promise 抛错，**根本不在** `run()` 的调用栈上，
 * 顶层 `catch` 永远接不到（评审 🔴-D 同族活口）。
 *
 * 为什么要给独立名字而不是复用：两条路径的排障动作不同（一个查插件数据读取、
 * 一个查插件后台任务），报告里必须能一眼分清。
 */
export const PLUGIN_ASYNC_EXCEPTION_CHECK = 'plugin.async_uncaught_exception';

/**
 * 探针「**进程 exit 出口**」的插件侧落点 check 名（已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 与 {@link PLUGIN_ASYNC_EXCEPTION_CHECK} 的分工：那个收的是「进程还活着、只是异常没被接住」；
 * 本名收的是「进程在验收完成前**终止**」——插件调 `process.exit(code)`（或自杀式信号），
 * 探针的 `run()` 再也回不来。历史缺陷（评审 🔴 必修-2）：该出口**既未闭合也未声明**，
 * 装配器只看到「探针未输出结构化结果」→ 无条件 `pushHostFatal()` → 插件 bug 判
 * `UPSTREAM_DRIFT`/AMBER，且 `checks` 归零（整份报告消失）。
 *
 * 为什么给独立名字而不是复用异步那条：两条路径的**排障动作不同**（一个查后台任务抛错、
 * 一个查插件是否调了 `process.exit` / 自杀信号），报告里必须能一眼分清。
 */
export const PLUGIN_EARLY_EXIT_CHECK = 'plugin.early_exit';

/**
 * 探针「**`run()` 被拖住**」的插件侧落点 check 名（已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 第三种逃逸形态：没有异常、也没有 `process.exit`，只是 `run()` **永不返回**
 * （插件挂住事件循环，或 `apply()` 返回一个永不 resolve 的 Promise）。旧探针只给
 * 「已记录异步异常」的情形装看门狗（且 `unref()` 掉）→ 本形态下看门狗**根本没装**，
 * 进程干等到外层超时（600s）→ 装配器看到「探针未输出结构化结果」→ 同一个误判。
 *
 * 出口：**无条件**安装的看门狗（探针的 `RUN_WATCHDOG_MS`）到点强制收尾，落本 check。
 */
export const PLUGIN_RUN_INCOMPLETE_CHECK = 'plugin.run_incomplete';

/**
 * 探针被**不可捕获终止**（`SIGKILL` / OOM / 原生 `abort`）时的插件侧落点 check 名。
 *
 * 与前四条出口不同：这条**不由探针自己**记录（它来不及），而由装配器 `host.mjs` 在
 * 「探针未输出结构化结果」时**按相位信标**（{@link PROBE_PHASE_BEACON_PREFIX}）归因：
 * 有信标 ⇒ 终止发生在插件代码运行期间 → 落本 check（插件侧，`hostFatal[]` 保持为空）；
 * 无信标 ⇒ 终止在宿主装配段 → `hostFatal[]`（真上游信号，不丢）。
 *
 * 为什么不能只「声明边界」了事：装配器原先是**无条件** `pushHostFatal()`——插件把自己
 * `kill -9` 也会被判成「上游变了，不是你的问题」。声明边界解决「静默」，但不解决「甩锅」；
 * 信标让归因有证据（评审 🔴 必修-2 给的「二选一」中的方案②）。
 */
export const PLUGIN_ABNORMAL_TERMINATION_CHECK = 'plugin.abnormal_termination';

/**
 * 「探针的**进程内防线**被插件单方面撤销 / 静音」在插件集成相位的落点 check 名
 * （已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 为什么必须有它（评审复评 H1，放行级假绿）：探针出口②（异步异常）靠
 * `process.on('uncaughtException' / 'unhandledRejection')` 两个监听器兜底。但 Node 的
 * `process.setUncaughtExceptionCaptureCallback(cb)` 一旦被调用，**监听器不再被调用**
 * （官方语义：capture callback 存在时监听器被停用）。插件（或其依赖）在 `apply()` 里设一次
 * 回调，探针的兜底就被**静音**：插件后台抛错完全不可见、`run()` 仍正常收尾、完成位仍为真
 * ⇒ 整轮判 **GREEN / PASS（放行）**。
 *
 * 真实形态很常见：插件引入 Sentry / APM / 错误上报 / 日志库，这些库初始化时会抢占该独占 API
 * ——**不是**刻意攻击，是普通工程实践。这比「判 AMBER」危险得多（AMBER 至少不放行）。
 *
 * 同理，插件 `process.removeAllListeners('uncaughtException')` 也能把探针的监听器摘掉
 * （见 `tests/fixtures/plugin-detach-handlers-plugin.mjs`）。故收尾时**自检**：
 * capture callback 为空 **且** 两个监听器仍在 → 否则判插件侧 check（本名）。
 *
 * ⚠️ 口径（与 {@link HOST_FATAL_FIELD} 的收窄一致）：本项**只能在探针还活着时**判。
 * 插件若让探针**整个进程**消失（`SIGKILL` / `exit` / 挂住），本项同样来不及判——那时
 * 由出口③④ 或装配器按相位信标归因。
 */
export const PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK = 'plugin.process_defense_tampered';

/**
 * 「探针的**结果通道**被插件篡改（协议注入）」在插件集成相位的落点 check 名
 * （已登记进 {@link PLUGIN_SIDE_CHECKS}）。
 *
 * 为什么必须有它（评审复评 R26，**放行级假绿**）：装配器原先用
 * `stdout.split('\n').find((l) => l.startsWith('__DSH_PROBE__'))` 取**第一条**结果行。
 * 插件在 `apply()` 里 `writeSync(1, '__DSH_PROBE__{...}')` 写一条**伪造**结果（17 项全 pass /
 * `hostFatal[]` 清空 / 退出码压回 0），就能抢到首位——探针自己随后输出的**真报告被忽略**。
 * 实测三种形态（天真伪造 / 伪造+真缺陷 / 伪造合法报告）在真宿主下均判
 * **GREEN / PASS / 17 项**（放行），比 AMBER 危险得多。
 *
 * 归因的**结构不变量**：正常探针在一次运行里**恒为 1 条**结果行（实测 8 份夹具全为 1）。
 * ⇒ **≥2 条即铁证是篡改**（无需知道谁写的）；配合结果通道隔离（`spawnSync` 的 fd3，
 * 见 `host.mjs`）后，**stdout 里出现的任何结果行都是篡改证据**（第二条独立证据链）。
 *
 * ## 🔴-R3′（评审复评，收窄后的活口）：**宿主侧通道观测**交叉校验
 * 上一条（结构不变量 / 通道隔离）依赖「fd3 **有没有内容**」⇒ 插件 `closeSync(3)` 后
 * `openSync(<file>)` 把 fd3 换成普通文件时：宿主侧管道只见 EOF ⇒ `isolated=false` ⇒
 * 装配器**回退信任 stdout**；探针收尾把**真报告**写进那个文件 ⇒ 插件在 `'exit'` 钩子里读回它
 * （**连 nonce 前缀一起拿到**，不必反读 env / argv）⇒ 用该前缀把绿卡写进 stdout，并压
 * `process.exitCode = 0` 压掉退出码交叉 ⇒ 旧实现下 **GREEN 放行**（真缺陷被绿卡掩盖）。
 *
 * 收口判据：报告**自称**走 fd3（`resultChannel === 'fd3'`）而**宿主侧该通道无任何内容**、
 * 且 stdout 反而出现**匹配 nonce** 的结果行 ⇒ 通道被重定向 ⇒ 判本项、**不采信任何一条**。
 * 这条腿**只依赖宿主进程看到的东西**（管道读端为空），不依赖探针自报、也不依赖退出码
 * ⇒ 插件从探针进程内压不掉；防线因此从「报告 + 退出码」两条信道升级为
 * 「报告 + 退出码 + **宿主侧通道观测**」三条。
 *
 * ⚠️ 口径（与 {@link HOST_FATAL_FIELD} 的收窄一致）：本项判的是**装配器可见的输出通道**；
 * 插件若同时让探针整个进程消失，则由出口③④ 或相位信标归因（见 R21）。
 * **残留边界**（不越权承诺）：把伪造行写进 **fd3 本身**（自称与宿主侧观测一致）仍不可区分
 * ⇒ 需批 2 的「独立 fd 且永不回退 stdout」（见 `docs/REDO-PROPOSAL.md`）。
 */
export const PLUGIN_PROTOCOL_INJECTION_CHECK = 'plugin.protocol_injection';

/**
 * 「探针 stdout 里出现**伪造的结构化结果**（无 nonce / nonce 不匹配）」在插件侧的落点 check 名。
 *
 * 为什么需要（🆕 侧信道 / 信任边界，见 `docs/RISKS.md` R26）：探针与插件**共用 stdout**，
 * 插件可以 `process.stdout.write('__DSH_PROBE__{...绿卡...}')` 自造一张绿卡；
 * 或写 `hostFatal:[...]` 把责任甩给上游。宿主按**带 nonce 的前缀**认报告后，
 * 「无 nonce 的 marker 行」就成了**伪造证据**——本 check 即该证据的落点（判插件侧、不放行）。
 *
 * 与 {@link PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK} 的分工：那个判「探针自己的兜底被静音」，
 * 本项判「有人冒用探针的输出协议」。两者都可能在同一轮出现（伪造 + 静音），各自独立记录。
 */
export const PLUGIN_PROBE_FORGED_RESULT_CHECK = 'plugin.probe_result_forged';

/**
 * 「探针**报告自称通过**，但探针进程**退出码非 0**」在插件侧的落点 check 名。
 *
 * ## 为什么必须有它（🔴 必修-4，与 {@link PLUGIN_PROBE_FORGED_RESULT_CHECK} **同族**）
 * 前一条（nonce）挡的是「冒用探针的输出协议」；但探针与插件**同进程**，插件还能改**序列化函数**
 * 本身（猴子补丁 `JSON.stringify`）——把失败项改成 pass、把 `errors` / `hostFatal` 清空、
 * 把 `ok` / `runCompleted` 置真。那时**报告**是伪造的，而 nonce 校验**照样通过**（前缀没变）。
 * 本仓实测（夹具 `plugin-stringify-tamper-plugin`，v0.2.2 tip）：子进程 `exit status=1`
 * （探针**自己**判了失败），但报告 `ok=true / 17 项全 pass` ⇒ **失败被吞、绿卡被采信**。
 *
 * ## 判据（**交叉校验**：两个独立产物互相矛盾即篡改）
 * 探针的**退出码**与**报告内容**由两条不同的路径产生：
 * - 退出码 = 探针内存里 `runCompleted && !syncThrew && !failureHandled && out.errors.length === 0`
 *   （`finish()` 计算，**不经序列化**）；
 * - 报告 = `STRINGIFY(out)` 写出的字节。
 * 正常运行时两者**必然一致**：`ok=true` ⇒ 无失败 ⇒ 退出码 0。故
 * 「`payload.ok === true` **且** 退出码非 0（或有终止信号）」= **内部矛盾** = 报告被篡改
 * （或退出码被篡改）⇒ 本轮不可信、不放行。
 *
 * ## 为什么是最低成本且正好兜住本形态
 * 它**不需要**任何新的带外凭据、不依赖探针进程内防线（防线本身也在同进程内），
 * 只利用「退出码是探针自己算的、序列化是插件可写的」这一**不对称**。
 *
 * ⚠️ 边界（与 {@link HOST_FATAL_FIELD} 的收窄一致，不越权承诺）：能同时篡改**退出码**与报告的
 * 插件仍可绕过本项（`process.exitCode = 0` 或替换 `process.exit`）——那属**进程级**对抗，
 * 根治需进程隔离（见 `docs/REDO-PROPOSAL.md` 批 2）。本项与「加载期捕获引用」是**两道并集**，
 * 不是单一不变量。
 */
export const PLUGIN_EXIT_CODE_MISMATCH_CHECK = 'plugin.exit_code_mismatch';

/**
 * 进程级异常归属路由（**唯一事实源**，探针的进程级兜底与离线回归共用）。
 *
 * 语义与 {@link probeFailureRoute} **完全一致**（按相位、未知相位保守判插件侧），
 * 唯一区别是落点 check 名不同（异步异常有独立名字，便于排障定位）。
 *
 * 为什么需要单独一层：`probeFailureRoute()` 的落点名描述的是「探针自身未预期异常」，
 * 而进程级异步异常的主体是**插件的后台任务**——两者混用会让报告撒谎
 * （人看到 `plugin.unexpected_exception` 会去查插件数据读取，实际要查后台任务）。
 *
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @returns {{side: 'host'|'plugin', check?: string}} 归属：宿主侧 → hostFatal[]；插件侧 → check
 */
export function probeAsyncFailureRoute(phase) {
  return probeProcessFailureRoute(phase, PLUGIN_ASYNC_EXCEPTION_CHECK);
}

/**
 * 「进程级 / 收尾级」逃逸形态的**通用**归属路由（唯一事实源，探针各出口与离线回归共用）。
 *
 * 语义与 {@link probeFailureRoute} 完全一致（按相位、未知相位保守判插件侧），
 * 唯一差别是**插件侧落点 check 名由调用方给出**——三条出口
 * （异步异常 `plugin.async_uncaught_exception` / 进程 exit `plugin.early_exit` /
 * `run()` 被拖住 `plugin.run_incomplete`）排障动作不同，报告里必须能一眼分清。
 *
 * 为什么收敛成一处：新增出口时最容易犯的错是「自己判相位、自己挑落点」——
 * 那样迟早有人把宿主装配相位的信号写成插件侧（或反之）。落点名字可换，**归属规则只有这一份**。
 *
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @param {string} check 插件侧落点 check 名（须已登记进 {@link PLUGIN_SIDE_CHECKS}）
 * @returns {{side: 'host'} | {side: 'plugin', check: string}} 归属
 */
export function probeProcessFailureRoute(phase, check) {
  return probeFailureRoute(phase).side === 'host' ? { side: 'host' } : { side: 'plugin', check };
}

/**
 * 记录「进程级异步异常」（`uncaughtException` / `unhandledRejection`）——**按相位**决定落点。
 *
 * 与 {@link recordProbeException} 同一纪律：`hostFatal[]` 是判据唯一事实字段，
 * 插件侧的异步异常**绝不**进该字段。未知相位保守判插件侧。
 *
 * 额外保证（🔴-D 同族活口的要害）：本函数**不抛异常**——它运行在
 * `uncaughtException` 处理器里，任何抛出都会让探针在写出 `__DSH_PROBE__` 之前再次崩掉，
 * 于是整份报告消失、`checks` 从 17 掉到 0（比「盖掉一条 check」更彻底）。
 * 故内部对 `target` 做全部归一，并吞掉自身异常（记一条日志行）。
 *
 * @param {{checks?: object[], errors?: string[], hostFatal?: string[]}} target 探针 `out`
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @param {string} detail 异常摘要（含 stack）——仅进人读日志 / 插件侧 check 的 detail
 * @returns {{side: 'host'|'plugin', line: string}} 归属与写入的日志行（供排障）
 */
export function recordProbeAsyncException(target, phase, detail) {
  return recordProcessLevelFailure(target, phase, detail, PLUGIN_ASYNC_EXCEPTION_CHECK, '插件后台任务未捕获异常（插件侧异步错误）');
}

/**
 * 记录「进程在验收完成前退出」（插件调 `process.exit()` / 自杀式信号）——**按相位**决定落点。
 *
 * 纪律与 {@link recordProbeAsyncException} 完全相同：不抛、全字段归一、插件侧绝不写 `hostFatal[]`。
 * 探针在 `process.on('exit')` 与信号处理器里调用它（那是崩溃路径，任何抛出都等于报告整份消失）。
 *
 * @param {{checks?: object[], errors?: string[], hostFatal?: string[]}} target 探针 `out`
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @param {string} detail 退出实况摘要（exit code / 信号名）
 * @returns {{side: 'host'|'plugin', line: string}} 归属与写入的日志行
 */
export function recordProbeEarlyExit(target, phase, detail) {
  return recordProcessLevelFailure(target, phase, detail, PLUGIN_EARLY_EXIT_CHECK, '进程在验收完成前退出（插件侧提前终止）');
}

/**
 * 记录「探针 `run()` 未在窗口内返回」（插件挂住事件循环 / `apply()` 返回永不 resolve 的 Promise）。
 *
 * 由探针的**无条件看门狗**调用（见 `RUN_WATCHDOG_MS`）；纪律同上（不抛、归一、绝不写 `hostFatal[]`）。
 *
 * @param {{checks?: object[], errors?: string[], hostFatal?: string[]}} target 探针 `out`
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @param {string} detail 超时实况摘要
 * @returns {{side: 'host'|'plugin', line: string}} 归属与写入的日志行
 */
export function recordProbeRunIncomplete(target, phase, detail) {
  return recordProcessLevelFailure(target, phase, detail, PLUGIN_RUN_INCOMPLETE_CHECK, '探针 run() 未在窗口内返回（插件侧挂住事件循环）');
}

/**
 * 「进程级 / 收尾级」异常写入端的**唯一实现**（三条出口共用）。
 *
 * 为什么收敛：`hostFatal[]` 是判据唯一事实字段，它的写入端必须只有一处可写错——
 * 三条出口各自实现一份，迟早有一条把插件侧信号写进 `hostFatal[]`（那正是 🔴-D 的失效机制）。
 *
 * 额外保证（崩溃路径纪律）：本函数**不抛异常**——它运行在 `uncaughtException` /
 * `process.on('exit')` / 看门狗回调里，任何抛出都会让探针在写出 `__DSH_PROBE__` 之前再次崩掉，
 * 于是整份报告消失、`checks` 从 17 掉到 0（比「盖掉一条 check」更彻底）。
 * 故内部对 `target` 做全部归一，并吞掉自身异常（记一条日志行）。
 *
 * @param {{checks?: object[], errors?: string[], hostFatal?: string[]}} target 探针 `out`
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @param {string} detail 异常 / 退出摘要（含 stack 或 exit code）
 * @param {string} check 插件侧落点 check 名（须已登记进 {@link PLUGIN_SIDE_CHECKS}）
 * @param {string} label 人读标签（进日志行，说明这条出口的性质）
 * @returns {{side: 'host'|'plugin', line: string}} 归属与写入的日志行（供排障）
 */
function recordProcessLevelFailure(target, phase, detail, check, label) {
  try {
    const route = probeProcessFailureRoute(phase, check);
    target.phase = phase;
    const text = String(detail).slice(0, 600);
    if (!Array.isArray(target.checks)) target.checks = [];
    if (!Array.isArray(target.errors)) target.errors = [];
    if (route.side === 'host') {
      return { side: 'host', line: pushHostFatal(target, `探针进程级异常：${text}`) };
    }
    target.checks.push({ name: route.check, status: 'fail', detail: text });
    const line = `${route.check}: ${label}（${phase} 相位，插件侧错误）：${text}`;
    target.errors.push(line);
    return { side: 'plugin', line };
  } catch (error) {
    // 兜底里的兜底：记录失败**不得**升级成第二次崩溃（否则报告整份消失）。
    try {
      if (!Array.isArray(target.errors)) target.errors = [];
      target.errors.push(`recordProcessLevelFailure 自身失败（已吞掉，不影响报告输出）：${String(error?.message ?? error)}`);
    } catch { /* 连 errors 都写不进去时，静默——绝不能在这里抛 */ }
    return { side: 'plugin', line: '' };
  }
}

/**
 * 记录「探针未预期异常」——**按相位**决定落点（🔴-D 的核心修复，探针与离线回归共用）。
 *
 * 收敛成一个函数的原因：`hostFatal[]` 是判据唯一事实字段，它的**写入端**必须只有一处可写错。
 * 此前顶层 catch 直接调 `pushHostFatal()`，而插件侧异常也会逃到那里 → 插件 bug 被写成宿主信号。
 *
 * @param {{checks: object[], errors: string[], hostFatal?: string[]}} target 探针 `out`
 * @param {string} phase 见 {@link PROBE_PHASE}
 * @param {string} detail 异常摘要（`brief()` 产物，含 stack）。仅进**人读日志**或**插件侧 check 的 detail**，
 *   **不得**进入 `hostFatal[]`（判据字段只收宿主/环境侧信号）
 * @returns {{side: 'host'|'plugin', line: string}} 归属与写入的日志行（供排障）
 */
export function recordProbeException(target, phase, detail) {
  const route = probeFailureRoute(phase);
  // 相位落进结构化结果：报告里看得见「异常发生在哪一段」，排障不必猜。
  target.phase = phase;
  if (route.side === 'host') {
    return { side: 'host', line: pushHostFatal(target, `探针未预期异常：${detail}`) };
  }
  // 插件集成相位：落**插件侧 check**（名字已登记进 PLUGIN_SIDE_CHECKS，否则归因退化成 UNKNOWN）。
  // 绝不写 hostFatal[]——那是「上游漂移」这道门的唯一钥匙。
  const text = String(detail).slice(0, 600);
  target.checks.push({ name: route.check, status: 'fail', detail: text });
  const line = `${route.check}: 探针未预期异常（${phase} 相位，插件侧数据读取出错）：${text}`;
  if (!Array.isArray(target.errors)) target.errors = [];
  target.errors.push(line);
  return { side: 'plugin', line };
}

/**
 * 记录一条宿主/环境侧致命信号：**同时**写结构化字段（判据唯一依据）与人读日志行。
 *
 * 存在的意义：把「谁写信号、谁读信号」收敛成一个函数，避免有人再往
 * `errors` 里塞关键词、再由判据去扫文本（那正是 🔴-B / 🔴-C 的失效机制）。
 *
 * @param {{errors: string[], hostFatal?: string[]}} target 探针 `out` 或装配器 `result`
 * @param {string} detail 宿主/环境侧失败原因（**不得**拼入插件侧 stack）
 * @returns {string} 写入 `errors` 的日志行
 */
export function pushHostFatal(target, detail) {
  const text = String(detail);
  if (!Array.isArray(target.hostFatal)) target.hostFatal = [];
  // 🟢：两个字段都归一——只给了 hostFatal 的调用方（或外部传入的畸形对象）不得在此抛 TypeError，
  // 否则「记录一条宿主侧信号」本身会炸成未归因异常（写入端最不该有的失败模式）。
  if (!Array.isArray(target.errors)) target.errors = [];
  target.hostFatal.push(text);
  const line = `${HOST_FATAL_PREFIX}: ${text}`;
  target.errors.push(line);
  return line;
}

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
  // 🔴-D：插件集成相位里逃到顶层 catch 的未预期异常（读插件侧数据时插件代码抛错）
  'plugin.unexpected_exception',
  // 🔴-D 同族活口：插件后台任务（apply 里排的微任务/定时器/promise）的未捕获异常——
  // 不在 run() 调用栈上，顶层 catch 接不到，由探针的进程级兜底按相位归到这里。
  'plugin.async_uncaught_exception',
  // 🔴 必修-2：进程 exit 出口——插件在验收完成前调 process.exit() / 自杀式信号。
  'plugin.early_exit',
  // 🔴 必修-3：run() 被拖住（插件挂住事件循环 / apply() 返回永不 resolve 的 Promise）——
  // 由探针的**无条件**看门狗兜住（旧实现只在记录过异步异常时才装，且 unref 掉了）。
  'plugin.run_incomplete',
  // 🔴 必修-2 边界：不可捕获终止（SIGKILL / OOM）由装配器按相位信标归因（有信标 → 本 check）。
  'plugin.abnormal_termination',
  // H1（复评）：插件抢占 `setUncaughtExceptionCaptureCallback` / 摘掉监听器 → 探针的
  // 进程级兜底被**静音** ⇒ 插件后台抛错不可见、完成位仍真 ⇒ **GREEN 放行**（比 AMBER 更危险）。
  // 由探针收尾自检（wrap API 记账 + 身份检查 + 行为级 canary，见 R28）判本项。
  'plugin.process_defense_tampered',
  // R26（复评）：插件向探针的结果通道**注入伪造结果**（抢首位 / 多 marker / 走错通道）⇒
  // 真报告被忽略 ⇒ 整轮假绿。由装配器 `interpretProbeStdout()` 判本项（结构不变量 + 通道隔离）。
  'plugin.protocol_injection',
  // 🆕 侧信道（信任边界）：探针 stdout 里出现无 nonce / nonce 不匹配的伪造结构化结果。
  // 由**装配器**在解释 stdout 时判定（探针自己看不到别人写了什么），落插件侧 check。
  // 与 `plugin.protocol_injection` 的分工：那条判「结果行条数/通道异常」（结构不变量），
  // 本条判「有人冒用探针的输出协议」（nonce 不匹配）——两条证据链互相独立。
  'plugin.probe_result_forged',
  // 🔴 必修-4（同族放行级假绿）：探针报告自称通过（ok=true）但进程**退出码非 0** ⇒ 内部矛盾
  // （退出码由探针内存算、不经序列化；报告字节可被插件的序列化函数替换）⇒ 判篡改、不放行。
  // 由**装配器**在解释报告时交叉校验（探针看不到自己的退出码，装配器才看得到）。
  'plugin.exit_code_mismatch',
];

/**
 * 探针的**条件触发检查项**：仅在异常路径出现，**不计入 17 项**（文档口径见
 * `docs/ADAPTER_GUIDE.md` / `docs/INDEX.md` 的「另有 N 项条件检查」，N 由本表长度决定，
 * 并由 `tests/test_exports.mjs` 断言「文档声明的 N == 本表长度」）。
 *
 * 为什么单独成表：`PROBE_CHECK_ORDER` 与「条件项」必须能互相推出，
 * 否则「17 项」的口径会随新增条件项悄悄变成 18 项而无人发现。
 *
 * **九项**条件检查，各占一项（**条数由本表长度决定**，文档里的「另有 N 项」由
 * `tests/test_exports.mjs` [2b'''] 反推，改一处漏一处即红）：
 * 同步异常（`plugin.unexpected_exception`）/ 异步异常（`plugin.async_uncaught_exception`）/
 * 进程 exit（`plugin.early_exit`）/ `run()` 被拖住（`plugin.run_incomplete`）/
 * 不可捕获终止（`plugin.abnormal_termination`，由装配器按相位信标归因）/
 * 进程内防线被插件干预（`plugin.process_defense_tampered`）/
 * 结果通道被插件注入伪造结果（`plugin.protocol_injection`，由装配器判）/
 * 结果通道出现伪造结构化结果（`plugin.probe_result_forged`，nonce 不匹配，由装配器判）/
 * 报告自称通过但探针**退出码非 0**（`plugin.exit_code_mismatch`，退出码交叉校验，由装配器判）。
 */
export const CONDITIONAL_PROBE_CHECKS = [
  PLUGIN_PROBE_EXCEPTION_CHECK,
  PLUGIN_ASYNC_EXCEPTION_CHECK,
  PLUGIN_EARLY_EXIT_CHECK,
  PLUGIN_RUN_INCOMPLETE_CHECK,
  PLUGIN_ABNORMAL_TERMINATION_CHECK,
  PLUGIN_PROCESS_DEFENSE_TAMPERED_CHECK,
  PLUGIN_PROTOCOL_INJECTION_CHECK,
  PLUGIN_PROBE_FORGED_RESULT_CHECK,
  PLUGIN_EXIT_CODE_MISMATCH_CHECK,
];

/**
 * 「前置失败时该标 `skip` 的插件侧检查项」= {@link PLUGIN_SIDE_CHECKS} **减去**条件项。
 *
 * 为什么必须减去：条件项（同步/异步异常、进程 exit、`run()` 被拖住、不可捕获终止、防线干预、协议注入）按口径
 * **仅在异常路径出现**（见 {@link CONDITIONAL_PROBE_CHECKS} 的文档说明）。若把它们也塞进
 * 「前置失败 → skipAll」的清单，那么每个普通的插件失败报告里都会多出若干条
 * `skip`（`plugin.early_exit` / `plugin.run_incomplete` / …）——报告噪声，且与
 * 「17 项 + N 条件项」的口径不符（人会以为探针真的验过这些出口）。
 *
 * 派生而非手写：新增条件项时只需改 {@link CONDITIONAL_PROBE_CHECKS}，本表自动跟随
 * （手写两处必然漂移，本仓已因此返工过多次）。
 */
export const PLUGIN_SKIP_ON_PRECONDITION = PLUGIN_SIDE_CHECKS.filter((name) => !CONDITIONAL_PROBE_CHECKS.includes(name));

/**
 * 探针 17 项检查的**规范输出顺序**（= `docs/INDEX.md` 的 `#` 序号列口径）。
 *
 * 用途：进程级兜底（`uncaughtException` / `unhandledRejection`）中断验收时，
 * 把「尚未跑到的检查」按**同一顺序**标 `skip`——报告里看得见「哪些没验」，
 * 且顺序与正常报告一致（人比对两次运行不必重排）。
 *
 * 与探针源码的关系：探针 `check('...')` 的调用顺序是**行为上的**事实源，
 * 本表是**声明上的**事实源；两者由 `tests/test_attribution.mjs` [9.8] 断言相等（不一致即红）。
 * 与三张 check 表的关系：本表 ∪ {@link CONDITIONAL_PROBE_CHECKS} == 三表并集（同由 [9.8] 断言）。
 *
 * @type {readonly string[]}
 */
export const PROBE_CHECK_ORDER = [
  'host.tools_ready',
  'detect.flavor_known',
  'contract.probe_disposed',
  'guard.reserved_name',
  'compat.schema_flatten',
  'plugin.loaded',
  'plugin.apply_ok',
  'registry.exact',
  'dispatch.execute_ok',
  'dispatch.render_projected',
  'dispatch.echo_payload',
  'dispatch.abort_semantics',
  'plugin.definitions_ok',
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
