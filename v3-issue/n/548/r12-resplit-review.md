# RFC #548 · R12 rolling resplit 最终独立复核

## A. 主 agent 摘要（≤1 页）

**结论：PASS。**

R12 已收敛为一个原子、可独立实施且可由真实 runtime checkpoint直接验收的 next-batch child：**线性化 durable request record/query 与 mutation/read verdict**。

最终遗留的文字矛盾已经消除：预期结果、Changed paths、registry expected集合、checkpoint 13与对抗检查现在全部统一为 **23 variants**（`rolling-resplit-next-batch.md:34,67,380,396`）。

共享fixture identity也完全一致：`CHAIN=rr-main`、`ITEM=rr-item`；seed、preflight、changed checkpoint及23 variant checkpoint均消费同一identity（`:88-91,129-145,364,369,372,380`）。

完整 R12 gate通过：

- RR 无 RFC-2/schema/typed CLI future dependency；
- production registry/union静态双向 equality与runtime 23项双向集合检查闭合；
- `request.get/list`自身进入registry并形成durable read record，query污染计数有明确处理；
- 23项均以handler-reaching args执行并由后续query证明；
- fixed admission driver使用production scheduler credential路径并固定断言subject/verdict/reason；
- identity、created/no-op/rejected/changed、reply-loss、restart、rollback、duplicate/replay、collision与权限路径均有直接runtime checkpoint；
- fixture、daemon、repo、artifact及trigger清理有界且隔离；
- schema DAG与后续债务完整保留但未提前展开；
- 默认typecheck/test与逐字real-e2e边界齐全。

**R12 草案可以发布。当前只完成草案与复核，没有创建或修改 GitHub issue。**

## B. Gate 证据

### 1. Issue 原子性与依赖 — PASS

- child只解决engine request identity、durable typed verdict/query及mutation/read线性化（`rolling-resplit-next-batch.md:7-53`）。
- 不吸收preset/schema、startup quarantine、repair、consumer/router或external-terminal（`:49-53,55-72`）。
- Depends on无future issue，只复用main窄底座（`:387-390`），符合R11中无入边的RR节点。

### 2. 23项recordable surface — PASS

- 23项closed surface、unknown与pre-identity例外、query自身record语义明确（`:33-39`）。
- `DAEMON_COMMAND_SPECS`是dispatcher/auth/RR共同执行源；union/registry keys使用双向`Exclude` equality（`:172-196`）。
- checkpoint 13从production registry读取actual keys，与独立expected 23项双向比较（`:380`）。
- 每项使用handler-reaching args；context按begin→chunk→commit，daemon.down最后执行并重启。
- `request.get/list`以真实handler args执行，再由另一个identity查询其record。

### 3. Query闭包与计数 — PASS

- query自身产生typed durable read record，不special-case、不在处理时递归自查（`:34`）。
- identity-boundary checkpoint在比较前后数量时排除query自身records（`:368`）。
- admission driver和`record_variant`均以新的query identity读取目标record（`:178-184,297-305`）。

### 4. Fixture、顺序与cleanup — PASS

- UUID artifact目录拥有data、repo和全部输出（`:78-103`）。
- scheduler-disabled production daemon有bounded readiness（`:104-120`）。
- seed函数创建`rr-main/rr-item`，preflight机器核对相同identity（`:129-145`）。
- 表格明确1→13顺序，共享前置行实际调用preflight（`:364-380`）。
- cleanup只删除自身目录；rollback trigger有行内与全局双重清理（`:121-127,376,383`）。
- runs与slot subtree均直接断言为零（`:147-152`）。

### 5. Admission固定driver — PASS

- driver逐字完整内嵌、唯一argv、expected不可由实现者替换（`:198-360,373`）。
- 使用production daemon、scheduler mint/inject/revoke、真实runner child与Unix socket。
- 固定覆盖operator、无credential-as-operator、unknown/live/cross-item/expired、phase allow/deny、hard-deny与reorder。
- record query直接断言command、subject、verdict与admission reason。
- current main在首个`request.get`得到预期unknown-command红灯；RR实现后才能继续全部矩阵。
- `finally`停止daemon，shell trap删除独立UUID artifact。

### 6. Failure、replay与恢复 — PASS

- malformed/缺identity零record；合法identity坏envelope可查rejected（`:368`）。
- created/no-op/conflict/changed与业务事实互证（`:369-372`）。
- commit后reply未交付在bounded deadline内可查，重放不重复mutation（`:374`）。
- 同data root重启后record与业务事实稳定（`:375`）。
- SQLite abort trigger证明mutation/record不split-brain（`:376`）。
- fresh `RACE_ITEM`并发得到created + already-existing，同identity重放仍唯一row（`:377`）。
- identity collision返回typed conflict、原record不覆盖、第二意图零mutation（`:378`）。

### 7. 验证边界、DAG与后续债务 — PASS

- 第14行执行`bun run typecheck && bun test`（`:381`）。
- 逐字声明本issue不运行`bun scripts/real-e2e.ts`，compatibility只由#685执行（`:385`）。
- schema DAG为`P/E→S`、`S→C/W`、`W→Q/O`、`Q→O`（`:408-425`）。
- schema、public write/CLI、startup、repair债务完整保留且未展开future issue（`:429-440`）。
- consumer/router/external-terminal仅保留为后续事实阻塞。

## C. 完成核对

- [x] 完整复核当前454行draft。
- [x] 确认`rr-item` identity与23 variants文字全部同步。
- [x] 回归全部runtime、权限、恢复、DAG与验证边界gate。
- [x] 未修改draft、源码、测试或GitHub issue。
- [x] 唯一写入为替换本报告。

**本报告共 93 行。**
