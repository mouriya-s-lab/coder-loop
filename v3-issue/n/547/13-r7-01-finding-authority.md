# R7-01 — Compile finding 权威与 doctor 消费边界

> 基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
> 范围：D1、P-D1-2；总账 `D-01,D-05,A-01,A-02,T-01,T-02`。本报告只建立事实和可支持的边界形状，不裁决 doctor 是否吸收 findings，不提出实现，不估算规模。

## A. 决策摘要（≤1 页）

### A1. 问题与结论

当前并不存在一条由 `CompileResult` 一路保持到所有消费面的 finding 生命周期。类型层的成功权威是同一对象中的 `model + warnings`，失败权威是非空、仅含 error 的 `diagnostics`；但 `loadPreset` 只返回 model，成功 warning 在此边界被丢弃，失败 diagnostics 被压成异常文本。CLI 是唯一直接消费完整 `CompileResult` 的生产入口；status、doctor、migration、chain-complete 和 daemon scheduler 均通过 `loadPreset`。

daemon 又建立了第二条 callback 投影：compile 尚未决定成功/失败时逐 finding 回调，daemon 在 cold load 完成或失败后才逐条写 observability event。该投影不是 `CompileResult` 的持久化：字段更细、可含最终 rejected 结果不携带的 warn、按 daemon path cache 的 cold caller/chain 归属，并且 event 持久化失败会被吞掉而 model 仍可返回。因而同一次 compile 的 model 与 findings **事实上可以且正在被拆开异步消费**，但没有原子性、同一性或完整性保证。

doctor 当前只消费 `buildCoderLoopStatusSnapshot`。它会重新从当前源 `loadPreset`，却无 callbacks，故 warning 不进入 snapshot；load 失败被 status 归为 `state.kind="missing-state"`、`state.errors[path="chain"]`，doctor 再统一渲染为 `FAIL`。status 的 events 节只读当前 run 的 runtime events，不查询 daemon 全局 validation stream。

### A2. 置信度、复杂因果与影响

- **高置信度**：全部静态生产调用点、`CompileResult`/`loadPreset` 丢失边界、CLI 输出、daemon cache/callback/event 时序、doctor 分类，均有源码和隔离 runtime 证据。
- **高置信度**：隔离 warning preset 的 compile CLI 输出一个 runnable projection 和 `dead-vocabulary` finding；daemon cold load 写一条结构化 DAG event；随后 status 为 `ok` 且无 finding 字段，doctor exit 0、无 warning 行。
- **复杂因果**：同一 preset path 的 daemon promise cache 是全 daemon 而非 per-chain；并发/后续 cache caller 不拥有 cold compile 的 callback 数组。finding 归属取决于谁先 cold-load，而 model 可被所有 caller 共用。成功 cache 不 reload；失败删除 cache，下次重编译并可能重写 events。
- **影响**：P-D1-2 不能仅以“doctor 是否显示 warning”裁决；必须同时选择时间语义（当前源/daemon cache）、归属语义（per-compile/per-chain）、保真度、rejected 时 warning 可见性及 event durability。

### A3. 可保留资产、未知与 R8 readiness

可保留资产：封闭 `CompileResult` ADT、公共 projection boundary、两类结构化 compiler callbacks、统一 validation event 类型、status/doctor 的稳定结构化/人类读面。

仍未知：P-D1-2 的产品裁决；finding 是否需要跨成功/失败统一集合；daemon event 是否被定义为审计事实还是派生观测；cache hit 是否要求 per-chain replay；status 顶层 load 后的 per-item preset failure 当前会直接 reject（未被开头 catch 包住）是否属于既定输出契约。

**R8 readiness：就事实底图而言 ready；就边界裁决而言仍 pending。** 下游可以基于本报告列出的四种事实支持形状比较，不能把当前 hybrid 误称为单一权威。

---

## B. 证据与设计比较

### B1. 权威对象和信息损失边界

1. `CompiledPresetProduct` 明确并列 `model` 与 `warnings`；`CompileResult` 是 `compiled(product)` 或 `rejected(non-empty diagnostics)`（`src/loop.ts:783-805`）。
2. 公共成功 projection 接受 model 与 findings 两个参数并输出 `findings`；rejected projection 只有 diagnostics（`src/loop.ts:2900-2966`）。
3. compile CLI 直接调用 `compilePreset`：成功 projection 到 stdout/exit 0，rejected 到 stderr/exit 1（`src/loop.ts:2990-3002`）。
4. `loadPreset` 调用 `compilePreset` 后，成功只返回 `result.model`；失败把 diagnostics message join 成一个异常（`src/loop.ts:4590-4605`）。这是所有间接消费者共同的信息损失点。
5. compiler 先做 DAG 检查并立即 callback，再按 verdict 拆分；有 DAG error 时 placeholder 阶段不执行（`src/loop.ts:4637-4655`）。placeholder 同样先 callback 后拆分（`src/loop.ts:4657-4681`）。
6. 若早期得到 warn、后期得到 error，callbacks 可看到二者；最终 rejected `CompileResult` 只携 error。callback 自身异常不被 `CompileResult` 捕获，直接 reject promise（`tests/unit/preset/compile.test.ts:330-365`）。

### B2. 全部生产 compile/load 入口与消费结果

| 入口 | 位置 | 消费形态 | warning 结果 |
|---|---|---|---|
| `preset compile --json` | `src/loop.ts:2990-3002` | 直接 `CompileResult` → public projection | 成功完整显示；失败只显示 errors |
| status 的 item preset | `src/loop.ts:3190-3213` | `loadPreset` → local model cache | 丢弃 |
| status/doctor target preset | `src/loop.ts:4154-4173` | `loadPreset` → `LoopOptions` | 丢弃 |
| chain-complete helper | `src/loop.ts:5426-5434` | 可注入 model，否则 `loadPreset` | 丢弃 |
| daemon scheduler | `src/daemon.ts:4448-4498,5485-5492` | `loadPreset(materialize)` + callbacks | model 走 promise；findings 另写 events |
| migration definition helper | `src/preset-migration-definition.ts:17-28` | `loadPreset(materialize)` → identity/phases | 丢弃 |

仓库检索命令：

```sh
rg -n 'compilePreset\(|loadPreset\(' src tests/unit
```

生产代码中只有 CLI 直接调用 `compilePreset`；其余上述入口调用 `loadPreset`。测试调用不计生产 consumer。

### B3. warning 生命周期矩阵

| 场景 | model / error | public `CompileResult` | daemon callback/event |
|---|---|---|---|
| 成功、无 cache | model 可用 | model + 全部 warnings | compile callback 收集；load resolve 后逐条写 event |
| DAG rejected | 无 model | DAG errors，非空；warnings 不在结果 | 全部 DAG callbacks；随后 finding events + load-failed |
| placeholder rejected | 无 model | placeholder errors；先前 DAG warnings 不在结果 | DAG warn 与 placeholder error callbacks；随后各 finding events + load-failed |
| daemon cache hit | 复用既有 promise/model | 不生成新结果 | caller 新建空 collector；不 replay findings |
| 并发 in-flight hit | 共用 cold promise | 不生成新结果 | 只有 cold caller callback 数组被填充，finding 归 cold caller chain |
| daemon load failure | throw | `loadPreset` 异常 | 删除 cache；写 finding + load-failed；下次重编译 |
| daemon 成功后源变化 | 返回 cached model | 无新 compile | 无 reload、无新 finding，直到 daemon 生命周期/cache 重建 |
| direct status/doctor reload | 每次读当前源 | `loadPreset` 只给 model/异常 | 无 callbacks、无 persistence |

daemon 的 cache key 是 absolute/resolve 后的 preset directory（`src/daemon.ts:4448-4465,4606-4608`）；成功 promise 保留，失败在 catch 先删除（`src/daemon.ts:4475-4476`）。findings 在 await compile 之后才串行持久化，完成后才 return model（`src/daemon.ts:4466-4474`）。因此：

- cache 已在 compile promise settle 前发布；其他 caller 可先取得同一 promise；
- model 与 event 不在同一事务；
- cold caller 的 finding event 写入结束前，该 caller 尚未返回 model；但 cache-hit caller await 同一 promise 后不写 event，可早于 cold caller完成 event 写入而取得 model；
- path 跨 chain 共享，使“每 chain 不重复”实际成为“每 daemon cache key 仅 cold caller chain 收到”。

event persistence 也不是强 durability gate：`recordObservabilityEvent` 调用会吞写入异常的 `appendObservabilityEvent`（`src/daemon.ts:2285-2289`; `src/observability.ts:923-928`）。因此 finding 文件写失败只落 stderr，调用仍继续并返回 model；不会因该失败删 cache或重试 finding。结构化 payload 比 CLI generic warning 更丰富：placeholder 保留 file/key/direction/verdict，DAG 保留 kind/verdict/table/status/message（`src/daemon.ts:4520-4555`）。

### B4. status / doctor 错误与输出契约

`buildCoderLoopStatusSnapshot` 只包住初始 `loadTargetRuntime`。该阶段任意链解析或 target preset load 错误都会变成：

```json
{
  "state": {
    "kind": "missing-state",
    "ok": false,
    "loaded": false,
    "errors": [{"path": "chain", "message": "..."}]
  }
}
```

证据：`src/loop.ts:3113-3140`。成功后 runtime invariant errors 才归类为 `invalid-runtime`（`src/loop.ts:3150-3168`）。但 `loadStatusItemPresets` 位于该 catch 之外，注释且实现要求 item preset load failure 直接 propagate（`src/loop.ts:3180-3199`）；故 status 并非所有 compile failure 都结构化为 snapshot。

doctor 直接调用 status snapshot（`src/install-commands.ts:272-282`）。其 runtime rendering：

- state `ok=false` 和每个 state error → `FAIL`;
- phase status 缺失 → `WARN`，不可读 → `FAIL`;
- events 无 run → `INFO`，缺文件 → `WARN`，不可读 → `FAIL`;
- process scan error → `FAIL`，多个 matching live process → `WARN`
  （`src/install-commands.ts:197-243`）。

doctor 只要任一 operator prerequisite、Git origin 或 runtime 行以 `FAIL:` 开头就 exit 1；WARN 不影响退出码（`src/install-commands.ts:284-314`）。没有 compile findings section，也没有 compile result input。status `.events` 是 run-local snapshot；没有 current run 时直接为空，并不读取 daemon 全局 `events/events.jsonl`。

### B5. 隔离 runtime 实验

资产全部位于 `/tmp/rfc547-r7-01-exp-2/`：

- `preset/`：复制 `test-fixtures/preset-compile/warning`，同时产生 runnable model 与 `dead-vocabulary` warning；
- `target/`：隔离 git repo；
- `loop-data/`：隔离 SQLite、socket、pid、events；
- `compile.stdout`, `status.json`, `doctor.stdout`, `loop-data/events/events.jsonl`：原始证据。

执行：

```sh
bun src/loop.ts preset compile /tmp/rfc547-r7-01-exp-2/preset --json
bun src/loop.ts daemon up --loop-data-root /tmp/rfc547-r7-01-exp-2/loop-data --json
bun src/loop.ts chain create r7-01 \
  --config-json '{"repository":"example/rfc547","baseBranch":"main","targetCwd":"/tmp/rfc547-r7-01-exp-2/target","presetPath":"/tmp/rfc547-r7-01-exp-2/preset"}' \
  --loop-data-root /tmp/rfc547-r7-01-exp-2/loop-data --json
bun src/loop.ts status /tmp/rfc547-r7-01-exp-2/target --chain r7-01 \
  --loop-data-root /tmp/rfc547-r7-01-exp-2/loop-data --json
bun src/loop.ts doctor /tmp/rfc547-r7-01-exp-2/target --chain r7-01 \
  --loop-data-root /tmp/rfc547-r7-01-exp-2/loop-data
bun src/loop.ts daemon down --loop-data-root /tmp/rfc547-r7-01-exp-2/loop-data --json
```

观察：

1. compile exit 0，stdout 同时含完整 runnable projection 与一个 generic `findings[{rule:"dead-vocabulary"}]`。
2. chain create 的 daemon cold load 写恰好一条 `preset.dag_check`，payload 保留 table/status/message。
3. 随后的 direct status 重新读取同一当前源，返回 `state.kind="ok"`，`.target.preset.name="warning"`，但没有 findings；`.events={runId:null,...}`。
4. doctor exit 0，输出 `OK: state ok`、phase runner 和 `events runId=<none>`，未出现 `dead-vocabulary` 或任何 warning。
5. 实验 daemon 已正常 down；没有触碰中央 daemon、`~/.coder-loop` 或生产 DB。

### B6. 事实支持的边界形状（不推荐、不排序）

| 形状 | 事实依据 | 确定后果 |
|---|---|---|
| 1. finding 仅由 compile-result 权威；doctor 保持 runtime health consumer | ADT/CLI 已完整消费；doctor 当前无 finding 输入 | 当前源 compile 结果清晰；daemon per-chain 观测与 doctor 无直接关系 |
| 2. doctor/status 重新 compile 当前源并消费 findings | doctor 已在 status 路径重新 load 当前源 | 反映调用时磁盘而非 daemon cached model；需面对 per-item failure 和 rejected/warn 集合差异 |
| 3. doctor/status 读取 daemon persisted validation events | daemon 已投影结构化 events | 反映 cold-load 历史、非当前源；cache-hit chain 可能无 event；持久化非强保证 |
| 4. 保持当前 hybrid：CLI generic findings + daemon structured callback events + status/doctor load error | 当前实然实现 | 同一源存在不同字段、时间、chain 归属和完整性；doctor 对 warning 静默 |

任何形状若声称“同一 compile 结果异步拆分仍等价”，都必须额外给出目前不存在的保证：compile identity/sourceHash 关联、warning 在 rejected 时的处理、cache hit/reload 语义、per-chain replay、event durability/去重及原子可见性。这里仅指出证明缺口，不把这些保证升级为需求。

### B7. 测试同错与盲区

- `tests/unit/preset/compile.test.ts` 证明 success warnings、rejected error-only、direct/materialized projection 一致及 callback exception escape；它认证的是局部 ADT，不证明所有 production consumers 保留 warnings。
- status/doctor tests围绕 runtime snapshot 和行分类；当前没有断言 warning preset 在 doctor 的可见/不可见契约。
- daemon finding tests若只覆盖 cold single-chain load，会与实现共同遗漏跨 chain 同 path、并发 in-flight cache hit、成功源变化和 event write failure。
- rejected public boundary的 error-only 测试与类型一致，但无法证明“失败 compile 的先前 warnings 应否消失”；该语义仍是 P-D1-2 相邻裁决。

### B8. 证据索引

| 证据 | 位置 |
|---|---|
| `CompileResult` ADT | `src/loop.ts:783-805` |
| public projection/CLI | `src/loop.ts:2900-3002` |
| status catch、item resolver | `src/loop.ts:3113-3213` |
| target status/doctor load | `src/loop.ts:4154-4173` |
| compile/load 和 finding 次序 | `src/loop.ts:4590-4695` |
| daemon cache、callback、failure | `src/daemon.ts:4448-4498` |
| daemon event payload | `src/daemon.ts:4501-4555` |
| event write failure吞并 | `src/daemon.ts:2285-2289`; `src/observability.ts:923-935` |
| scheduler materialized load | `src/daemon.ts:5485-5492` |
| doctor classification/exit | `src/install-commands.ts:197-243,272-315` |
| migration consumer | `src/preset-migration-definition.ts:17-28` |
| compile unit boundaries | `tests/unit/preset/compile.test.ts:130-236,330-365` |
| runtime raw assets | `/tmp/rfc547-r7-01-exp-2/` |

## 尾结论

当前 `CompileResult` 在类型与 CLI 上是单次 compile 的权威，但并非全系统 finding 权威：`loadPreset` 切掉 warnings，daemon callback/event 建立缓存归属且非原子的第二投影，doctor/status 只把 load failure 当 runtime state error并对成功 warnings 静默。P-D1-2 必须在上述时间、归属、保真和 durability 差异上裁决；本报告不替它作选择。
