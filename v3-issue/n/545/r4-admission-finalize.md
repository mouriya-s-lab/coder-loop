# RFC #545 R4：admission / credential / finalize 供给侧深审

基线：`main`，`699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只审当前实现是否能作为 `aggregate.md` D3/D4/D7/D14、S29–S39 的供给地基；不把 projection 空位、旧测试名或符号命中当成能力。

## A. 主 agent 摘要

### 问题与结论

**结论（高置信）：现有实现提供了三块可保留地基，但尚不能直接执法 required/expected outcome。**

1. **身份地基可保留。** daemon 在 scheduler spawn 时 mint UUID，绑定 `{chainId,itemId,row runId,phase}`，只经 `CODER_LOOP_RUN_CRED` 注入；socket caller 从内存 registry 解析，context author 再从该 binding 与真实 item 推导为 `{kind:"agent",chainId,itemId(业务 id),runId,phase}`。这符合 D3 的“不可自报”和 outcome 所需的 run/phase 身份。
2. **context outcome 事实可求值。** 已提交 entry 持久化完整 author；`listContextEntries(chainId)` 能枚举并按 `author.kind/runId` 判断“该 run 至少一条 entry”。但没有专用 existence query/index，也没有 finalize evaluator。它是供给，不是 S30–S34 的实现。
3. **普通 phase 与 item-trigger phase 共用 scheduler run lifecycle。** 它们都走 `spawnSchedulerRun → attachRunCloseHandler`，具备相同 credential、run row、close、backoff、attempt/exhaustion。**chain-complete trigger 不共用**：它走 `runPresetChainCompleteTriggerPhases → runAgent`，不 mint daemon credential、不写 scheduler run row、不进同一 close handler。当前 tree 的 “validator” 是 join definition/assessment 数据，不是统一 validator runner lifecycle。因此 S33 不成立。

**关键阻断：当前“run 完结”和 credential 吊销不是一个判定点。** 正常 close 先读取 chain/status，写 artifacts，`completeRun`，`clearCurrentRun`，再将 slot 置空并 revoke；其中有多个 `await`。在 child `close` 与 revoke 之间，registry 仍有 credential，且 `listActiveRuns` 仍可见 slot，持有凭证的后代/外部进程仍可提交 context。当前没有 outcome 判定；若简单把判定插在现有 `completeRun` 附近，会留下“判定后补写”或“先吊销后无法正确归因”的窗口。D4 要求的判定与吊销同一点尚不存在。

### 因果与影响

- `PresetTomlBoundary` 不接受 `[[tools]]` 或 phase `toolRequirements`；runtime `PresetPhase` 也无此字段。compile projection 的 `toolRequirements: []`、`tools: []` 是硬编码 GUI shape 占位，零 producer、零 consumer、零合法性校验。故 S29/S39 均不能声称已有。
- 正常 runner 非零退出且 item 非 terminal 时，现有 `extraAfterRunCompletion` 写指数退避；下一 tick 在 spawn 前按 attempts 上限写 preset-declared exhausted。此通道可作为 required failure 的**失败落点机制**，但 required evaluator 还必须把“exit 0 + outcome 缺失”转成该通道可消费的显式失败事实，不能伪造 process exit code，也不能只发事件。
- expected 可复用统一 observability 基础设施的 `validation` kind，但 `ObservabilityEvent` 是闭合 ADT；不存在 tool outcome event variant、renderer 或 mapper。必须显式新增精确 payload，不能投递自由字符串。
- 当前 context commit 的 entry insert 与 allow audit 不在同一事务：先删内存 session并写 entry，后 await audit。audit 失败时 entry 已存在而请求可能报错。该差异不妨碍 existence outcome，但不能拿现有 audit 当 outcome 的唯一证据。

### 当前、未来与证明缺口

- **当前可复用资产：** credential context/author；socket classified command table；context entry author；同步 SQLite existence 可计算面；普通/item-trigger close handler；非零失败的 backoff 与 attempts-exhausted；统一 typed observability。
- **必须补齐：** 真正 tools registry/requirement ADT 与 compile producer/consumer；context capability outcome evaluator；正常 close 的原子事件循环判定+revoke点；required failure 的 typed finalize verdict；expected/required validation/audit event；chain-complete trigger 和未来 validator 迁入统一 lifecycle 后的同点执法；专门的成功/缺失/异常/迟到/重启测试。
- **未知但不阻止本轮结论：** trigger/validator unified lifecycle 将由哪一棵 RFC 提供及其最终 runner ADT。确定方法：待该能力合流后，以实际入口是否调用同一 `spawnSchedulerRun/attachRunCloseHandler`（或其替代统一入口）、是否 mint 相同 credential、是否产生相同 run row 为准，不能以 phase 名或文档判断。

### 下一步（能力级，不重拆 issue）

在消费“工具声明位”和“trigger/validator unified lifecycle”前，required/expected 执法面不可开工为完整交付。可先把供给合同钉为：**finalize 收到 typed process result → 同一无 await 临界段查询 outcome 并立即 revoke → 得到 typed finalize verdict → 后续持久化 run/events/backoff**；任何异常分支也必须 revoke，且 verdict/outcome/audit 的持久化失败语义需明确。chain-complete trigger 未迁入前不得用 item-trigger 测试代替 S33。

## B. 附录

### B1. S29–S39 三态

| 标准 | 三态 | 当前事实 |
|---|---|---|
| S29 capability 注册 | **缺失** | TOML boundary 无 tools；runtime 无 capability union；projection 仅硬编码空数组。 |
| S30 required 缺失→失败/退避/exhausted/event | **缺失；失败通道可复用** | 无 requirement/evaluator/event；非零 runner 的 backoff/exhausted 已有。 |
| S31 expected 缺失仅 validation | **缺失；事件总线可扩展** | `validation` 是闭合事件 kind，但无 tool-outcome variant。 |
| S32 required 满足零干预 | **缺失；outcome 事实可求值** | entry author 含 runId；无 finalize 求值。 |
| S33 trigger/validator 一视同仁 | **部分且不足** | item-trigger 与普通 phase 统一；chain-complete trigger 分叉；无 validator runner lifecycle。 |
| S34 仅本 run entry existence/body 不透明 | **供给存在，执法缺失** | author 精确、body 独立字段、全链 list 可筛 runId；无 existence API/evaluator。 |
| S35 未声明零扰动 | **当前基线成立，但非新能力** | 所有 phase 实际都“无声明”；现状路径可作为回归基线。 |
| S36 用法文档注入 | **缺失** | 无 `toolRequirementsDoc` binding/builder；当前 prompt runtime docs 不含该项。 |
| S37 outcome 双向证据闭环 | **缺失** | provider/requirement/outcome verdict 都不存在。 |
| S38 复用退避/exhausted | **地基成立，接线缺失** | `extraAfterRunCompletion` 与 pre-spawn exhaustion 可复用；缺 typed required failure 输入。 |
| S39 capability union 穷尽 | **缺失** | 没有 capability union；空 projection boundary 不是 union。 |

### B2. credential 全路径与身份

1. **类型。** `SchedulerRunCredentialContext` 精确包含 `chainId,itemId,row runId,phase`；credential 本身仅 opaque string（`src/scheduler.ts:416-433`）。
2. **mint 时序。** scheduler 先持久化 run/closure、current run、item attempt/phase，渲染 prompt、建 artifacts；随后构造 context 并 mint（`src/scheduler.ts:1607-1687`）。mint 后才检查 absolute runner binary、spawn、wait spawn（`:1688-1706`）。
3. **inject。** 仅在 credential 非 null 时放入 child env `CODER_LOOP_RUN_CRED`（`:1689-1704`）。CLI transport 从 env 自动附带；声明位置见 `src/runtime-paths.ts:5-10` 与 `src/loop.ts:2490-2521`。
4. **registry。** daemon issuer 用 `randomUUID()`，`Map<credential,registration>`；revoke 是幂等 `Map.delete`（`src/daemon.ts:4381-4395`）。registry 不持久化，daemon 重启全部失活（`:1191-1195`）。
5. **resolve。** 无 credential 字段 = operator；空/错误类型 = missing；未注册 = unknown；registry 有值但 run 不在 active slots = inactive 且立即驱逐；成功后 subject 从 binding 得 `{runId,phase}`，caller 再含 chain/row item（`src/daemon.ts:3949-3996`）。item mutation另校验 bound row item（`:4073-4105`）。
6. **context author。** operator 固定为 operator；agent 必须同 chain且 row item 仍存在，再转换为业务 `item.itemId`，author 含 chain/run/phase（`src/daemon.ts:1769-1775`）。caller 的 `author` 字段在 begin 明确拒绝（`:1848-1850`）。
7. **正常 revoke。** close 正常持久化成功路径在 slot 清空旁同步 revoke（`src/scheduler.ts:2064-2072`），finally 再幂等 revoke（`:2183-2191`）。
8. **异常 revoke。** preparation-abort close finally revoke（`:2002-2017`）；尚未 attach child 的 preparation failure 直接 revoke（`:1819-1840`）；active child cleanup 等 close handler；正常 close 任意异常最后仍 revoke。
9. **daemon shutdown。** terminate 驱动相同 child close/finally，不另造 lifecycle（`:2185-2189`）。
10. **crash/restart。** 内存 registry 与 append sessions一起丢失；startup 将 SQLite `endedAt=null` run 杀 stale process group、标 exit `-2`/orphaned，并发 recovery event（`src/daemon.ts:2400-2429`）。旧 credential 不可能在新 daemon resolve。

### B3. context existence 与审计供给

- Entry ADT 将 author 与 body 分开；agent author 精确含 chainId、业务 itemId、runId、phase（`src/context-entry.ts:12-15,70-85`）。body 为空字符串合法，因此 existence evaluator无需解析 body。
- store `appendContextEntry` 单次同步 INSERT；`listContextEntries(chainId)` 全量按 `(created_at,id)` 读，并经 row/scope/author boundaries解析（`src/sqlite-state.ts:2045-2061`）。当前没有 `exists where author.runId` SQL、index 或只读 daemon API；finalize 内可同步枚举，但规模/查询形态不是本报告裁决项。
- begin/chunk/commit 每次 allow/deny均 emit `context.write_admission`；commit 顺序是：admit → 删除内存 session → INSERT entry → await allow audit（`src/daemon.ts:1909-1917`）。entry 与 audit非同事务，且 outcome 应以 entry 表为事实，而非 allow audit。
- session owner只比较 runId+phase（`:1819-1825`）；chain 从 session 固定，credential resolution又绑定 active run。credential revoke后未 commit 的 agent session仍残留内存，但无法通过 caller admission；daemon restart会清空。没有显式 per-run session GC。

### B4. finalize、失败、重试与 exhausted 全路径

#### 正常/非零/timeout/abort

1. child `close` 捕获真实 `exitCode=code ?? 1`（`src/scheduler.ts:1992-2001`）。
2. **当前第一段仍未吊销。** rate-limit state同步设置后，代码 await status lookup，读 current item/status，设置 `finalizingItemStatuses`（`:2019-2035`）。
3. await 关闭 writers、写 completion artifacts；然后同步 `completeRun`，再 `clearCurrentRun`（`:2036-2066`）。两个 store write各自独立 SQLite write transaction，不是一笔跨表事务（`src/sqlite-state.ts:1926-1943` 及 store wrapper）。
4. slot 清空 + revoke 后才 collect excerpt、emit `agent.exit`/`phase.end`（`src/scheduler.ts:2068-2088`）。
5. item 非 terminal 时：rate limit回滚 attempt且不 backoff；否则非零 exit写下一次指数 backoff，exit 0清 backoff（`:2089-2116`, `:2918-2931`）。
6. timeout/startup idle/recycle kill最终都通过 child close进入同一 close handler；分类事件由 lifecycle GC 发出（`src/scheduler.ts:2296-2450`）。显式 terminate/daemon down同样等 close。
7. status-artifact/run-record/current-run 异常：catch 清 slot；若 persistenceStage仍非 null则上报 `RunnerStatusPersistenceError`；finally revoke（`:2166-2191`）。若错误发生在 `clearCurrentRun` 后（persistenceStage=null）则原错透出，但 credential仍 revoke。
8. preparation failure：cleanup child/revoke、尽力写 completion artifact、complete run、clear current、清 trigger/slot；随后 item保持原 status并记录 spawnError+backoff，emit `spawn.aborted`（`:1819-1917`）。

#### attempts/exhausted

- attempts只在 first non-trigger phase + fresh resume时 spawn-time加一（`src/scheduler.ts:1588-1591,1647-1656`）。item-trigger run本身通常不增加 attempt；required 对 trigger 的失败如何计入同一 budget不能从当前实现自动推出。
- 每 tick 选择前，continuable item若 `attempts >= max`，写 preset-declared terminal `statuses.exhausted`、清 backoff、emit `queue.terminal`（`:553-568`, `:798-847`）。
- 非零且非 terminal写 `failureCount+1`、延迟 `min(max, initial*2^(n-1))`；默认 60/120/240/480 cap（`:459`, `:2938-2951`）。
- exit 0但未 status write：最后非-trigger phase会再次选择同 phase（`:685-712`），没有 backoff；required 缺失不能仅“保持 status”来满足 S30，必须形成 typed failure并接入 backoff。

### B5. trigger / validator 分叉

- **item-trigger：统一。** phase plan把 `{afterPhase,whenStatus}` trigger选为普通 `{item,phase}`，仍调用 `spawnSchedulerRun`（`src/scheduler.ts:612-655,567`）。因此 credential/finalize接点相同。
- **chain-complete trigger：不统一。** completion path调用 callback（`:2683-2708,2752-2790`）；实际 `runPresetChainCompleteTriggerPhases`直接 `runAgent`，用合成 finalizerRunId，解析 summary并返回 decision（`src/loop.ts:5426-5501`）。没有 daemon issuer、scheduler run record、slot close handler或普通 attempts/backoff。
- **validator：不存在统一 runner。** 当前 `validator` 命中是 task join binding/evaluation ADT及 SQLite assessment，不是 phase process lifecycle（如 `src/sqlite-state.ts:2423-2451`）。所以不能以 symbol 声称 CAP-IN-4 已供给。

### B6. tools / compile projection 数据流

- TOML schema仅接受 statuses/phases/fragments/agent；phase schema无 `toolRequirements`，root无 `tools`（`src/loop.ts:490-518`）。arktype边界会拒绝这些未声明字段，而不是保存。
- runtime `PresetPhase`没有 requirements，`Preset`没有 tools（`:714-778`）；parser构造 phase时也只写 exits/variables/trigger/runner/model/roles/rights（`:4788-4835`）。
- public compile boundary预留 `phases[].toolRequirements: string[]` 和 `tools[].id`（`:533-583`），projection producer却固定输出 `[]`（`:2935-2955`）。
- scheduler persisted definition packet只存 phase→definitionNodeId（`src/scheduler.ts:1623-1626`），没有 tool data。prompt resolve context也无 `toolRequirementsDoc`（`:3161-3196`）。
- 因此空数组是“UI projection shape placeholder”，不是可复用声明位、registry、capability union或执法数据。

### B7. observability/ADT 消费面

- daemon command name和 command specs是闭合 `Record<DaemonCommandName,DaemonCommandSpec>`；context append三命令均归 `mutation-credential-gated`（`src/daemon.ts:1725-1766`）。D7/D14这一段可保留。
- context admission payload是 allow/deny discriminated union，deny reason闭集；scope/author/persisted row都经过 arktype，scope switches有 `never`（`src/context-entry.ts:4-59,119-145`）。
- unified observability现有 `validation`、`audit`、scheduler lifecycle mapper/renderer均是闭合 switch（`src/observability.ts:21-40,985-1031,1166-1188`）。新增 expected/required事件会强制修改 boundary、mapping/rendering消费者，这是资产；当前无相关 variant。
- required verdict至少需要消费者：preset compiler、prompt doc builder、scheduler finalize、context outcome evaluator、observability mapper/renderer、status snapshot/log query boundary、tests。当前这些点没有“stringly context tool”分支可继承。

### B8. 并发、迟到写、事务与恢复

1. **迟到窗口真实存在。** child close callback在 revoke前有多次 await；registry与 slot仍显示 active。持有复制 credential 的后代可在这段提交。当前 admission 的 inactive defense只有 slot不active时才拒绝，因此不能闭合 D4窗口。
2. **建议的现存可用原语，不是实现裁决：** SQLite store调用同步，JS event loop在首个 await前不切换；所以未来可在 close callback的无-await临界段完成 `exists(runId)` + revoke + typed verdict构造，随后再 await artifacts/events。但 verdict如何与 run row原子持久化仍需实现明确处理。
3. **run/current run非原子。** `completeRun` 与 `clearCurrentRun`分两笔 store write；中间 crash会留下 ended run仍 active-current。startup orphan reconciliation只筛 `endedAt === null`（`src/daemon.ts:2400-2403`），因此该窗口的恢复由其他 current-run一致性机制是否处理，本轮未发现直接证明；实现前应做隔离 crash fault test。
4. **context entry/audit非原子。** 如 B3；required outcome以 entry表判定可以稳定，但事件失败不可反推 outcome失败。
5. **daemon crash。** credential立即因registry丢失而不可用，属于安全失活；旧未结束 run在startup被 orphan reconcile。若 required outcome尚未判定，当前没有恢复时补判能力。

### B9. 测试覆盖、同错与盲区

可保留：

- `tests/integration/daemon/context.integration.ts`：credential→author、missing/unknown/inactive/cross-chain/session-owner、scope、accept/deny audit、chain delete。
- `tests/integration/scheduler/core.integration.ts:305-380`：prompt/artifact/credential/process-spawn/active-child preparation失败，run completion、revoke、backoff。
- `tests/integration/daemon/admission.integration.ts:450-510`：run close后旧 credential拒绝并审计。
- `tests/integration/scheduler/backoff-attempts.integration.ts`：非零/kill重试、默认/override/capped backoff、restart persistence、attempt exhaustion、preset-derived exhausted、rate-limit例外。
- `tests/integration/daemon/runs-observability.integration.ts:657`：item-trigger live spawn；证明item-trigger走统一 scheduler，不证明chain trigger/validator。

盲区/负资产：

- 无测试在 child close到revoke之间主动用复制 credential写 context；“close后拒绝”不能证明“判定同点无迟到窗口”。
- 无 outcome existence evaluator、required/expected、body空白/他run干扰、双向 verdict、tool doc tests。
- compile projection测试若只断言空 `tools/toolRequirements` shape，会把占位误当声明能力。
- backoff绿测只证明 process nonzero路径；不能证明 exit 0 + required缺失被同样分类。
- item-trigger测试不能替代 chain-complete trigger或validator的统一 lifecycle。
- 没有针对 `completeRun`成功、`clearCurrentRun`前崩溃的恢复 fault test。

### B10. 本轮实验与副作用

命令：

```sh
git branch --show-current
git rev-parse HEAD
bun test ./tests/integration/daemon/context.integration.ts \
  ./tests/integration/scheduler/backoff-attempts.integration.ts
```

观察：基线分别为 `main` / `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`；选定两文件 **19 pass / 0 fail / 143 assertions / 15.48s**。完整日志：`/tmp/rfc545-r4-admission-finalize/tests.log`。测试使用 harness 的隔离 loop-data/fixture 并自行 teardown；运行输出显示 harness在 repo ignored `.coder-loop/runtime/evidence/scheduler-tests/...` 下产生短生命周期测试证据，这是现有 harness行为，未修改产品、测试、配置或生产数据库。第一次漏 `./` 的命令未匹配测试文件，退出非零，无执行副作用。

### B11. 证据索引

| 主题 | 主要证据 |
|---|---|
| credential ADT/mint/inject | `src/scheduler.ts:416-433,1565-1706` |
| normal finalize/revoke | `src/scheduler.ts:1992-2191` |
| preparation cleanup | `src/scheduler.ts:1819-1917` |
| timeout/recycle | `src/scheduler.ts:2296-2450` |
| backoff/exhausted | `src/scheduler.ts:798-847,2902-2951` |
| registry/resolve/restart | `src/daemon.ts:1191-1195,3934-4024,4381-4395` |
| context author/admission/commit | `src/daemon.ts:1769-1917` |
| entry/query | `src/context-entry.ts:12-15,70-85`; `src/sqlite-state.ts:2045-2061` |
| tools缺失/空 projection | `src/loop.ts:490-518,714-778,2900-2959,4775-4835` |
| item trigger统一 | `src/scheduler.ts:612-682` |
| chain trigger分叉 | `src/scheduler.ts:2683-2790`; `src/loop.ts:5426-5501` |

**完整交付：本报告已覆盖任务书要求的 identity/lifecycle、context existence、全部 finalize 类别、trigger/validator 分叉、tools projection、事件通道、并发/恢复、ADT消费者与测试盲区；未修改 WORKFLOW.md 或任何产品文件。**
