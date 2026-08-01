# 逐项验证原始结果(03 标记文档的材料,main@699842e)

> 来源:codex 深度验证(D2/D4、D7/D9、D3/D5/D10 三组)+ 本线程自验(D1/D6/D8 组,codex 该组因沙箱写限制失败)。
> 判定词表:IMPLEMENTED / PARTIAL / NOT_IMPLEMENTED / OBSOLETE。

## 组 1:D1/D6/D8(本线程自验,2026-07-29)

| ID | 判定 | 证据 |
|---|---|---|
| A1 顶层八 keys+schemaVersion==1 | IMPLEMENTED | compile 实跑:keys 恰为 findings/fragments/phases/preset/schemaVersion/stateGraph/statuses/tools |
| A2 stateGraph.edges>0、variables[0].type、preset 元信息 | IMPLEMENTED | 实跑:`{key:"TARGET_CWD",type:"string",sourceKind:"runtime"}`;preset 含 name/dir/sourceHash |
| A3 invalid → 非零退出+结构化 stderr | IMPLEMENTED | /tmp fixture 实测:exit=1、stdout 0 字节、stderr `{kind:"rejected",diagnostics:[{verdict:"error",rule:"preset-structure",message:…}]}` |
| A4 warn findings 通路 | IMPLEMENTED | bundled compile findings 含 dead-vocabulary warn;tests/unit/preset/dag-check.test.ts:123 |
| A5 parsePreset 生产调用恰一次 | IMPLEMENTED | src/loop.ts:4626 唯一调用(4710 定义) |
| A6 root identity 投影 | IMPLEMENTED | `preset.taskTree == {"kind":"seq","identity":"tasks:root"}`;phases[].taskTree.identity=phase:<name> |
| A7 确定性字节 | IMPLEMENTED | 两次 compile cmp 无差异 |
| A8 schema artifact 分发 | NOT_IMPLEMENTED | usage 仅 `preset compile <name\|path> --json`;无 jsonSchema/--schema 符号;package.json 无 exports |
| B1 `=== "ISSUE"` | PARTIAL | src/ 零命中;**tests/unit/preset/load-bundled.test.ts:218 残留 `candidate.key === "ISSUE"`** |
| B2 prefix/suffix/style/blankBefore 声明驱动 | IMPLEMENTED | renderRuntimeInputsDoc(src/loop.ts:5824-5837)纯声明驱动,`${doc.prefix}${value}` |
| B3 variables boundary 精化 | NOT_IMPLEMENTED | `"variables?": "object"`(src/loop.ts:496)仍宽 |
| B4 渲染函数无 key 分支 | IMPLEMENTED | 函数体核读,仅消费 doc 声明字段 |
| C1 plan 目录+注册退役 | IMPLEMENTED | 目录不存在;role="plan" 计数 0 |
| C2 dead-fragment 检查 | NOT_IMPLEMENTED | dag-check 规则仅 dead-vocabulary(R3)等;无 fragment 可见性规则 |
| C3 bundled findings 现状 | 新事实 | **findings 很脏**:1 条 dead-vocabulary(`in_progress` 无 producer)+ 约 100 条 declared-unused 占位符 warn(iter-entry/review-entry/blocked-responder-entry/umbrella-finalizer-entry 大面积声明未用)——preset 精简重构(ff08ca2)后声明与模板脱节 |
| C4 dev-plan.md | IMPLEMENTED(已移除) | .claude/commands/dev-plan.md 不存在 |

## 组 2:D2/D4(codex task-ms5sepbf-3sekfl,原文)

F1 | PARTIAL | `src/loop.ts:6032-6080`:item 缺失经 `stringifyBindingValue(undefined)` 返回 `""`;chain 缺失先尝试 default、仍缺失则返回 `""`;runtime 缺失在 6053 抛错;静默空串位于 6076。
F2 | PARTIAL | `src/loop.ts:4993-5036`:binding 支持字段全集为 `source/default/label/prefix/suffix/style/blankBefore`,其中 `default` 仅允许 chain 且仅为 null/string/number/boolean(4799-4804);不支持 `required/type/projection`。
F3 | NOT_IMPLEMENTED | `src/daemon.ts:2166-2198` 的 chain create 只验证固定请求字段/metadata;`src/daemon.ts:2887-2917,3001-3057` 的 item add 只加载 preset、生成默认状态并验证 item 字段;`rg -n 'variables|PresetPhaseVariable|resolveBinding' src/daemon.ts` 无相关创建期校验命中。
F4 | NOT_IMPLEMENTED | `rg -n 'ValueType' src` 空、exit=1;变量 compile 类型固定 `"string"`(`src/loop.ts:2945`);binding 无 array/record/union。`string|number|boolean|json` 仅是 item field 词表(`src/loop.ts:458-459,4913-4938`),不是 binding 类型。
F5 | NOT_IMPLEMENTED | `PresetVariableSource` union 全集仅 `item | chain | runtime`(`src/loop.ts:660-668`;source 正则 5192-5203);无 `exit.*` binding source 通路。
F6 | PARTIAL | compile variables[0] = `{"key":"TARGET_CWD","type":"string","sourceKind":"runtime"}`;无 required/default;生成器 `src/loop.ts:2945` 只投影这三字段。
F7 | PARTIAL | `[item.fields]` 可声明 `json`(`src/loop.ts:458-459`),但 variable binding 不接受 `type`(4993-5007);object/array 渲染在 `src/loop.ts:6080` 抛 `cannot stringify`,无 JSON stringify 通路。
G1 | NOT_IMPLEMENTED | `PresetTomlBoundary` keys 全集 = `name,item,runtime?,statuses,phases,fragments?,agent?`(`src/loop.ts:508-518`),无 `tools`;presets/ 下无 `[[tools]]`。
G2 | PARTIAL | compile schema 预留 `phases[].toolRequirements: string[]` 与 `tools: {id}[]`(`src/loop.ts:573,580`),生成器硬编码 `[]`(2946,2954);实际输出均 `[]`。
G3 | NOT_IMPLEMENTED | provider/availability/outcome/enforcement 与工具相关命中为零;工具符号仅 compile shape/空值四处(573,580,2946,2954)。
G4 | PARTIAL | `src/install-commands.ts:140-169` 无条件检查 gh PATH + `gh auth status`;runner CLI 检查来自 `statusSnapshot.target.runner.phases`(272-289);另有 repo access/git origin/runtime health(294-314);无声明驱动工具检查。
G5 | NOT_IMPLEMENTED | `toolRequirementsDoc` 零命中;doc dispatch(`src/loop.ts:5806-5818`)仅 runtime inputs/phase exits/status/trigger/terminal/retry。

codex 总结:D2 仅有字符串绑定、chain scalar default、item-field 输入类型,缺统一 ValueType、required、结构化渲染、创建期校验;D4 无注册表、四维模型、声明驱动 doctor、约束文档;compile 占位 shape 在 `src/loop.ts:568-580`,输出侧 2945-2954 固定 string/空。

**注(对照草稿的修正)**:草稿称"chain.* throw 可 default"——实测 chain 缺失同样静默 `""`(F1),失败语义比草稿记载更退化。

## 组 3:D7/D9(codex 任务收尾前失败;实测证据 + 本线程补验)

codex 任务留下的实测硬证据:隔离环境 `chain create` 未带 repository 被拒,错误逐字 `--config-json.repository must be a non-empty string`(未触达 daemon 即被 CLI 边界拒绝)。其余为本线程补验:

| ID | 判定 | 证据 |
|---|---|---|
| D1 四符号 | NOT_IMPLEMENTED(未退役) | DEFAULT_PRESET_NAME(daemon.ts:408/loop.ts:79,行为路径 daemon.ts:2176、loop.ts:5572);REPOSITORY_REF_PATTERN(daemon.ts:429,行为路径 4751);normalizeQueueIssueId(loop.ts:4371,调用 4021);inferRepositoryFromGit(loop.ts:4348,调用 4181) |
| D2 `--issue`→`--item` | NOT_IMPLEMENTED | `--issue` 仍是 item 面主 flag(loop.ts:280 注释自认 backward compat;1735-1919 五处 parseRequiredItemId(args.issue));`--item` 仅存在于 logs 过滤参数且解析为整数(loop.ts:1379) |
| D3 issueNumber 等 | PARTIAL | wire 层 `issueNumber` 整数选择器已退役(daemon.ts:471,3576,5835 注释链);runtime-paths.ts:82-185 仍以 issueFile/issueEvidenceDir 命名;`parseUmbrellaRef`/`umbrellaRepo` 生产符号未逐一复查(02 粗查:umbrella 值已迁 bindings #457) |
| D4 unblock wire 字段 | NOT_IMPLEMENTED | `QUEUE_UNBLOCK_ARG_KEYS = ["chainId","chainName","name","issue","dryRun","agentCredential"]`(daemon.ts:532)——仍是 `issue`,未改 `itemId` |
| D5 chains 表 | NOT_IMPLEMENTED(retirement 未做)| `repository TEXT NOT NULL` 物理列仍在(sqlite-state.ts:608-618);**`preset TEXT` 已可空**;repository owner/repo 强校验 + 控制字符/长度/保留段检查(daemon.ts:4745-4760) |
| D6 非 GitHub chain 可建 | NOT_IMPLEMENTED | codex 实测:缺 repository 在 CLI 边界即拒(见上);格式非 owner/repo 在 daemon.ts:4751 拒 |
| D7 metadata.bindings | IMPLEMENTED(通路在) | 写入 loop.ts:2193,5538;消费 daemon.ts:2189,5925(#457/#433 已落地) |
| D8 migration 清单 | 未逐版本核对 | STATE_SCHEMA_VERSION=16(sqlite-state.ts:810);统一 `PRAGMA user_version` 写入(1086);v13→v16 各版本变更未逐一核对——**草稿"v13→v14"预设已失效** |
| D9 item id 校验 | PARTIAL | `queue unblock` CLI 路径仍走 normalizeQueueIssueId(loop.ts:4021);item add 路径为 opaque `parseRequiredItemId`(1735 等)——同一 CLI 内两套并存 |
| E1 seed 语境 | NOT_IMPLEMENTED(退役未做),语义已弱化 | daemon.ts:2168 注释:"Since #412, chain.preset is a legacy default-seed: it no longer drives any item's preset";未传→seed 默认名(2176),显式 null→presetless(2178-2183) |
| E2 presetless 下游 | PARTIAL | `chain.preset = null` 合法且被显式保持:scheduler.ts:518(无 item 且 preset null 时跳过)、3239(仅无 item 时咨询 chain.preset);无点名报错路径核对 |
| E3 chain 层树/join 声明位 | NOT_IMPLEMENTED | chain metadata 无 tree/join 声明位;chain-complete 仍是 v2 fingerprint 机制(daemon.ts:645-719 chainCompleteTrigger) |
| E4 baseBranch | IMPLEMENTED(engine 一等) | scheduler.ts:908-909 resolveClosureBase(chain.baseBranch)、1107;chains.base_branch NOT NULL |

## 组 4:D3/D5/D10(codex task-ms5sf4j0-uxinxx,要点转录)

**H 任务树**:
- H1 NOT_IMPLEMENTED:`PresetTomlBoundary` keys = `name,item,runtime?,statuses,phases,fragments?,agent?`,无 seq/par/tree 声明位;compile 从线性 phases 合成退化 seq 投影(`src/loop.ts:2915,2935-2952`),非 DSL 声明。
- H2 PARTIAL:运行态 ADT 完整(leaf/seq/par、cursor、reopen、join evaluation epoch/bindingVersion);`JoinValueSnapshot` 仅 `drain | validator`,无 script/best-of-n(`src/task-runtime.ts:3-55`)。
- H3 PARTIAL:七张树表齐(`src/sqlite-state.ts:661-725`);`task_join_bindings` 有 `(par_node_id, version)` 版本键、源码只 INSERT/SELECT 无 UPDATE,**但无追加新版本的生产 API、无禁改 trigger**——append-only 是事实性而非强制性。
- H4 PARTIAL(**修正 02 文档结论**):`createTaskTree` 显式调用全在 fixture/测试;**但生产路径存在自动物化**——`ensureRuntimeClosure` 在记录 run 时自动创建/追加线性 seq root + phase leaf(`src/sqlite-state.ts:1643-1647,2292-2335`),输入来自 scheduler 写入的 source hash + phase 列表(`src/scheduler.ts:1607-1626`)。不存在把一般 seq/par 定义编译实例化成完整运行态树的路径。
- H5 PARTIAL:scheduler 读树处理 closure/worktree/reachability,但**调度推进仍按 v2 线性 phase 数组 index**(`buildPhasePlanFromPreset`,`src/scheduler.ts:592-623,685-712`);无按 SeqCursor/par join 推进的生产调度;无「非退化 par 点名拒绝」guard。
- H6 NOT_IMPLEMENTED:TransitionPath/pathId 零命中。
- H7:issue-558 脚本验收迁移(v13/v14→v16)、递归 seq/par status 投影、closure lifecycle、run/task identity、observability identity;issue-560 脚本验收 C01-C10 closure/worktree 全生命周期(资源隔离、fresh base、resume 连续性、reachability/consume、par pin、reconciliation、daemon restart、Git 并发协调)。

**I gate**:
- I1 PARTIAL:`GATE_DECISION_POINTS = run.pre-spawn / run.post-exit / item.status-transition / container.advance / chain.complete / daemon.startup / daemon.shutdown / tick`;GateHookDeclaration(onFailure: hold|advance;tick 带 minIntervalMs)、PresetHookPlaceholder 类型齐。四层来源:global=`<loopDataRoot>/hooks.json`(daemon 启动加载 `src/daemon.ts:1235-1244`);chain=`chains.metadata.hooks`(`src/runtime-data.ts:107-125`);preset=placeholder 参数**无生产 loader**(`src/daemon.ts:1215-1232`);item=`items.extra.hooks`(`src/runtime-data.ts:159-176`)。
- I2 NOT_IMPLEMENTED:preset TOML 无 gate/hook 声明位;placeholder 构造仅测试。
- I3 NOT_IMPLEMENTED:compile 产物无 gate 投影(实跑 gate_hits: [])。
- I4 NOT_IMPLEMENTED:无 unsupported-capability 握手。
- I5 PARTIAL:声明解析、四层 view、JSON 序列化在;**gate script 不执行**——daemon/scheduler 无 spawn/execute/timeout/decision/hold-advance 路径,`.script` 只在 `src/hook-declarations.ts:110-166` 解析/序列化。

**J 定义 pin**:
- J1 IMPLEMENTED:Ref ADT + 严格 boundary(`arkType.or` 两 variant + hasExactKeys,`src/task-runtime.ts:3-11,60-69,100-110`)。
- J2 PARTIAL:表是 identity registry/外键锚点,**不存定义内容**;唯一 INSERT 处 `semantic_hash = content_identity` 占位(`src/sqlite-state.ts:2359-2361`)。
- J3 PARTIAL(**修正 02 文档结论**):生产 preset identity 是**真实内容寻址**——compile 对源文件相对路径+bytes 做 SHA-256(`src/loop.ts:4683-4707`),scheduler 用 `loaded.preset.sourceHash`(`src/scheduler.ts:3438-3440`)。但 hash 对象是源目录文件集合而非 compiled projection;boundary 只要求非空字符串,fixture 可传任意值。
- J4 PARTIAL:**resume 从当前加载的 preset 重渲染,不按持久化 definitionRef 取定义**(`src/scheduler.ts:1583-1590,1658-1672,3128-3142`;resolver 按当前 `item.presetPath`/bundled 名加载 `src/daemon.ts:4430-4465,4586-4603`);daemon 单进程内按路径缓存 materialized preset 相对稳定,**重启后重读当前源**。
- J5 NOT_IMPLEMENTED:无「定义缺失→hold」;preset 加载失败走普通 spawn-preparation error(`src/daemon.ts:4475-4497`),回到当前文件。
- J6 PARTIAL:status 完整暴露 TaskTreeSnapshot 各节点 definitionRef(`src/loop.ts:936-945,3155-3175`);observability event identity 含 runtimeNodeId/definitionRef/definitionNodeId(`src/observability.ts:230-237,289-295`);hook 无执行路径故无 payload。

codex 总结:D3 定义面未实现、运行态部分实现(join variant 与 mutation API 不完整)、接线只有线性自动物化;D5 声明类型与三层存储在、preset DSL/投影/握手/执行未接通;D10 有源 hash 与 identity 投影、无定义内容存储、resume 读当前 preset、无缺失 hold。
