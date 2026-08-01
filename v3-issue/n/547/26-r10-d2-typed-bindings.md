# RFC 547 R10/D2 — Typed bindings 需求侧推导

> 只读输入：`AGGREGATE-547.md` D2、`24-r9-expected-foundation.md` D2 与 Gate-1/2/3/4/7/8，以及 R5 binding 供给摘要 A-05—07、D-07—12、T-03、J-01/J-04。本文不读源码、不复用旧 issue 边界、不估规模、不新增需求。冻结裁决：`ValueType = string | number | boolean | null | array | record | union`，无 opaque json；structured projection 为 canonical JSON inline；本文不得重开。

## A. 主 agent 摘要（≤1页）

D2 的唯一业务链是：

`source schema → binding candidate → admission plan → admitted binding storage → resolved value → render projection → typed exit candidate → transition consumption`

链上只有 source schema 解释类型；binding value 不携带第二套类型定义。外部输入先以 unknown 进入 boundary，解析成功后成为与 source、owner、definition ref 绑定的精确 value。missing 是输入状态而非 `ValueType`；`null` 是显式合法值，仅在 schema 接受 null 时成立；default 只在 missing 时应用，绝不覆盖 null 或 type mismatch。

现有地基可直接复用 source tagged union、known-root/runtime ownership、unknown-first boundary、JSON-safe persistence、batch/create 事务和 migration 保真。修补后可复用 Gate-1 tagged definition/schema identity、Gate-2 pure plan + 单一 create 事务、Gate-3 typed migration/hold、Gate-4 typed transition consume 与 Gate-7 schema artifact。D2 自建精确 source declaration、candidate parser、admission/result ADT、stored binding identity、resolver、projection、typed exit validation/CAS及其错误分类；D2只为typed value定义canonical scalar/JSON value serialization。`DocRenderDeclaration`、layout、唯一doc renderer与render layout errors全部由D6拥有。

D2 不拥有doc renderer/layout、tool outcome/finalize runtime、gate evaluator/journal、task scheduler或remote repository adapter。具名 dependency 只有：typed ChainDefinition provider 提供chain-level source declaration/ref；independent schema consumer仅承担跨owner schema proof，不是运行时authority。D6通过明确接口消费D2 canonical value serialization；地基仍未闭合的 Gate-2 constructor/rollback recovery、Gate-3 legacy repair、Gate-4 transition journal 和 Gate-7 independent consumer 不能被 D2 文档冒充完成。

原子需求共 **20** 项。完成语义是这些需求被实现且按各自最早可决定边界验证；本文不声称任何运行验证已通过。

## B. 原子需求

### B1. 类型、source 与 identity

| ID | 原子需求 | 读/写与 authority | 匹配与验证 |
|---|---|---|---|
| D2-R01 | source declaration 必须引用唯一 source schema；use-site 仅含 source ref、owner、required/default/projection 与兼容 expectation，不得再定义类型。 | 读 immutable definition/schema；写 compiled source declaration。source schema 唯一 authority。 | compile：同一 source 多 authority、未知 source、非法 owner typed reject；schema round-trip。 |
| D2-R02 | `ValueType` 只允许冻结的七类递归闭集；record 为 closed fields，union 非空；opaque json、隐式 optional、untyped map 禁止。 | compiler 读 source syntax；写 canonical ValueType ADT。 | compile：每个 variant 正反例、递归 round-trip、unknown variant/version reject。 |
| D2-R03 | 每个 binding 使用稳定 `BindingIdentity = DefinitionRef + SourceIdentity + OwnerScope + BindingKey`；display name、路径、当前位置和 raw map key 不得替代。 | admission/resolver/transition 只读该 identity；storage 按 identity 唯一写。 | create/update：重复 identity、跨 definition/source/owner 写入 reject；restart 后 identity 不变。 |
| D2-R04 | binding 状态使用 ADT：`missing | candidate(raw) | admitted(value,provenance) | held(error)`；missing 不进入 ValueType，null 仅为 admitted value variant。 | boundary 写 candidate/missing；admission 写 admitted/held；内部不再读 raw。 | boundary/property tests 穷尽 variant；禁止 `null|undefined→""`。 |

### B2. Candidate、missing/default/null 与 admission

| ID | 原子需求 | 读/写与事务 | 匹配与验证 |
|---|---|---|---|
| D2-R05 | 所有 CLI/API/file/migration candidate 先以 unknown 解析；成功后保留 source identity、owner、origin 与原始提交 identity，禁止先 stringify。 | boundary 读 raw；pure parser 产 typed candidate 或 structured error；无 DB 写。 | number/boolean/null/array/record/union 各入口正反例；错误含 source/key/path。 |
| D2-R06 | missing 判定只表示 source 未提供值；required+missing 失败，optional+missing 保持 missing，存在 default 时仅把 missing 解析为该 schema 下的 admitted default。 | admission plan 读 declaration/candidate；写 planned result。 | required/optional/default 矩阵；空串只作为显式 string candidate。 |
| D2-R07 | 显式 null 不触发 default；schema 接受 null 才 admitted，否则 type mismatch。union 中 null 按普通 variant 穷尽匹配。 | pure admission 读 candidate/value schema；无旁路 coercion。 | missing/null/default 交叉矩阵及 nullable/non-nullable tests。 |
| D2-R08 | type validation 必须递归到 array element、record field、union variant；closed record 拒绝额外字段并以 value path 定位错误。 | admission plan 产 refined value 或 non-empty diagnostics。 | nested path、multiple errors、union no-match/ambiguous policy 的确定性测试。 |
| D2-R09 | create 前完成全部 binding admission、definition integrity 与 consumer-required compatibility；任一 deterministic error 不进入 retry，也不产生部分 instance。 | Gate-2 pure plan；失败零 DB business rows。 | create failure 后 row/ref/binding/runtime/outbox 均不可见。 |
| D2-R10 | batch create/update 先对全部对象生成完整 plan；任一 plan 失败则整批零写。 | 单一 `BEGIN IMMEDIATE` 写入所有 admitted bindings及同批业务 rows。 | 多 item 中间失败 rollback；重试同输入结果一致。 |

### B3. Storage、读取与 candidate replacement

| ID | 原子需求 | 读/写与事务 | 匹配与验证 |
|---|---|---|---|
| D2-R11 | admitted storage 保存 BindingIdentity、canonical typed value、source schema/ref、owner、provenance 与 definition ref；不得只存字符串或丢 declaration metadata。 | Gate-2 create 事务与 row/ref/runtime/outbox rows 同写。 | DB round-trip 每个 ValueType；事务失败全部 rollback。 |
| D2-R12 | runtime resolver 只从 pinned definition 与 admitted storage 解析；current source、chain/default fallback、environment guessing 和 repository/git inference 均禁止。 | 读 verified tagged ref 与 admitted rows；无写。 | restart/resume 更改 current 后值不漂移；missing/corrupt ref typed hold。 |
| D2-R13 | candidate patch/replacement 必须提交完整 replacement value，以 expected admitted revision/identity 做 CAS；成功前重新执行同一 schema/owner/required validation。 | pure plan 后单事务 compare-and-swap；失败不改旧值。 | stale CAS、跨 owner、type mismatch、duplicate replay、成功 replacement。 |
| D2-R14 | binding update 与其派生 consumer invalidation/outbox rows 在同一事务提交；commit 后只 dispatch 已持久化 outbox，不以 event 作为 value authority。 | transaction 写 binding revision + derived rows/outbox；dispatch 只读。 | crash-before/after-commit recovery；无重复业务更新。 |

### B4. Render 与 typed exit

| ID | 原子需求 | 读/写边界 | 匹配与验证 |
|---|---|---|---|
| D2-R15 | 为 admitted typed value 提供唯一canonical value serialization：scalar按类型转canonical文本，structured value转单行canonical JSON；不决定block/fence、doc layout或renderer选择。 | D2 serializer只读admitted typed value并输出canonical value text；D6的唯一doc renderer读取该结果及其`DocRenderDeclaration`。 | D2验证scalar/JSON的key order、whitespace与nested structure确定性；renderer/layout选择及render layout errors由D6验证。 |
| D2-R16 | projection 必须保留 binding identity、ValueType、source/owner、required/default/projection metadata；public projection 的 `type=string` 或空 tools shape 不得代替真实声明。 | schema/public boundary 读 canonical declaration；写版本化 projection。 | projection/boundary round-trip；unknown schema version reject。 |
| D2-R17 | runner 提交的 `exit.*` 先按 pinned exit source schema 解析为完整 candidate；只能写 agent-owned exit namespace，不能覆盖 item/chain/runtime/external bindings。 | transition boundary 读 pinned schema/current run；写 typed exit candidate。 | owner violation、foreign run、missing required exit、nested mismatch reject。 |
| D2-R18 | typed exit candidate 与 TransitionId 做 idempotent CAS；只有完整 validation 成功的 transition 才原子写 admitted exit value并推进业务状态，runner exit fact 本身不推进。 | Gate-4 transition transaction 同写 exit binding、transition/domain-ref consumption/outbox。 | duplicate replay、stale run、partial exit、crash recovery；一次业务推进。 |

### B5. Migration、hold、错误与 consumer 保证

| ID | 原子需求 | 读/写与恢复 | 匹配与验证 |
|---|---|---|---|
| D2-R19 | legacy raw binding 只有在目标 DefinitionRef 与 source schema 可证明时才迁移；missing/schema unknown/incompatible 保持 typed hold，不填空串、零值、null 或 current default。repository staging 不解除 definition hold。 | Gate-3 migration 先全量 plan；conflict 时整 migration 零写；repair 走显式事务。 | 63 个候选值只做 value-level reversible 检查；unknown/incompatible/dual-source conflict 分别验证。 |
| D2-R20 | consumer 只能接收 `admitted(value)` 或具名 typed failure/hold；不得接收 raw candidate、untyped JSON、silent missing 或 fallback value。错误至少区分 missing-required、type-mismatch、unknown-source/schema-version、owner-conflict、stale-CAS、legacy-definition-unproven、missing/corrupt ref。 | compile/admission/render/transition/migration 各在最早边界决定；deterministic error 不 retry，dependency/hold 等待外部状态改变。 | consumer contract tests 覆盖 render、runtime resolver、typed exit；error variant exhaustive，无 catch-all。 |

## C. 供给与责任匹配

| 分类 | D2 使用方式 | 不得升级为 |
|---|---|---|
| 24 地基已供 | source tagged union、known-root/runtime ownership、unknown-first boundary、JSON-safe persistence、batch/create事务、migration保真；doc product/renderer仅作为D6-owned相邻接口 | 不证明source schema已权威、admission已typed、typed exit已存在或D6 renderer已接线 |
| 修补后复用 | Gate-1 tagged schema/definition identity；Gate-2 pure plan/单事务/outbox；Gate-3 migration hold；Gate-4 transition consume；Gate-7 versioned schema artifact | 在相邻 Gate 未实现前不得写成当前资产 |
| D2 自建 | R01–R20 中source declaration、ValueType boundary、binding identity/state、parser/admission、storage/resolver、CAS、projection、canonical scalar/JSON value serialization、typed exit、migration/error contract | 不扩张到`DocRenderDeclaration`、layout、doc renderer、render layout errors、scheduler、tool/gate journal或remote adapter |
| 具名 dependency | typed ChainDefinition provider 提供 chain-level source declaration/ref；independent schema consumer 提供跨 owner schema proof | issue 号或 consumer 实现不得成为 D2 runtime authority |
| 地基未闭合 | Gate-2 constructor/rollback recovery、Gate-3 legacy repair、Gate-4 transition journal、Gate-7 independent consumer、真实 create→render→exit integration | 文档、unit、fixture 或 generic JSON round-trip不得替代运行证明 |

## D. 验证分层

| 最早可决定点 | 必须验证 |
|---|---|
| compile | source authority、ValueType、default、owner、projection schema、duplicate/unknown declaration |
| boundary/admission | unknown→candidate、missing/null/default、recursive type path、required、完整 plan |
| create/update transaction | row/ref/binding/runtime/outbox 原子性、batch rollback、CAS、revision |
| runtime/value serialization | pinned resolver、canonical scalar/JSON、无fallback、D6 renderer只接收admitted value的canonical serialization |
| transition | typed exit owner/schema、TransitionId CAS、单次业务推进、restart replay |
| migration/recovery | schema-proven repair、typed hold、conflict zero-write、commit/outbox crash points |
| cross-owner/integration | typed ChainDefinition provider source ref；independent schema consumer version proof；真实 create→render→exit 全链 |

## 尾结论

**D2 的 20 项原子需求把冻结的 ValueType 与 canonical JSON 裁决贯穿 source schema、candidate、admission、同事务 storage、pinned resolution、render 和 typed exit；missing/default/null、CAS、migration hold 与错误恢复均在最早可决定边界定义。现有地基只提供可复用槽位，typed ChainDefinition provider 与 independent schema consumer 是具名边界依赖；Gate-2/3/4/7 及真实 create→render→exit 仍未闭合，不得声称已交付。**
