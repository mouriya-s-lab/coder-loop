# RFC #548 R10 — engine schema/invariant 与 durable request record 需求侧推导

## A. 主 agent 摘要（≤1页）

### 结论

预期地基只闭合了两类输入：preset 侧应提供 **field type/required 的权威归一模型**，以及既有 engine 侧已有本机 socket=operator、单次 SQLite mutation、`(chain,itemId)` 唯一性等窄事实。它没有自动交付 RFC #548 已裁的公共 schema、完整合成模型、持续写 gate、startup 隔离/修复、公共 rejection ADT 或逐请求 durable record。后六项都是本能力必须新建的 engine 公共保证，不能由 compile projection、opaque `extra`、SQLite UNIQUE 或 best-effort events 冒充。

需要的新保证分成五个互不替代的边界：

1. **schema producer：** 从同一次权威模型快照生成有独立身份/版本的真正 JSON Schema；合成 preset-owned 与 engine-owned 子模型，表达 required、unknown policy 与调用方可写性；projection 不承担 schema 身份。
2. **write gate：** add、batch-add、所有改变 `extra` 的写入及任何重入可执行态，在提交同一新持久态前使用同一合成模型校验；非法状态零提交，内部 control-key 写回也不能绕过 gate。
3. **startup reconciliation + repair：** scheduler/spawn 开放前扫描所有可能再次执行的 item；每个非法 item 的原因与不可启动资格 durable、跨重启，并与调度资格一致。operator repair 原子替换目标现存 preset、完整 `extra` 与资格；失败不留半状态，成功才清除原因。
4. **CLI typed rejection：** 公共 CLI ADT 与内部 socket envelope 分离，但穷尽、无损表达失败分类、字段细节、already-existing/no-op 等判定；未知内部 variant 必须 fail closed，不能压成文本。
5. **request identity / audit linearization：** engine 收到且可关联的每个请求只有一个 durable typed verdict；created 的 record 与 mutation 同成败，already-existing/no-op/rejected 也必须有明确读判定线性化点。request identity 只关联一次 engine 请求记录，不取代规范工作身份 `(chain,itemId)`，也不取代消费 daemon 的 delivery identity/业务账本。

仍未闭合的地基有三处。其一，preset 权威模型预计只给 preset field type/required，**engine-owned 字段分类、类型、可写性及两者冲突规则尚无已供事实**。其二，“每个请求 durable”与边界 parse 存在先后问题：若 request identity 不能在业务 payload 解析前可靠取得，则 malformed 请求无法满足可关联记录；identity 的稳定性、重复 identity 的返回语义与保留期也未闭合。其三，startup scan、正常写、repair 与 scheduler 的共同并发屏障尚未给出；没有该屏障，单独拥有 validator 或事务仍无法证明“所有可执行 item 始终合格”。这些是待承载的能力缺口，不是选库、表或命令名的问题。

### owner 边界

- **RFC-2 / preset 权威模型：** 供 preset field type/required 的单一归一解释；不负责 #548 的 CLI wire、engine control model、持久 gate、修复或 request audit。
- **本 RFC engine 能力：** 负责合成 schema producer、公共 CLI ADT、所有 engine 写/重入 gate、startup reconciliation、operator repair 和 durable request record/查询读面。
- **消费 daemon：** 从 CLI schema 派生类型、做树外预校验，并保留 delivery/mapping/verdict/blocker 业务账本；不得把 engine request record 当 delivery 账本。

---

## B. 逐条需求 → 地基 → 缺口 → owner 边界与证据

### B1. schema producer

| 原子需求 | 预期地基已供 | 本能力必须新建 | 地基仍未闭合 / owner 边界 | 证据 |
|---|---|---|---|---|
| 权威输入 | RFC-2 预期提供 preset field type/required 的归一模型 | 只从该模型与 engine control model 生成 schema；不得另写平行字段解释 | engine control model 尚未被地基提供；其 owner 是本 RFC engine 能力 | `AGG-548.md:254-256,269`; `expected-foundation.md:9-11,25` |
| artifact 身份 | 现有 compile projection 只是一份实例投影 | schema document 具有与 projection 分离的种类身份、preset identity 和可检查版本 | schema version 的兼容/拒绝关系尚无消费协议事实 | `AGG-548.md:101,108,320-321,329`; `detail-r7-01-schema-validation.md:14,22,69-95` |
| 完整合成 | 裁决已固定两个权威子模型 | 合成后的单一严格 schema 覆盖整个持久化 `extra` | 子模型同名冲突、组合失败和 engine key 分类仍须显式闭合；不得由 preset 模型猜测 | `operator-decisions.md:91-100`; `expected-foundation.md:16`; `detail-historical-extra-migration.md:12-25` |
| 字段语义 | preset field object 是 required 权威；旧语法默认 required | 输出字段类型、required、unknown-field policy，并保持旧语法归一后等价 | optional/required 不能在 loader、artifact、validator 三处分别解释 | `operator-decisions.md:16-35`; `AGG-548.md:102` |
| 可写性 | 裁决允许外部看见 engine-owned 字段 | schema/配套 ADT 明确 caller-writable 与 engine-maintained；外部不能写只读 control key | JSON Schema 如何承载该契约是实现选择，但可写性保证不能缺席 | `operator-decisions.md:97-99`; `AGG-548.md:101,104` |
| 一致快照 | 无现成跨 producer/loader 的版本协商保证 | 一次 schema 输出必须对应一个确定的 preset + engine model 快照，禁止半新半旧组合 | preset 文件在运行间可漂移，item 无创建时 schema identity；不能假装已有冻结 schema | `detail-historical-extra-migration.md:43-45`; `expected-foundation.md:9,16` |
| 可观察读面 | PATH CLI 已裁为跨仓协议 | 成功输出可由机器稳定读取；版本/identity 可供消费端拒绝失配 | 跨仓类型派生和真实预校验仍属消费端验证，不由 engine 内测替代 | `operator-decisions.md:3-13`; `AGG-548.md:103`; `expected-foundation.md:31-33` |

### B2. 持续 write gate 与可执行态不变量

| 原子需求 | 预期地基已供 | 本能力必须新建 | 地基仍未闭合 / owner 边界 | 证据 |
|---|---|---|---|---|
| 写入口完备性 | 现有 add/batch/update/store 各自存在，单次 DB write 有事务地基 | 枚举并封闭所有能改变 `extra`、preset 或执行资格的生产入口，统一调用同一合成 gate | 当前低层 store、scheduler control 写回均可绕过 schema；入口清单不能只覆盖 CLI | `operator-decisions.md:37-46`; `detail-historical-extra-migration.md:29-40`; `expected-foundation.md:11` |
| 校验—提交原子性 | 现有普通 store mutation 使用 immediate transaction | 校验所依据的目标 preset/model 与写入的新 preset/完整 `extra`/资格在同一事务语义内决定并提交 | 事务若只包 UPDATE、而 model 在事务外漂移，仍不能证明同一解释；需共同一致性条件 | `detail-historical-extra-migration.md:73-77`; `AGG-548.md:104` |
| 非法状态零提交 | JSON safety/size 与 top-level request gate 是窄资产 | missing、unknown、type mismatch、不可写 engine field 任一失败均保持原 row 与资格不变 | 现有 gate 不对照 preset field map，不能提升为本保证 | `detail-r7-01-schema-validation.md:16,28-30,128-164`; `AGG-548.md:104` |
| engine 内部写回 | engine-owned control keys已有实际 producer | 内部写回亦须构造完整合法新状态；不得因主体是 scheduler 就豁免 business remainder | 合成模型必须区分内部可写与外部可写，但二者共享持久态合法性 | `detail-historical-extra-migration.md:12-15,29-40`; `operator-decisions.md:107-112` |
| 重入 gate | terminal/deleted 可保留历史快照 | 任何 resume/retry/未来重入可执行态入口先校验；不合格则保持不可启动 | “可再次执行”的状态集合来自 preset vocabulary，不能硬编码单一 status 字面量 | `operator-decisions.md:118-124`; `AGG-548.md:106`; `expected-foundation.md:18,26` |
| 并发线性化 | SQLite UNIQUE/事务仅保护各自 mutation | 并发 add/update/repair/re-entry 对同一 item 必须有唯一提交次序，后提交基于未过期状态/model | 只做事务外 validate-then-write 会产生 TOCTOU；共同冲突/重试语义未由地基提供 | `detail-r7-02-replay-verdict.md:115,119,135-145`; `expected-foundation.md:31-34` |

### B3. startup reconciliation 与不可启动状态

| 原子需求 | 预期地基已供 | 本能力必须新建 | 地基仍未闭合 / owner 边界 | 证据 |
|---|---|---|---|---|
| 扫描量词 | 裁决限定 active、stopped、可 resume/retry；归档快照例外 | 从权威状态模型判定“可能再次执行”，不误标 terminal/deleted-chain item | 未来状态/重入入口增加时必须穷尽更新，不能用 catch-all 掩盖 | `operator-decisions.md:118-124`; `AGG-548.md:106` |
| 启动屏障 | daemon 有 startup 生命周期，但没有此 reconciliation 保证 | 在 scheduler tick、resume 与 spawn 可发生前完成资格核对；扫描期间非法 item 零调度 | startup、scheduler、外部 repair/写入的互斥或版本屏障仍未闭合 | `operator-decisions.md:102-113`; `expected-foundation.md:17,34` |
| durable 标注 | item 已持久化，现有 events 可作窄观察 | 每个不合格 item 持久化不可启动资格和 typed 原因；原因跨重启可重建且不依赖 JSONL | reason 必须覆盖 missing preset/schema drift/字段错误，不能只留文本日志 | `AGG-548.md:106`; `expected-foundation.md:17`; `detail-r7-03-admission-audit.md:3-24` |
| crash/restart 收敛 | SQLite 已提交/未提交有原子恢复基础 | crash 后重扫不得短暂放行未核对 item；部分扫描结果不得与开放 scheduler 形成混合可执行集合 | 逐行 scan 若无进度/epoch，preset 在重启间变化会改变结论；需要明确 reconciliation epoch/屏障语义但不预选存储 | `detail-historical-extra-migration.md:73-88`; `expected-foundation.md:34` |
| 观察一致性 | status/list/CLI 是已有当前态读面候选 | operator 能读到不可启动、原因、目标 preset/schema identity 与修复后资格；scheduler 使用同一资格事实 | event 存在不能作为资格事实；读面与调度判定不得各算一次 | `detail-r7-03-admission-audit.md:82-129`; `AGG-548.md:106` |

### B4. operator repair 的授权与原子恢复

| 原子需求 | 预期地基已供 | 本能力必须新建 | 地基仍未闭合 / owner 边界 | 证据 |
|---|---|---|---|---|
| 主体边界 | 本机 daemon socket 沿用 operator 信任；不新增第三方主体 | repair 只暴露在显式 operator 面；agent credential 与树外 payload 不能取得该权限 | 具体命令名不在需求侧；必须沿现有 operator/agent admission 边界证明拒绝 | `AGG-548.md:35,307`; `operator-decisions.md:136` |
| 全量输入 | 裁决已禁止逐字段猜值/自动转换 | 请求同时给出目标现存 preset 与完整合成 `extra`；engine 不生成缺失业务值 | 历史类型转换无 schema 可推导语义，不能自动 rewrite | `operator-decisions.md:126-136`; `detail-historical-extra-migration.md:23-25` |
| 单事务效果 | SQLite 单次 mutation 有事务地基 | 校验目标 model，并原子提交 preset、完整 `extra`、清除不可启动原因、恢复资格；任一失败全部不变 | preset load/model identity 与 DB commit 的一致快照仍需闭合 | `AGG-548.md:107,111`; `expected-foundation.md:19,27` |
| 并发保护 | 无 repair 专用保证 | 与 scheduler、普通 update、另一 repair 线性化；不能修复基于旧 row 后覆盖较新合法状态 | 冲突表达必须进入 typed rejection，而非 silent last-write-wins | `expected-foundation.md:19,34`; `detail-historical-extra-migration.md:75-77` |
| 审计关联 | D7 要求 engine request record | repair 也产生 request identity、typed rejected/changed/no-op verdict，并与 mutation 同 durability | best-effort event 可互证但不能替代 repair record | `operator-decisions.md:84-89,129-136`; `AGG-548.md:229-230` |

### B5. CLI 独立 typed rejection ADT

| 原子需求 | 预期地基已供 | 本能力必须新建 | 地基仍未闭合 / owner 边界 | 证据 |
|---|---|---|---|---|
| 公共身份 | socket 已有内部 `{code,message,details}`；CLI 已有 exit/stdout/stderr 面 | 定义独立公共 rejection union，不复制内部 envelope，不以 `code: message` 作为 wire | CLI success ADT 与 rejection 的输出/exit 分工仍需契约化，不选具体序列化库 | `operator-decisions.md:48-57`; `detail-r7-01-schema-validation.md:22,128-132` |
| 穷尽转换 | 内部错误已有若干 typed code/details | socket response→CLI variant 穷尽转换；新增/未知内部 variant fail closed，不静默丢 details | 当前通用 CLI 压平 details，不能作为地基完成态 | `AGG-548.md:105,109`; `detail-r7-01-schema-validation.md:209-222` |
| 最小 variants | 已裁错误集合与规范工作身份 | 至少区分 missing required、unknown、type mismatch、missing preset、不可写 field、already-existing、并发冲突及 request identity 冲突，并保留定位细节 | already-existing 是“规范工作已接管”，不是普通 schema reject；公共 ADT需保留该语义 | `AGG-548.md:105,115-119`; `operator-decisions.md:59-69` |
| 无非法副作用 | DB transaction 是窄基础 | rejection 的 durable request record 与零 mutation 可同时证明；调用方断连不改变最终 durable verdict | 单凭 CLI exit不能证明 commit与否，必须由 request query/record互证 | `detail-r7-02-replay-verdict.md:18,135-145,182`; `AGG-548.md:139,230` |

### B6. durable typed request record 与 mutation durability

| 原子需求 | 预期地基已供 | 本能力必须新建 | 地基仍未闭合 / owner 边界 | 证据 |
|---|---|---|---|---|
| request identity | D7 已裁稳定、可关联 identity；`(chain,itemId)` 已裁为工作 identity | 公共请求在业务判定前携带/取得稳定 request identity；相同 identity 重查得到同一 durable verdict | request identity 不等于 work identity，也不等于 deliveryId；三者映射与 malformed-before-identity 情形尚未闭合 | `operator-decisions.md:59-69,82-89`; `AGG-548.md:119,139,229` |
| verdict ADT | 已裁 created/already-existing/rejected/no-op | 每条 record 只处于一个穷尽 verdict variant，保存判断所需 identity、分类与必要细节 | 不得把 rejected/no-op 塞成 message；variant 扩展需编译期 worklist | `operator-decisions.md:84-89`; `AGG-548.md:139,239` |
| created 线性化 | 单次 DB mutation已有事务 | created record 与对应 mutation 同 commit/rollback；不存在 item 已创建但 record 缺失，或 record=created 但 item 未提交 | 文件 events 与 reply 在事务外，不能参与该证明 | `detail-r7-03-admission-audit.md:25-47`; `expected-foundation.md:15,28` |
| already-existing/no-op 线性化 | `(chain,itemId)` UNIQUE 提供至多一行 | 在一个稳定读判定点确认既存/无变化，并持久化对应 record；并发 create 竞赛最终只有一个 created，其余得到与最终事实一致的 verdict | 事务外 lookup 后写 record 会被竞态推翻；需同一串行化语义 | `detail-r7-02-replay-verdict.md:113-145,169-182`; `AGG-548.md:119,139` |
| rejected 线性化 | boundary parser 能拒绝部分输入 | 对能取得 request identity 的 engine 请求，typed reject record 必须 durable，且零业务 mutation | 完全无法解析 identity 的字节是否属于“可关联请求”需公共边界明确；这是当前地基缺口 | `AGG-548.md:230`; `expected-foundation.md:15,35` |
| 重放与唯一结论 | work uniqueness 已存在 | 相同 request identity 不得生成相反 verdict；重试返回/查询原 verdict，不能重新执行 mutation | request identity 冲突（同 identity、不同命令/目标）须 fail closed；保留/清理期尚需定义 | `AGG-548.md:139`; `operator-decisions.md:84-89` |
| crash/reply 窗口 | WAL 保证已提交事务恢复 | commit 后 reply 丢失时，caller 可按 request identity查询同一 durable verdict；未提交则不得留下完成 verdict | record 解决“结果可重查”，不声称 socket reply 与事务原子 | `detail-r7-02-replay-verdict.md:18,135-145`; `expected-foundation.md:35` |
| 观察与关联 | 当前 list/status 可见当前态；events 有窄 engine facts | operator/消费端可按 request identity读取 typed record，并与当前 item及消费 delivery log关联 | 当前 JSONL无 identity、可吞写、duplicate/no-op不完整，只可互证 | `detail-r7-03-admission-audit.md:3-24,82-129`; `AGG-548.md:229-230,318` |
| 范围隔离 | 消费 daemon另有 LOG-746/747 义务 | engine record只记 engine request/verdict/mutation；消费 daemon继续记录 deliveryId、映射、CLI args、verdict/blocker | 空 chain不承载 delivery verdict；engine record不得反向吸收 GitHub/delivery领域 | `AGG-548.md:120,138-140,229-230,240`; `expected-foundation.md:14,28` |

### B7. 事务与恢复的组合不变量

1. **schema snapshot invariant：** schema artifact、写 gate、startup 判定与 repair 对同一 model identity 的解释一致；版本漂移显式失败或重新 reconciliation，不能静默混用。
2. **executable-state invariant：** 任一可执行 item 在每个已提交状态都通过当前目标 preset 的完整合成 schema；历史快照只有在不可执行时例外。
3. **startup barrier invariant：** daemon 不在 reconciliation 完成前调度；不可启动标记是 scheduler 的权威资格输入，而非观察日志。
4. **repair invariant：** repair 成功 iff 新 preset、完整 `extra`、资格和清除原因共同提交；失败四者均不变。
5. **request/mutation invariant：** 对会 mutation 的请求，typed request record 与 mutation 同成败；对无 mutation 的判定，record 与其判定读点处于同一串行化语义。
6. **identity invariant：** delivery identity、engine request identity、规范 work identity 三者用途不同，只能显式关联，不能互相替代。
7. **observation invariant：** CLI reply可丢；durable query不得丢。events、stderr 与 current status只作互证，不能成为逐请求事实源。

### B8. 地基闭合判定

| 能力 | 判定 | 理由 / owner |
|---|---|---|
| preset field type/required 归一模型 | **预期已供** | RFC-2 owner；#548 只消费并验证其稳定 identity |
| 单次 SQLite mutation/唯一约束、本机 operator trust | **窄地基已供** | 可复用，但不足以推出跨 model、startup、audit 保证 |
| engine-owned field 权威模型与可写性 | **未闭合，必须新建** | #548 engine owner；不能由 preset 或历史 opaque `extra` 推导 |
| CLI JSON Schema producer/version contract | **未闭合，必须新建** | #548 engine CLI owner |
| 全写入口/重入持续 gate | **未闭合，必须新建** | #548 engine owner；需覆盖内部 producer |
| startup reconciliation、durable 不可启动、scheduler barrier | **未闭合，必须新建** | #548 daemon/store/scheduler共同保证 |
| operator 原子 repair | **未闭合，必须新建** | #548 operator CLI + daemon/store；沿现有 operator admission |
| CLI typed rejection ADT | **未闭合，必须新建** | #548公共 CLI；内部 socket envelope不是替代品 |
| durable request record/query 与 mutation linearization | **未闭合，必须新建** | #548 engine；events/UNIQUE/current status均不足 |
| delivery 决策账本与跨仓类型派生 | **树外 owner** | 消费 daemon负责；以 schema/request identity消费 engine能力 |

### B9. 证据回指与核对

- 稳定需求：`AGG-548.md:95-111,113-140,229-240,254-256,318-334`。
- 裁决：`operator-decisions.md:3-136`（D1-D11）。
- 预期地基与未证明项：`expected-foundation.md:9-41`。
- schema/CLI 实然缺口：`detail-r7-01-schema-validation.md:10-36,42-44,69-95,209-222`。
- replay、事务与 caller 不确定窗口：`detail-r7-02-replay-verdict.md:13-22,63-80,113-145,164-201`。
- events 审计证明力：`detail-r7-03-admission-audit.md:3-47,82-129`。
- 历史 `extra`、入口与 startup/事务事实：`detail-historical-extra-migration.md:8-25,29-45,73-95`。

核对：A 摘要位于分隔线前且不超过一页量级；B 按需求→地基→缺口→owner/证据展开；严格区分 schema producer、write gate、startup reconciliation、repair operator 权限与 request audit 线性化；未选库、命令名、表结构或规模；未读取源码、未实验、未实现、未重拆 issue；唯一写入为本报告。
