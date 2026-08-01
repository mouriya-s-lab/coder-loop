# RFC #548 · 修补后预期地基

**事实基线：** `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本文只固定稳定条款、实然缺口、操作员裁决、修补后应成立的保证与仍须运行证明的事项；不定义实现方案、issue 边界或工作量。

## 稳定条款—事实—裁决—预期保证

| ID | 稳定条款 | 实然问题 | 操作员裁决 | 修补后预期保证 | 仍未证明的运行项 |
|---|---|---|---|---|---|
| D1 | 树外消费端必须从稳定 CLI 边界取得可派生类型的 schema | `preset compile --json` 仅输出 projection instance；private TS symbols 不能跨仓消费 | PATH CLI 输出真正 JSON Schema | schema document 与 projection instance 身份分离；schema 带 preset identity、版本与严格字段契约 | CLI 命令、版本失配、跨仓生成类型与真实预校验尚未运行证明 |
| D2 | required 只有一个权威解释 | 当前字段声明没有已裁的 required 归一规则 | field object 内逐字段 `required`；旧字符串/对象默认 required，optional 显式 false | loader、JSON Schema 与写入校验由同一 field model 派生 required | 旧语法加载、optional、required JSON Schema 输出与拒绝行为尚未运行证明 |
| D3 | 引擎兜底不能只守树外预校验 | 当前 add/update/store/scheduler 写入没有统一 preset schema gate | 守住可执行 item 的持续持久态不变量 | add、batch-add 与所有改变 `extra` 的入口不能提交 missing/unknown/type-invalid 新状态 | 全写入口、并发/事务、scheduler 内部写回与重启后的不变量尚未运行证明 |
| D4 | PATH CLI 的错误必须可被机器无损消费 | 当前 `code: message` 文本有损；socket 内部 envelope 不是公共 CLI ADT | CLI 独立 typed rejection ADT | socket→CLI 穷尽转换；missing/unknown/type mismatch/missing preset/already-existing 等保持稳定 variant 与必要细节 | CLI stdout/stderr/exit、全部 variant、未知 variant fail-closed 尚未运行证明 |
| D5 | 重放必须有规范工作身份 | 唯一约束只证明一行，若身份语义不固定则无法解释 duplicate | `(chain,itemId)` 是规范工作身份 | 相同 identity 一律是同一工作；already-existing 即已接管；调用方负责无碰撞映射 | 同 delivery、异 delivery 同 identity、并发 duplicate 与 exactly-once 执行尚未运行证明 |
| D6 | 两步 new-workspace 前缀失败必须有确定语义 | chain 创建成功而 item add 未完成时，空 chain 无 delivery 证据 | 空 active chain 长期合法，不归属 delivery | engine 不自动补种/删除；空 chain 不证明 consumed 或 not-consumed；delivery retry 由别处记录 | crash/restart、重放、operator delete 与 router retry 的组合路径尚未运行证明 |
| D7 | 每个请求 verdict 必须 durable 且可关联 | 现有 JSONL events best-effort、与 mutation 非同事务、写失败可吞，不能重建 request verdict | engine 新增 durable request record，并明确与 mutation 的 durability/transaction 关系 | 稳定 request identity 关联 created/already-existing/rejected/no-op；消费 delivery 日志可与其互证 | record/mutation 的线性化点、crash 窗、duplicate/no-op、查询读面尚未运行证明 |
| D8 | 严格 schema 必须覆盖真实持久 shape | `extra` 混合 engine control keys、preset fields 与历史 remainder；preset-only strict 会误判 | 合成 engine-owned 与 preset-owned 完整 schema | 两个权威子模型合成单一严格 schema；CLI 暴露字段契约及可写性；unknown policy 对完整集合执行 | control-key 分类、只读字段拒绝、历史 remainder 与所有 consumer 的兼容尚未运行证明 |
| D9 | 历史非法 item 不能被调度后才失败 | 真实库 58/58 无法证明符合新解释，且 missing/drift preset 会改变判定 | daemon startup 校验；不合格 durable 标注不可启动；专用命令修复 | 非法 item 零调度/spawn；原因可观察且跨重启；成功修复后才恢复资格 | startup scan 的锁/crash/重启、原因分类、status/operator 读面与零 spawn 尚未运行证明 |
| D10 | 历史扫描量词必须明确 | deleted/terminal 行仍物理存在，但并非都会再执行 | 只扫描可能再次执行的 item | active、stopped、可 resume/retry 行纳入；terminal/deleted 保持快照；任何重入可执行态先过 gate | 各状态词表、未来重入入口、scan 与 scheduler 竞态尚未运行证明 |
| D11 | 修复 missing/drift preset 时不得出现半状态 | 只换 `extra` 无法修复 preset 缺失；分别更新会留下中间态 | 原子替换目标现存 preset + 完整合成 `extra` | 单事务全量校验并提交 preset/extra/资格；失败整笔拒绝；成功同步清除不可启动原因 | 命令权限、并发、rollback、修复后真实调度与审计 record 尚未运行证明 |
| ET-1 | external-terminal 必须与既有 runner 生命周期同构 | 历史 slot/item owner 会与 current closure authority 形成第二事实源 | current per-closure authority 是唯一事实源 | external invocation 只能引用 current `closure_id/run_id/runtime_node_id` 及 closure worktree/session/reachability/consumption/cleanup | 真实 external invocation 尚未进入这条 authority，不能据此声称远端生命周期完成 |
| ET-2 | production 完成必须有真实 remote terminal | 历史仅 probe-only、`invocation_pending`、zero-spawn；无法证明 session、completion、retry 或 loss | production 不保留 invocation-pending/zero-spawn 终点 | execution-domain、probe/invocation 分离与 typed hold/loss 词汇可保留；真实 invocation 才能进入完成判定 | production binary/probe、headless status/session、endpoint identity、loss ordering、真实 E2E 与 candidate gate全部未证明 |

## 预期不变量

1. **公共契约唯一：** preset 权威 field model 与 engine control model 合成完整 `extra` schema；PATH CLI 输出其真正 JSON Schema，所有消费者和 gate 不维护平行解释。
2. **可执行持久态安全：** 所有可执行 item 的每次新持久态都符合当前目标 preset 的合成 schema；归档快照不自动追溯改写，但任何重入可执行态先校验。
3. **修复原子：** 不可启动 item 只能通过专用 operator 命令原子替换现存 preset 与完整 `extra`，并在同一事务语义中恢复资格。
4. **请求可追溯：** `(chain,itemId)` 定义规范工作；每个 engine 请求有 durable typed verdict record，且其与 mutation 的 durability 关系明确。空 chain 不承载 delivery verdict。
5. **closure authority 唯一：** external-terminal 不新增 slot/item 生命周期 authority；zero-spawn 或 `invocation_pending` 不构成 production completion。

## 仍未证明的运行清单

- schema CLI 的真实输出、版本校验、类型派生、unknown/required/可写性与 typed rejection 全路径。
- startup 对所有可再次执行 item 的 durable reconciliation、不可启动读面、跨重启稳定性、零调度/spawn及原子修复后恢复。
- request record 与 mutation 在 created、already-existing、rejected、no-op、crash 与并发重放下的唯一 durable 结论。
- into-chain/new-workspace、空 chain、router retry 与真实 GitHub fire-and-forget 的端到端 verdict 和 exactly-once 执行。
- production external-terminal binary/version、无副作用 readiness probe、invocation argv/取消边界。
- headless terminal/status producer与 admission、session resume/reuse/cleanup、endpoint identity。
- terminal-first/loss-first 的唯一 durable winner、restart 不翻转、并发 run 隔离。
- 真实 HAPI success、failure→retry、hold→restoration→真实执行、active loss、race、restart、并发与 closure cleanup E2E。
- 冻结 candidate、live `origin/main` merge-base、clean detached 双基线与完整 gate。

## 证据索引

| 证据 | 覆盖 |
|---|---|
| `operator-decisions.md` D1-D11 | 全部操作员裁决及确定含义 |
| `detail-historical-extra-migration.md` A、B.1-B.7 | 真实 DB 统计、`extra` 混合 shape、写入口、preset 漂移、startup/migration/事务事实 |
| `decision-external-terminal.md` A1-A2 | current authority 与 zero-spawn 两项裁决准备；B-ET-1～6 外部合约/运行阻塞 |
| `detail-r7-09-closure-authority.md` A、B1-B7 | current per-closure 唯一 authority、生命周期、事务/crash windows、历史 slot owner 冲突 |
| `AGG-548.md` §2、T2/T3/T5/T7、LOG-746/747、§6-§8 | RFC 稳定条款、交付保证、既有事实与未闭合洞 |

## 核对

- [x] 覆盖 D1-D11 与 external-terminal blocker。
- [x] 未把 projection、现有 events、current closure authority、probe-only、zero-spawn 或 `invocation_pending` 写成预期已保证。
- [x] 未定义实现方案、issue 边界或规模。
- [x] 结论以当前稳定条款、实然事实与操作员裁决为来源，不以旧产物自证。
