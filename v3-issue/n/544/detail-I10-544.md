# I10 — attempt 快照、pinned definition 与 typed binding 因果链

调查基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。裁决锚点仅为 AGG D2/D10/CAP-2/CAP-3、R5 L20/L21/L22/L24/L25/L26、R6 I10。本报告只陈述现状、可证伪实验和证明边界；不提出修法、选项、成本或 issue 拆分。

## A. 决策摘要（≤一页）

**可证伪问题的答案：当前系统有“run 记录携带 definition hash”的历史身份，但没有“该 hash 可解引用到当时 definition、bindings 与实际 runner prompt”的历史同一性。**

完整当前时序为：

1. daemon 以**源路径**为 cache key 首次 load；load 先把源目录按内容 hash materialize，再从 materialized copy parse/validate，另从源目录计算完整 `sourceHash`。
2. scheduler 每次 spawn（fresh、retry、session resume 均同一入口）先取当前进程 cache 中的 `LoadedPreset`，把其 `sourceHash` 写入 run extra；随后才读 phase prompt、解析 bindings、render，并构造 runner argv。
3. run row / closure / item attempt 状态在 render 与 artifact 初始化**之前**落库；attempt 目录随后只创建 status、stdout/stderr、runner authorization，未保存 prompt 或逐 key bindings。
4. 同一 daemon 进程内，同路径源文件修改不会使 cache 失效；后续 spawn 继续使用旧 materialized definition。daemon 重启后 cache 为空，会从同路径当前内容加载新 definition；新 materialization 又删除同名旧 hash sibling。重启恢复只关闭 orphan run、保留 item/session 后重新调度，不按旧 hash 解引用。
5. scheduler 的 session resume 仍重新 render 完整 prompt，再交 runner adapter 以 resume argv 发送；旧 `spawnOneAttempt` 特例才把 resume prompt替换为“继续”，不能外推到 scheduler。

**直接实验：** 在隔离目录固定同一 preset 路径，V1 materialize/load 后让真实 fake runner 捕获 argv，再把同一路径改成 V2 并重新 load。结果：

- identity 从 `26b83c…f66ed` 变成 `b1891d…a412`；
- runner 实收 argv 的 `-p` 是 V1 文本；
- V2 materialization 后目录中只剩 V2，读取 V1 的旧 prompt path 得到 `ENOENT`；
- number/boolean/string binding 实际 render shape 分别是字符串 `"7"`、`"true"`、`"x"`；object 被拒绝为 `cannot stringify value of type object`。

这证明 materialized copy 在其存活期间能稳定供一次 argv 构造，也证明它不是 historical repository。

**当前缺陷（相对锚点）：**

- D2/D10：没有 `prompt.md`、`bindings.json` 或 fresh/resume snapshot；runner 接收值只存在于短生命周期局部变量与 argv。
- CAP-2：hash 精确、持久，但 definition 内容不持久、不可按 hash 解引用；restart 重新读同路径当前内容，且 prune 主动破坏旧 materialized path。
- CAP-3：schema 输入可有 number/boolean，但 renderer 消去类型，当前可观察基线只是 string；复合 JSON 值不能 render。

**证明缺口（不能冒充当前缺陷）：**

- run extra 的 hash 能证明 scheduler 当时选择了哪个 `LoadedPreset.sourceHash`；不能单独证明实际 argv 文本、每个 binding 值、prompt 文件读取成功，或磁盘产物仍与 hash 对应。
- stdout/status/authorization 产物能证明 runner 周边执行事实；均不含 effective prompt/bindings。
- 现有测试分别证明 hash 变化、materialization/prune、renderer、runner argv 与 resume；没有一个测试跨越“source mutation → historical run row → restart → old identity 解引用/argv 对照”。

**静态未知 / retention 边界：** CAP-2 的 repository retention/GC 与 CAP-3 additive typed shape 仍是 L24 未决语义；当前代码和本实验不能裁决其期限、shape 或保留策略。

## B. 完整证据

### B1. 对象、所有权与持久性

| 对象 | 生产/拥有方 | 当前载荷 | 生命周期/落点 | 能证明 | 不能证明 |
|---|---|---|---|---|---|
| source preset | preset author / item `presetPath` | 整个目录 | 同路径可变 | 当前输入 | 历史内容 |
| `CompiledTaskModel` | loader | parsed preset、phase sources、`sourceDir`、`sourceHash`、task tree | daemon memory cache | 当前进程选择的 definition | restart 后可恢复内容 |
| materialized copy | loader/materializer | 整目录副本；md 已替换 `PRESET_ROOT` | `<root>/preset-materialized/<name>-<short-hash>` | 存活期间的稳定 prompt path | 永久历史；同名新 hash 会删旧 |
| run definition packet | scheduler / SQLite | kind、完整 source hash、phase→definition node id | `runs.extra`，并投影至 `execution_definitions`/task nodes | 精确 identity 与结构节点关联 | definition blob、prompt、bindings |
| effective prompt | renderer/scheduler | rendered prompt + exits epilogue | JS 局部变量 → runner argv | 当次 spawn 输入（仅运行时） | 事后读取 |
| bindings | item/chain/runtime + resolver | renderer 消费的 string | 无 per-attempt 对象/文件 | 当次模板替换 | 原始类型与历史值 |
| run artifacts | scheduler | run/phase status、stdout/stderr、authorization、sessions/events（按路径） | `chains/<chain>/runs/<run>/<phase>` | 状态、流、授权面 | prompt/bindings |

结构 identity 的 definition node 是相对稳定的 `task:<phase>`，definition ref 才携带内容 hash（`src/loop.ts:864-874`; `src/scheduler.ts:1621-1626`）。`execution_definitions` 只有 `(kind, content_identity, semantic_hash, schema_version)`，且 insert 把 hash 同时写作 semantic hash；无内容列或 locator（`src/sqlite-state.ts:654-660,2359-2361`）。

### B2. 完整时序

#### B2.1 definition identity 与 materialization

1. `loadedPresetForItem` 由 item path/name 解析到源目录；`loadedPresetFromDirForChain` 以绝对源路径作为 cache key（`src/daemon.ts:4441-4450,4606-4608`）。
2. cold load 调 `loadSchedulerPresetFromDirMaterialized`；materializer 对 sorted `(relative path, bytes)` 做 SHA-256，目录名只取前 16 hex（`src/loop.ts:4417-4431`）。
3. staging copy 完成、marker 写入、rename 后才可见；`.md` 在复制时替换绝对 materialized root（`:4441-4476`）。
4. 每次新 hash 完成后，删除相同 `<name>-` 的所有旧 sibling（`:4478-4502`）。
5. compile 从 materialized `preset.toml`/prompt parse 和 validate，但最终完整 `sourceHash` 再从**源目录**计算（`:4610-4613,4686-4695`）。正常无并发修改时两者对应；代码没有把“复制时字节集”和“随后 hash 源目录字节集”作为一个原子快照，因此 source 在两次遍历之间变化时，静态上存在 model/materialized bytes 与 full sourceHash 分离窗口。现有测试未覆盖此竞态。

#### B2.2 attempt 创建、render、argv、artifact

唯一 scheduler spawn choke point 的顺序是：

1. 取 `LoadedPreset`、从 session table决定 fresh/resume、生成 run id（`src/scheduler.ts:1586-1592`）。
2. 准备/reopen closure worktree。
3. **先** `recordRunWithClosureResources`，run extra 写 `definitionKind=preset`、完整 `definitionContentIdentity=sourceHash`、phase identities（`:1607-1637`）。
4. 写 current run 与 item：fresh first phase 才把 `attempts + 1`；resume 不增加 attempts（`:1640-1656`）。
5. **后**读 phase prompt：daemon 从 `LoadedPreset.preset.phases[].prompt` 指向的 materialized file 读取（`src/daemon.ts:4407-4419`）。
6. `renderPrompt`按模板 placeholder 查 phase 声明并逐个调用 resolver（`src/loop.ts:5778-5803`）；scheduler追加统一 exits epilogue（`src/scheduler.ts:1660-1673`）。
7. runner adapter接收 `finalPrompt` 和 resume decision构造 argv（`:1674-1681`）。
8. 再创建 run/phase目录与 status/stream文件、写 `runner-authorization.json`，最后 spawn（`:1682-1705`; `src/scheduler.ts:3255-3285`）。

因此 run identity **早于** prompt read/render/argv/artifact。若这些后续步骤失败，preparation cleanup 会关闭已建 run并恢复 item/backoff（`src/scheduler.ts:1869-1917`），但仍没有任何 prompt/binding snapshot 可判定失败前已计算到哪一步。

artifact 路径来自 `resolveChainRuntimePaths`：`runs/<runId>/` 下有 root status/stdout/stderr，`<phase>/` 下有 phase status/stdout.jsonl/stderr.txt/sessions.jsonl（`src/runtime-paths.ts:170-195`）。初始化清单无 prompt/bindings（`src/scheduler.ts:3255-3285`）。

#### B2.3 fresh、retry、resume、restart

- **fresh：** 无 `(phase, runner)` session 时 fresh；first phase fresh 才计一次 item attempt（`src/scheduler.ts:1588-1591,1647-1649`）。
- **scheduler retry：** 下一 tick 再走同一 spawn choke point，再 load（通常命中同进程 path cache）、再读 prompt、再 render、再产生新 run id/目录。它不复用上次 effective prompt。
- **scheduler session resume：** persisted session 只改变 runner adapter的 resume decision；scheduler仍在 adapter之前完整重读/重渲 prompt（`:1588-1589,1660-1680`; `src/scheduler.ts:3068-3071`）。因此 historical session identity 也不钉住 definition。
- **`spawnOneAttempt` 特例：** resume 时把 prompt改成固定 `"继续"`（`src/loop.ts:6355-6363`）。这是另一套旧 run-agent/backoff入口；不能用来描述 scheduler resume。
- **同进程源修改：** cache key只有 path且成功 promise不失效（`src/daemon.ts:4448-4475`），所以后续 retry/resume继续旧 in-memory model/materialized path；源当前内容不会被读取。
- **daemon restart：** 新 daemon cache为空；startup recovery清 current-run、把未结束 run标 orphaned，但明确不改 item phase/session，之后 item重新可调度（`src/daemon.ts:2350-2432`）。新 spawn按同路径当前源 cold load，得到新 hash/definition并 prune旧 materialization，不查询旧 run hash来解引用。

### B3. 受控实验

实验使用基线源码 API、隔离 `/private/tmp/coder-loop-544-I10-experiment`，未启动生产 daemon、未写生产 root。步骤：

1. copy `single-phase-example` 到固定 `same-path-preset`；
2. prompt 写入 V1，materialize+load；
3. 通过真实 `buildRunnerInvocation` 和 `/usr/bin/sandbox-exec` 执行 fake Claude binary，捕获其实际 argv；
4. 同一路径改为 V2，再 materialize+load；
5. 尝试读取 V1 prompt path、枚举 materialized root；
6. 对 number/boolean/string/object 调实际 `resolveBinding`。

观测：

| 观察 | 结果 | 直接机制 |
|---|---|---|
| V1 full identity | `26b83c3c0c39d752…befc66ed` | source bytes hash |
| V2 full identity | `b1891de7f62af439…f9f5a412` | 同路径内容变化 |
| runner `-p` | 含 `I10_VERSION_ONE` | final prompt直入 adapter argv |
| runner授权 preset path | V1 materialized short-hash path | `LoadedPreset.presetDir` |
| V2 后旧 path | `ENOENT` | sibling prune |
| materialized root | 仅 V2 dir | 非 repository |
| scalar binding | `"7"` / `"true"` / `"x"` | `stringifyBindingValue` |
| object binding | throw `cannot stringify value of type object` | 当前 renderer只接受 scalar |

临时脚本、输出与实验 root 已全部清理；`find /tmp -maxdepth 1 -name 'coder-loop-544-I10-*'` 无输出。

### B4. typed binding 的真实 shape

item schema声明可为 `string|number|boolean|json`，但 render boundary返回值固定 `string`。具体规则：null/undefined→`""`，string原样，finite number→十进制字符串，boolean→`"true"/"false"`，其他（含 object/array）throw（`src/loop.ts:6032-6054,6075-6081`）。runtime binding更早已是 `RuntimeBindings` string map；preset business literal也落 `Record<string,string>`（`:6057-6072`）。

所以 L22 的“类型化 source 存在”只在输入 schema层成立；进入 effective prompt前类型证据已经消失。D2所谓“现状渲染值”可由此确定为 string，但 CAP-3 additive typed位的 wire shape仍属 L24 未决。

### B5. 因果链与多因根因

#### 症状一：历史 run 显示 identity，却无法重建当时 prompt

- **观察：** run extra/task node有 hash；无 prompt/binding artifact。
- **直接机制：** identity在 render前入库，effective prompt仅是局部变量/argv。
- **上游来源：** loader负责可变 path→短期 materialization；SQLite只存 ref；artifact initializer没有 prompt/bindings。
- **历史原因（仅代码可证）：** materialization注释明确目标是随机 worktree可读且限制磁盘增长；execution definition表当前只建 identity projection。代码没有声明它们是 historical repository。
- **放大条件：** source mutation、daemon restart、prune、render/preparation failure。
- **消费者影响：** D10及任何 audit/replay只能看周边事实，不能显示或验证实际输入。
- **多因根因：** 非单一“少写两个文件”，而是（a）definition ref不可解引用、（b）prompt/bindings不落盘、（c）run identity写入早于prompt成功、（d）prune按名称只保留一个版本共同造成。
- **症状修补残留：** 即使单独保留旧 materialized dir，仍无 per-attempt bindings/final epilogue/argv证据；即使单独写 prompt，definition本体与 typed source仍不可按 identity恢复。

#### 症状二：同路径 preset 修改后，历史同一性随进程边界改变

- **观察：** 同进程 cache继续旧 copy；restart cold load新 copy并删旧。
- **直接机制：** cache key是 path且无内容重新验证；materializer prune sibling。
- **上游来源：** attempt归属通过 item path重新查 loader，而非用 run definition ref查 repository。
- **放大条件：** retry/resume恰跨 daemon restart。
- **消费者影响：** 两次逻辑上连续的尝试可能拥有不同 definition hash与prompt；session resume不构成definition pin。
- **多因根因：** path cache提供进程内偶然固定，持久 identity不提供跨进程解引用，两者生命周期不一致。
- **症状修补残留：** 只延长cache或只保存hash都无法证明runner实际收到的文本。

#### 症状三：bindings 无法作为类型化历史输入

- **观察：** scalar统一string，JSON复合值render失败。
- **直接机制：** `resolveBinding`返回string并在边界stringify。
- **上游来源：** phase variable projection/render contract没有 value ADT/per-key snapshot。
- **放大条件：** number/boolean显示歧义、未来 typed consumer、JSON字段。
- **消费者影响：** D10最多显示字符串；无法区分原始 `"7"` 与 `7`、`"true"` 与 `true`。
- **多因根因：** schema输入类型与renderer输出契约断开，且没有attempt snapshot保存任一侧。
- **症状修补残留：** 仅从字符串猜类型会制造不可验证推断；仅保存原始item也不能证明当次fallback/runtime resolution结果。

### B6. 当前可证明与不可证明的历史同一性

**可证明：**

1. run row声明的完整 `definitionContentIdentity`；
2. runtime node关联同一 definition ref与稳定 phase node id；
3. source unchanged时 hash确定性，source文件任一变化时 hash随之变化（现有 compile/materialize测试与本实验）；
4. runner stream/status/authorization分别记录的运行周边事实。

**不可证明：**

1. 某 historical hash对应的完整 definition bytes；
2. historical run实际读取的 prompt bytes、追加 epilogue后的 final prompt；
3. 每个 binding的source、resolved string、原始typed value或fallback路径；
4. runner argv与run extra hash一定对应（无共同持久记录；loader两次遍历还存在源并发修改窗口）；
5. retry/resume/restart使用了与首 attempt相同definition；
6. 旧 materialized目录的 retention或可恢复性。

### B7. 测试资产、同错盲区与未知

**资产：**

- `tests/unit/preset/materialize.test.ts` 覆盖content hash、marker、同名 sibling prune、token substitution。
- `tests/unit/preset/compile.test.ts` 覆盖sourceHash随fragment/template/auxiliary变化与direct/materialized projection一致。
- `tests/unit/loop/prompt-bindings.test.ts`、`runtime-bindings.test.ts` 覆盖字符串render source映射。
- scheduler integration覆盖runner argv、session resume、restart/backoff与run identity的各自路径。

**同错盲区：**

- materialize/compile测试把“旧目录被删”当预期磁盘管理，不检验historical ref可解引用。
- identity测试只断言hash/ref字段，未对照runner实收prompt。
- argv测试捕获当前spawn，但不在source mutation/restart后回查historical run。
- resume/restart测试验证session/backoff与进程恢复，不冻结definition内容。
- artifact测试断言status/stream/authorization存在，没有负向守护prompt/bindings缺失，也没有D2失败diagnostic语义。
- 无测试制造materialize copy与随后full sourceHash遍历之间的源修改竞态。

**保持未知：**

- CAP-2 repository应保留多久、何时GC、run/chain/task tree何者持有retention root；
- CAP-3 additive typed value的精确ADT/wire shape；
- L24所列D11对CAP-2消费语义。

这些未知不能从当前cache、表schema或测试习惯反推。

### B8. 证据索引

| 结论 | 权威位置 |
|---|---|
| cache以源path为key且只在失败删除 | `src/daemon.ts:4448-4477,4606-4608` |
| phase prompt从loaded materialized path现场读取 | `src/daemon.ts:4407-4419` |
| content materialization与sibling prune | `src/loop.ts:4417-4502` |
| full source hash来自源目录 | `src/loop.ts:4686-4695` |
| task definition node shape | `src/loop.ts:864-874` |
| run identity先于render/artifact | `src/scheduler.ts:1586-1685` |
| scheduler fresh/resume依据session | `src/scheduler.ts:1588-1591,3068-3071` |
| scheduler render与runner argv同源 | `src/scheduler.ts:1660-1681` |
| artifact实际清单 | `src/runtime-paths.ts:170-195`; `src/scheduler.ts:3255-3285` |
| restart recovery不恢复definition | `src/daemon.ts:2350-2432` |
| renderer与scalar stringification | `src/loop.ts:5778-5822,6032-6081` |
| execution definition表无内容 | `src/sqlite-state.ts:654-660,2359-2361` |
| `spawnOneAttempt` resume特例 | `src/loop.ts:6355-6363` |

