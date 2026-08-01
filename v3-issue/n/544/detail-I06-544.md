# RFC #544 R7/I06 — events 契约身份与 schema 兼容边界

> 基线 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。锚点仅 AGG §4.3/D6、R5 L11/L14、R6 I06。本文调查合法事件集合与 schema/文件名兼容边界，不改规格、不讨论实现选项。实验仅使用 `/tmp/coder-loop-544-I06-*`。

## A. 一页结论

1. **AGG 的“44 种”不是契约合入时的计数。** 44 精确对应 `b51905e4`（2026-07-11，#618）；契约提交 `a3ff0e9c`（2026-07-13，#671）前，#642/#646 已加入两个 persistence-failure type，所以 #671 合入前后均为 **46**。当前为 **52 type / 53 payload variants**（`scheduler.recovery` 有两个 reason 分支）。44→52 的八项均能追到提交：契约前2、契约后 context 1、closure 5；无 type 删除。故差异由**过时文档基线 44→46**和**后续代码增量 46→52**共同构成；现有代码没有 version/compatibility 声明可把后六项自动证明为稳定契约演进。
2. **精确只闭合于 discriminator/required shape，不是 exact/versioned object。** 52-type union强制 type↔kind↔payload，并拒 unknown type、kind错配、缺 required payload、`runId`无完整task identity；但 envelope、payload、subject extra key均保留，`ts`只验string（非ISO也接受），没有schema version。
3. **filename compatibility 与 line schema compatibility独立。** parser接受 active、sequence history、pre-sequence legacy history三类名字；legacy只标识文件名/排序。三类文件内每行一律过当前 `ObservabilityEventBoundary`，无旧parser、migration或version dispatch。legacy名字+当前payload可读，不代表旧payload可读。
4. **query fail-fast。** 任一坏行、unknown type、旧payload、active尾partial使整次query抛错，不返回此前合法行；partial后追加完整行仍被中间坏行永久阻断。只有空白行被跳过；filter在parse之后，不能绕过不匹配查询的坏事件。
5. **没有逐variant契约fixture。** unit “canonical schemas”只round-trip `daemon.stop`；closure仅抽样 consumed/reconciled。集成路径和exhaustive switches能覆盖当前writer/消费编译闭环，却无52/53合法fixture、历史payload、unknown/extra/version/partial矩阵，不能证明历史JSONL兼容。

**根因链：** 观察（44/52漂移、legacy名可识别但旧内容/坏尾全失败）→机制（无schema version；filename/line parser分离；全量逐行首错throw）→来源（44取自#618时点；#671只导出已有规则；业务提交继续扩同一union）→放大（status、logs、启动恢复共享同一query）→影响（当前ADT与三代文件名是资产，跨schema读取不是既有保证）→多因根因（文档未对合入SHA计数、无版本身份、测试偏当前writer正常路径、legacy filename易被误读为payload兼容）。只改“44→52”仍残留无版本、非exact、旧payload/坏尾全失败、逐variant fixture缺口。

## B. 证据、矩阵与调用链

### B1. envelope/parser兼容边界

| 面 | 当前事实与实验 | 证据 |
|---|---|---|
| discriminator | 5 kind、52 type；unknown `daemon.future`、`daemon.start+audit`拒绝 | `src/observability.ts:17-140,294-817` |
| envelope | required `ts:string`; chain/item/runId/phase/subject optional；缺ts拒绝，无subject接受，`ts=not-a-date`接受 | `:280-287` |
| identity | run存在则task identity三元组必须完整；无run可无identity或带完整三元组；partial拒绝 | `:289-297`; unit `:120-156` |
| exactness | base/payload/subject无 `+:'reject'`；实验中schemaVersion、payload extra、subject extra均接受并保留 | `:9-14,280-817` |
| version | 无version字段、dispatch或migration；extra `schemaVersion:1`无语义 | 全文件无 `schemaVersion/eventVersion` |
| query | discover→readFile→每个非空行JSON.parse→当前boundary→filter | `:953-978` |

### B2. 当前52 type / 53 payload variant逐项映射

基线：`44`=b51905e已有；`pre +2`=#671合入前已存在却未计入AGG；`post +1/+5`=#671后增量。payload嵌套闭集见行锚。

| kind | type | payload主字段 | 基线/边界 |
|---|---|---|---|
| audit | chain.layout | chainId,state,updatedKinds? | 44 `:303-313` |
| audit | chain.status | chainId,fromStatus,toStatus,terminatedRunIds | 44 `:315-319` |
| audit | item.created | rowId,itemId,status | 44 `:321-325` |
| audit | item.status | rowId,itemId,fromStatus,toStatus,reason | 44 `:327-331` |
| audit | item.reordered | rowId,itemId,position | 44 `:333-337` |
| audit | queue.terminal | rowId,terminalStatus | 44 `:339-347` |
| audit | item.dependency_unblocked | rowId,fromStatus,toStatus,dependsOn | 44 `:349-354` |
| audit | item.mutation.caller_admission | rowId,itemId,claims,outcome,reason | 44 `:656-681` |
| audit | item.status.write_admission | rowId,itemId,phase,requestedStatus,exits,outcome,reason | 44 `:683-714` |
| audit | item.exit.selected | rowId,itemId,phase,selection/action,declared sets,outcome,reason | 44 `:716-738` |
| lifecycle | chain.stop.from_phase_exit | chainId,id,alreadyStopped,terminatedRunIds | 44 `:740-747` |
| audit | item.add.rights_admission | claimedPhase,presetName,outcome,reason | 44 `:749-775` |
| audit | privileged_op.caller_admission | op,claims,presetName,outcome,reason | 44 `:777-799` |
| audit | item.update.field_write_admission | rowId,itemId,claims,field sets,outcome,reason | 44 `:801-817` |
| decision | slot.busy | slotKey,chainId,repoCwd,activeRunId | 44 `:386-390` |
| decision | item.dependency_wait | rowId,dependsOn,unsatisfied | 44 `:392-398` |
| decision | item.backoff | rowId,failureCount,nextRunAt | 44 `:400-405` |
| decision | chain.complete_trigger | chainId,decision,reason? | 44 `:407-411` |
| lifecycle | daemon.start | pid,socketPath | 44 `:413-417` |
| lifecycle | daemon.stop | pid | 44 `:419-423` |
| lifecycle | daemon.stop.terminated_runs | pid,runIds | 44 `:425-429` |
| lifecycle | daemon.socket.rebind | pid,socketPath | 44 `:431-435` |
| lifecycle | daemon.fatal | fatalKind,pid,error | 44 `:437-441` |
| validation | daemon.preset_load_failed | chainId,preset,presetDir,error,operation | 44 `:443-465` |
| lifecycle | scheduler.recovery | orphaned_run_reconciled,pid,reconciledRuns | 44 variant1 `:467-480` |
| lifecycle | scheduler.recovery | stale_current_run,pid,reconciledRuns + task identity | 44 variant2 `:481-490` |
| lifecycle | agent.spawn | slotKey,pid,worktreePath,presetDir | 44 `:492-496` |
| lifecycle | agent.exit | slotKey,exitCode,status,excerpt | 44 `:498-502` |
| lifecycle | phase.start | repoCwd,pid | 44 `:504-508` |
| lifecycle | phase.end | exitCode,durationSeconds,status | 44 `:510-514` |
| lifecycle | chain.completed | chainId | 44 `:516-520` |
| lifecycle | attempt.timeout | signal,attemptMs,excerpt | 44 `:522-526` |
| lifecycle | run.startup_idle_kill | idleTimeoutMs,stdoutBytes | 44 `:528-536` |
| lifecycle | scheduler.rate_limited | resetsAt,resetAtIso,rateLimitType | 44 `:538-546` |
| lifecycle | recycle.pending_entered | recycleAfterMs | 44 `:548-557` |
| lifecycle | recycle.timeout_kill | SIGKILL,recycleAfterMs,excerpt | 44 `:559-566` |
| lifecycle | recycle.natural_exit | elapsedMs | 44 `:568-576` |
| validation | spawn.aborted | slotKey,chainId,id,reason,toStatus | 44 `:578-582` |
| validation | session_id.invalidated | runner,previousSessionId,reason | 44 `:584-590` |
| validation | chain.invalid | chainId,chainName,context,error | 44 `:592-598` |
| validation | preset.placeholder_check | file,key,direction,verdict | 44 `:600-608` |
| validation | preset.dag_check | kind,verdict,table,status,message | 44 `:610-626` |
| diagnostic | daemon.warning | message | 44 `:628-634` |
| diagnostic | scheduler.tick_failed | pid,error | 44 `:636-640` |
| diagnostic | chain.complete_trigger_failed | chainId,error | 44 `:652-656` |
| diagnostic | scheduler.lifecycle_event_persistence_failed | eventKind,error,originalPersisted=false | pre +2 `:642-646` |
| diagnostic | runner.status_persistence_failed | path,stage,persistencePath,error | pre +2 `:648-652` |
| audit | context.write_admission | imported ContextWriteAdmissionPayloadBoundary | post +1 `:299-303` |
| audit | closure.resource_prepared | closureId,worktreePath,branchName,baseCommit,freshness | post +5 `:356-362` |
| audit | closure.lifecycle_changed | closureId,from,to,reason | post +5 `:362-368` |
| audit | closure.consumed | closureId,evidence,freshness | post +5 `:368-374` |
| audit | closure.git_failed | closureId,code,error | post +5 `:374-380` |
| audit | closure.reconciled | closureId,repoCwd,mismatch ADT | post +5 `:380-384` |

对账为44+2+1+5=52 types；recovery双variant使payload union为53分支。脚本提取当前type set与payload discriminator set，双向差集均为空。

### B3. 44→52历史归因

| SHA/日期 | type数 | 观察 |
|---|---:|---|
| `b51905e4` 2026-07-11 | 44 | AGG数字最后精确对应点 |
| `f6d94bfa`,`8f90058b` | 46/47后经host-lock移除回46 | 留存的两项是两个persistence failure |
| `a3ff0e9c` 2026-07-13 | 46 | #671只导出boundary/segment规则；父与提交均46 |
| `d381d06c` | 47 | +context.write_admission |
| `699842eb` | 52 | +五个closure events |

因此44是旧快照，不是#671 merge契约计数；46→52是有来源的增量，但源码没有声明“新增type即向后兼容”、版本或consumer capability negotiation。

### B4. filename与line schema分层

| 层 | 接受/行为 | 证据 |
|---|---|---|
| active | basename精确等于eventsFile（通常events.jsonl） | `:1286-1290` |
| current history | stem-16位sequence-start-end-UUID.jsonl | `:1291-1298` |
| legacy history | stem-start-end-UUID.jsonl；只产出legacy-history身份 | `:1299-1305` |
| discovery/order | 未知名忽略；legacy全在current前，active最后；重复sequence抛错 | `:1308-1353` |
| line schema | 三类segment均一律用当前boundary；无按filename选旧schema | `:953-965` |

实验混合legacy历史(`daemon.stop pid=1`)、sequence历史(`pid=2`)、active(`daemon.start`)可按legacy→current→active读出；任一文件中的旧payload/unknown type仍使全query失败。`events-v2-...`返回null并被忽略。

### B5. 全部writer类别、consumer与fixture

| 面 | 完整类别/行为 | 证据 |
|---|---|---|
| scheduler writer | SchedulerEvent闭集经exhaustive mapper转event，包括closure/decision/run lifecycle | `src/scheduler.ts:241-289`; `src/daemon.ts:827-1129,3728-3743` |
| daemon direct writer | RPC/lifecycle/admission/context/validation/diagnostic handlers直接make event；主流汇聚到三个record方法 | `src/daemon.ts`全部`makeObservabilityEvent`; `:2285-2313` |
| fallback writers | runner与scheduler persistence failure写两条独立JSONL，同一event ADT | `src/daemon.ts:1314-1362`; `src/runtime-paths.ts:130-132` |
| append API | async/sync、throw/tolerant四入口；typed参数直接JSON.stringify，无落盘前runtime reparse | `src/observability.ts:923-951` |
| consumers | status直接query并折错误；logs.query三流分别query后按ts合并；daemon启动读failure流尾项；CLI logs只走RPC | `src/loop.ts:3592-3615,2138-2163`; `src/daemon.ts:1309-1340,2712-2727` |

测试资产：unit canonical schema仅daemon.stop（`tests/unit/observability/observability.test.ts:29-35`）；identity覆盖all-or-none与recovery（`:120-156`）；segment/query/rotation覆盖当前完整行、legacy/current命名、串行day/size（`:158-295`）；closure只抽样consumed/reconciled（`:37-117`）。集成测试真实触发很多writer，render与scheduler mapper均exhaustive（`src/observability.ts:1020-1211`; `src/daemon.ts:827-1129`），但current writer→current parser闭环会同错；仓内不存在逐52/53 fixture或old/unknown/extra/version/torn-tail契约矩阵。

### B6. 受控实验结果

命令为 `bun /tmp/coder-loop-544-I06-experiment.ts`，使用隔离目录。结果：valid接受；缺ts/unknown type/kind错配/缺payload required/run无identity拒绝；无subject与非ISO ts接受；envelope/payload/subject extra接受并保留；混合三代filename成功；bad line、tail partial、partial后完整行、unknown type line、old payload line均整次throw；完整末尾换行成功。实验数据、脚本和输出已清理。

### B7. 证据索引与边界

- 稳定文字：`AGG-544-gui-observability-gateway.md:153-164,288-315`。
- ADT/parser：`src/observability.ts:9-140,280-829`；query `:953-978`；filename `:1279-1364`。
- writer/render：`src/observability.ts:898-951,1020-1211`; `src/daemon.ts:827-1129,2285-2313,3728-3743`。
- 历史：`git log -- src/observability.ts`与逐SHA type集合提取。

高置信：52/53映射、44/46/52历史、parser/query/filename实验、生产调用类别。未读取生产loop-data，故不知道真实历史是否已有不兼容行；I06不推断崩溃窗口、cursor或fs.watch（归I07/I08）。
