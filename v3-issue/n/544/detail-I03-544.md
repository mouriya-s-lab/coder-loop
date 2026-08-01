# RFC #544 R7 / I03 — status 与 task-tree 的单时点事实

> 固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。设计锚点仅为 AGG CAP-1、D3、D9；账目输入为 R5 L05/L06/L10 与 R6 I03。复用 I01 已证 opener/WAL 事实和 I02 已证最终输出边界。隔离实验位于 `/tmp/coder-loop-544-I03-*`，完成后已清理；未修改产品、测试、配置或生产 root。

## A. 主 agent 摘要（最多一页）

### 问题、结论与置信边界

问题：status 与递归 task-tree 的 DB 读取到底共享哪个 SQLite snapshot；writer 在读取步骤之间提交时，哪些跨版本组合和树断裂可达；CAP-1/D3/D9 所需“同一事实源/单时点”的现状边界是什么？

**高置信结论：当前只有“字段最终来自同一个 SQLite 文件”的事实源一致性，没有“一次 status 输出来自同一提交”的单时点一致性。** `buildCoderLoopStatusSnapshot` 至少按 chain → items → current → runs → taskTree 使用五个先后打开、关闭的连接；每次 opener 又没有贯穿 builder 的显式 read transaction。writer 在任意两个 helper 间提交，最终 boundary 仍可接受由不同 commit 拼成的八槽对象。

`getTaskTree` 虽只用一个连接，却同样没有显式 read transaction。它依次读取 tree root、每个 node、children、kind row、closure、sessions、join 最新 binding/evaluation，最后才读 active runs。SQLite autocommit 下每条 SELECT 各自取得 statement snapshot。因此 writer 可在递归步骤间提交，产生两类结果：

1. **合法但跨提交的 tree**：旧 children 集合 + 新 closure lifecycle/resources/session，旧 node + 新 join binding/evaluation，旧 root subtree + 新 activeRuns；`assertTaskTreeSnapshot` 只验 shape/variant，不验共同 commit。
2. **显式失败而非旧/新整形**：例如 reader 已列出 child 后 writer 删除该 child（合法级联或整棵 tree 替换窗口），随后 `readTaskNode` 报 `invalid_json`; root 指向的 node 在两句之间消失也同理。错误发生在最后的 `taskTree` helper，绕过 I01 所述初次-load catch，整条 status command reject。

FK/CHECK 约束只限制**单次已提交数据库状态**，不能把多条 SELECT 合成一个 snapshot。它们使“单一 commit 内 dangling parent/closure/active-run association”不可提交；却不阻止 reader 把不同合法 commits 的投影拼在一起，也不阻止先读到随后被级联删除的 ID。

### 八层因果、影响与修补残留

持久化 task-tree 的 exact ADT 与 normalized FK/CHECK 是可保留资产 → store 的 write API 用 `BEGIN IMMEDIATE` 保证每次写操作内部原子 → store 的 `read()` 只是异常翻译，不开启 transaction → recursive repository 以多句 SELECT 组装一个 ADT → status 再用多个 store/连接组装多个槽 → WAL 允许 writer 在 reader语句之间提交 → exact boundary 接受“各字段类型正确但 commit 不同”的对象 → D9 会忠实渲染一个从未整体存在过的树/状态组合，或整个读取失败。

只收紧 D3 schema、只保留 CAP-1 exact ADT、只把五个 helper 改成复用一条连接、或只给 task-tree 某一查询加 transaction，均不能单独证明整个 status 单时点：前两者不表达 commit identity；复用连接仍是 statement snapshots；局部 transaction仍允许其余 status 槽跨提交。本文不据此选择修法。

### 当前/未来影响、资产、未知与下一步

- 当前：CLI/doctor/daemon-start 可消费跨提交 items/current/runs；taskTree 是最后读取，最容易比 queue/current 更新。常态无 writer 时输出稳定，不构成并发证明。
- 未来 D9：GUI 若把同一响应当作“现在”，可能展示 selected item 已旧而 tree/active run 已新，或 tree node lifecycle 与 activeRuns 不属于同一 commit；这不是另建推断，但也不是 CAP-1 整体状态的同点投影。
- 可保留：task-tree exact recursive boundary、normalized tables、FK/CHECK、每个 write operation 的 immediate transaction、persisted事实源（没有 git/process 反推）。
- 纯证明缺口：仓库无 barrier/instrumented concurrent status 测试；现有 task-tree round-trip均在 writer静止后读取。真实生产写负载频率、旧盘 FK 是否曾被关闭写入坏数据、网络文件系统 WAL 行为未知。
- 边界结论已足够进入 R8；无需把候选实现选项冒充事实裁决。

## B. 证据附录

### B1. status 的连接与 statement 时间线

| 顺序 | builder 步骤 | 连接/语句边界 | 输出中被固定的事实 |
|---:|---|---|---|
| 1 | `loadTargetRuntime→resolveDbChainForTarget` | store A；`getChainByName` **或** `listChains`，无 chainName 时还可能对每条 chain `listItems`; close | chain identity/metadata/status，以及随后由磁盘加载的 preset/options |
| 2 | `readDbItemsForChain` | store B；`SELECT items`; close | items，后续 queue/selected/runtime errors/current item projection的共同内存输入 |
| 3 | `readDbCurrentRun` | store C；active_runs+closures+runs join；close | current run identity |
| 4 | preset/runtime/events/process inspection | 非同一 DB snapshot；events另读落盘事件，processes读 `ps`/daemon RPC | 非 DB 时钟事实，进一步不可能由 SQLite transaction自动统一 |
| 5 | `readDbRunsForChain` | store D；`SELECT runs`; close | runs aggregate |
| 6 | `readDbTaskTree` | store E；见 B2 多语句递归；close | CAP-1 tree |
| 7 | `StatusSnapshotBoundary.assert` | 纯 shape assert | 不检查 commit/version/coherence |

关键代码：`src/loop.ts:3113-3177,4154-4217,4230-4272`。I01 已实测每个 helper 都走同一 read-write/WAL opener；这里不重复 opener 副作用。items/current 虽在早期读完，`runs` 与 `taskTree` 是对象 literal 求值时才读取，因此 writer 可在异步 preset/events/process步骤期间提交，扩大交错窗口。

### B2. task-tree repository 的完整查询顺序

`SqliteStateStore.read()` 仅执行 `fn()` 并翻译异常（`src/sqlite-state.ts:1614-1619`），与 write 的 `db.transaction(fn).immediate()`（`:1606-1612`）不同；`getTaskTree` 没有 BEGIN。

1. `task_trees` 读 `root_node_id`。
2. 对每个 node：`task_nodes WHERE runtime_node_id=?`。
3. seq/par 先 `task_nodes WHERE parent_node_id=? ORDER BY child_index`，再按返回 ID 深度优先递归；seq 随后读 `task_seq_nodes`。
4. leaf 读 `task_closures JOIN items`，再读 `closure_sessions`。
5. par 在 children 全部读完后读 `task_par_nodes`、latest `task_join_bindings`、latest `task_join_evaluation_bindings`。
6. 整棵 root 完成后才读 chain 的 `active_runs JOIN task_closures JOIN items`。
7. 最后 `assertTaskTreeSnapshot({root,activeRuns})`。

证据：`src/sqlite-state.ts:1974-1984,2477-2527`。递归节点数、leaf sessions数与 par数都会线性增加 statement snapshot 数量和 barrier位置。

### B3. 受控 writer 实验矩阵

实验以固定 SHA 的 schema/API在隔离 WAL DB构造 seq→leaf 与 par→leaf 树；reader在表中所列两句间 barrier，独立 writer连接以 transaction提交。结果同时用原始查询值与最终 `TaskTreeSnapshotBoundary`/status wire观察；这是最小 instrument副本，不改产品树。

| barrier 与 writer commit | 可复现 reader结果 | boundary/输出结果 | 判定 |
|---|---|---|---|
| status items读完后新增 item并使其成为 current/run/tree leaf | queue/items仍旧；后读 current/runs/tree可新 | 各槽shape合法，最终 JSON可输出 | 可达跨提交组合 |
| status current读完后 complete/clear run | current旧 active；runs后读到 completed；tree activeRuns后读为空 | shape合法 | 可达；对象整体从未存在 |
| tree读 root/children后更新 leaf closure lifecycle/resources | children旧，closure新 | exact ADT接受 | 可达跨提交 tree |
| leaf closure读完后新增/替换 session | closure主字段旧，sessions新 | exact ADT接受 | 可达 |
| par node/children读完后 append join binding/evaluation | node/children旧，join latest新 | exact ADT接受 | 可达 |
| root递归结束后插入合法 active run | root closure投影旧，activeRuns新 | exact ADT接受（若各自shape合法） | 可达 |
| children ID列表读完后删除 child（级联） | 后续 child lookup为null | store `invalid_json`; 无最终 status wire | 可达失败窗口 |
| tree root ID读完后删除 tree/root | root lookup为null | 同上 | 可达失败窗口 |
| 同一显式 deferred read transaction内重复上述 writer | reader所有 SELECT保持transaction起点版本；writer WAL提交成功 | reader得到旧整形 | 对照：SQLite能提供但当前代码未请求 |

实验还验证了同一连接、无 BEGIN 时两次 SELECT 能分别看到 writer前/后的值；“复用一个连接”本身不提供 snapshot。WAL只保证每条 statement读视图一致和已提交隔离，不保证一串 autocommit SELECT共享视图。

### B4. 可达与不可达组合的约束边界

**在正常 `foreign_keys=ON` 且 writer使用单个 store write transaction时不可作为单一已提交状态出现：** dangling `task_nodes.parent_node_id`、tree root指向不存在node、leaf缺其closure、active_run指向不存在closure/run、active run与closure生命周期非法、非法 node kind/lifecycle/container/join枚举。这些由 FK/CHECK、write API前置校验和 immediate transaction共同约束。

**但上述约束不推出 reader整体一致：** reader可先取得合法旧引用，writer再合法级联删除，reader下一句才发现缺行；或分别读取两个各自合法的旧/新状态，组合后仍通过shape boundary。反之，某些组合会被 `assertTaskTreeSnapshot`拒绝（例如 cursor指向已不在已读children中的节点、variant缺字段），但拒绝只是失败，不会回退为一个一致snapshot。

历史/迁移边界：opener会启用 foreign keys，但 I01 已证 migration会暂时关闭它；本轮没有生产历史盘全集，不能声称所有既有盘从未含违反约束的数据。即使历史数据完美，statement级撕裂仍成立。

### B5. CAP-1 / D3 / D9 对照

| 条款 | 当前已成立 | 当前不成立/不能由现状推出 |
|---|---|---|
| CAP-1 persisted同一事实源 | tree字段来自 normalized SQLite task tables；不从git/worktree/process反推 | “同一事实源”不等于“同一commit”；tree内部也可跨statement commit |
| D3集成外部 exact shape | `TaskTreeSnapshotBoundary`嵌入status；非法variant/extra受约束 | schema exact不编码read timestamp/commit；七槽边界问题见I02，且跨槽 coherence完全未验证 |
| D9如实树渲染 | GUI可消费leaf/seq/par discriminated union资产 | 一次响应可能不是任何真实时点；忠实渲染shape不等于忠实渲染单时点状态 |

因此可证实的最窄主张是：“每条成功的查询只读已提交SQLite事实，最终对象通过当前shape boundary。”不可证实的更强主张是：“一次 status / taskTree是数据库某一时点的完整投影。”

### B6. 并发、崩溃、迁移与错误传播

- 并发：WAL允许writer在reader语句间提交；busy timeout/锁不把多句read合并。DELETE journal可能改变阻塞时机，但无BEGIN仍无跨句snapshot契约。
- writer崩溃：单个 immediate transaction按SQLite原子恢复，因此不会产生半个已提交writer操作；reader仍可拼接崩溃前已经提交的commit与之后恢复/下一writer commit。opener migration/journal副作用归I01。
- reader崩溃：没有持久写补偿；只产生无输出/部分外围读取。tree读取中异常会使整个builder reject。
- 错误传播：初次chain读取异常会被折成missing-state（I01）；items/current/runs/taskTree后续异常没有该catch。相同底层并发删除因时点不同出现不同CLI语义。

### B7. 测试同错、盲区与资产未知

现有 `tests/unit/sqlite-state/task-tree.test.ts` 证明静止数据库的nested round-trip、约束拒绝、migration与生命周期写原子；`tests/integration/cli/db-main-loop.integration.ts`证明最终 taskTree可过exact boundary。它们没有第二writer、barrier、BEGIN对照、跨槽commit标记或递归中途删除。因此绿测与当前statement-snapshot实现共同自洽。

缺失的证明维度：至少两个连接；在 status每个helper之间与tree每种query边之间暂停；commit version标记；成功混合与失败窗口；DELETE/WAL差异；reader/writer kill。未知资产包括真实root最大树深/节点数（决定窗口长度）、历史坏数据、外部消费者是否已把响应当单点。确定这些需生产只读盘副本统计和消费者契约调查，不属于本切片。

### B8. 根因集合与证据索引

根因集合：① status orchestration没有一个贯穿所有DB槽的read resource；② helper各自open/close；③ store `read`不建立transaction；④ recursive repository用多statement组装一个ADT；⑤ boundary只验证shape，不表达commit coherence；⑥非DB的events/processes本来又有独立时钟。症状级处理任何单点都会保留其余根因。

证据索引：

- status orchestration/五连接：`src/loop.ts:3113-3177,4154-4217,4230-4272`
- store read/write transaction差异：`src/sqlite-state.ts:1605-1619`
- task-tree入口与递归：`src/sqlite-state.ts:1974-1984,2477-2527`
- exact ADT：`src/task-runtime.ts:7-178`
- normalized constraints/migrations：`src/sqlite-state.ts` 的 `TASK_*_TABLE_SCHEMA_SQL`、`ACTIVE_RUNS_TABLE_SCHEMA_SQL` 与 `migrateStateSchema`
- 现有盲区：`tests/unit/sqlite-state/task-tree.test.ts`; `tests/integration/cli/db-main-loop.integration.ts`
- 设计锚点：`AGG-544-gui-observability-gateway.md:114,212-232,364-383,496`

隔离实验使用 `bun 1.3.14` / SQLite `3.43.2`；临时instrument副本、DB、barrier日志均已删除。本文不包含候选方案、推荐或成本估算。
