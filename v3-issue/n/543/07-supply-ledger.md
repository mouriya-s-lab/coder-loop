# RFC #543 · R5 供给统一总账

> 核算输入仅为 `04-supply-observer-payload.md`、`05-supply-gate-runtime.md`、`06-supply-persistence-binding-reopen.md`；分类框架来自 `aggregation.md` 与 `WORKFLOW.md` R5。未读取源码、未运行实验、未裁决冲突。

## A. 主 agent 摘要

- **覆盖结论：完整。** 三报告共登记 **150** 个原子账目：S1 60、S2 42、S3 48；每个条款行、未知、资产、测试有效/同错/盲区、影响、迁移或恢复事实均有唯一 ID。
- **总体形态：** 三报告互证“声明/身份/事务/closure 底料存在，但 observer、payload、统一 gate evaluator、journal、binding、script join/reopen 没有生产闭环”。资产逐来源保留，未因相似而吞并来源。
- **冲突：** 未发现事实互斥；发现 4 组边界/表述差异（I2 判定措辞、D2 重叠、fingerprint 两机制、closure/reopen 外部供给边界），均登记为待后续复核而未裁决。
- **R6 gate：** 未映射原子项为 0；没有因覆盖缺失阻塞 R6。静态未知仍是未知，不构成覆盖 gap。

## B. 统一总账

| Ledger ID | 类别 | 稳定条款/属性 | 原报告状态 | 观察事实与影响边界 |
|---|---|---|---|---|
| S1-C01 | 条款 | A1 | 偏离 | observer 仅声明，无匹配、spawn、diagnostic；测试反证执行。 |
| S1-C02 | 条款 | A2 | 符合 | observer point 由事件 union 结构减去 hook.*。 |
| S1-C03 | 条款 | A3 | 偏离 | 只有装载期拒绝，无发射期零派发防护。 |
| S1-C04 | 条款 | A4 | 偏离 | 现有五类 closure 事件不等于六条转移边，且无 observer 执行。 |
| S1-C05 | 条款 | D1 | 偏离 | global/chain/item 存储存在；preset 仅手工 placeholder，无 compiler producer/consumer。 |
| S1-C06 | 条款 | D2 | 偏离 | 层序 helper 正确但无执行、AND、hold/reopen 合成。 |
| S1-C07 | 条款 | E1 | 偏离 | canonical union 无 hook.*。 |
| S1-C08 | 条款 | E2 | 偏离 | status 无 hooks/hold/failure 投影。 |
| S1-C09 | 条款 | E3 | 偏离 | 无 observer failure event。 |
| S1-C10 | 条款 | E4 | 偏离 | 无 hook decision event。 |
| S1-C11 | 条款 | E5 | 偏离 | 无 hook hold/retry/fingerprint/key/evaluation events。 |
| S1-C12 | 条款 | F1 | 偏离 | 无 HookPayload boundary/assembler。 |
| S1-C13 | 条款 | F2 | 偏离 | compile/status/event 虽各有边界但未派生，status 仍有匿名 object。 |
| S1-C14 | 条款 | F3 | 偏离 | pinned definition 只有 identity，无完整 projection 存储/解引用 API。 |
| S1-C15 | 条款 | F4 | 偏离 | 无 payload 投影，不能直接透传开放 status shape。 |
| S1-C16 | 条款 | F5 | 偏离 | 无 payload/version。 |
| S1-C17 | 条款 | F6 | 偏离 | 无 payload schema 导出面。 |
| S1-C18 | 条款 | F7 | 偏离 | closure typed facts 未投影，事件 payload 不含全量 metadata。 |
| S1-C19 | 条款 | F8 | 静态不可判定 | payload 不存在；当前无 GitHub 字段不能证明未来负向契约。 |
| S1-C20 | 条款 | G1 | 偏离 | 事件记录不 spawn observer。 |
| S1-C21 | 条款 | G2 | 偏离 | 无 stdin write。 |
| S1-C22 | 条款 | G3 | 偏离 | timeout 仅声明，无 hook child/process-group 生命周期。 |
| S1-C23 | 条款 | G4 | 偏离 | observer/gate 共同执行层不存在。 |
| S1-C24 | 条款 | G5 | 偏离 | hook 路径不存在，无法证明 async/no spawnSync。 |
| S1-C25 | 条款 | G6 | 偏离 | 声明 matcher 来源正确，dispatch matcher 不存在。 |
| S1-C26 | 条款 | I2 | 偏离/证明缺口 | tuple 只覆盖声明 parser；新增 point 不会暴露 payload/evaluation/event 缺失消费者。 |
| S1-C27 | 条款 | I9 | 偏离 | 只有排序 helper，无生产 caller 或全点 AND。 |
| S2-C01 | 条款 | A5 | 偏离 | 无 gate evaluator/executor，不能 hold。 |
| S2-C02 | 条款 | A6 | 部分符合/执行偏离 | 八点名称闭集完整，生产挂点未物化。 |
| S2-C03 | 条款 | A7 | 声明符合/运行偏离 | closure 不在 gate union，但 post-exit gate 不存在，不能阻止 suspend。 |
| S2-C04 | 条款 | B2 | 偏离 | 运行 decision 仍为 complete|keep-active，无三词/合法组合。 |
| S2-C05 | 条款 | B5 | 声明半边符合/执行偏离 | timeout/onFailure parser 有，运行不消费且 chain-complete 固定 fail-closed。 |
| S2-C06 | 条款 | B6 | 先例存在/通用偏离 | 只有 chain-complete 专用 fingerprint。 |
| S2-C07 | 条款 | D2 | view 符合/执行偏离 | 层序正确，无 consumer/AND。 |
| S2-C08 | 条款 | D3 | 偏离 | 无 reopen union/合成/conflict diagnostic。 |
| S2-C09 | 条款 | H1 | 偏离 | 无统一逐层 evaluator。 |
| S2-C10 | 条款 | H2 | 偏离 | 无 stdout parser、非法分类、per-hook onFailure。 |
| S2-C11 | 条款 | H3 | 偏离 | 仅 chain completion keep-active，无 point-local hold/同 epoch 改判。 |
| S2-C12 | 条款 | I1 | 偏离 | 八点无统一协议执行路径。 |
| S2-C13 | 条款 | I2 | 声明符合/证明缺口 | parser/serializer 穷尽但执行处置面不存在。 |
| S2-C14 | 条款 | I3 | 声明符合/运行偏离 | 正整数节流声明有，无 per-hook completion/epoch 状态。 |
| S2-C15 | 条款 | I4 | 偏离 | chain-complete 私有形态未收编。 |
| S2-C16 | 条款 | I5 | 偏离 | fingerprint 过宽、写 chain.metadata、缺 declaration hash/point identity。 |
| S2-C17 | 条款 | J1 | 偏离 | 无 evaluation table/epoch/journal/状态机。 |
| S2-C18 | 条款 | J4 | 偏离 | 只有 fingerprint，无 epoch，且观测 fingerprint 是另一机制。 |
| S3-C01 | 条款 | C1 | 部分符合 | auth/caller ADT 可复用；hook runtime 尚须保证不继承 agent credential。 |
| S3-C02 | 条款 | C2 | 偏离 | mutation 无 evaluation identity/稳定扣点关联/subtree join。 |
| S3-C03 | 条款 | D3 | 偏离 | 仅 reachability enum 字面量，无 reopen 合成/consumer。 |
| S3-C04 | 条款 | D4 | 骨架/运行偏离 | placeholder 无绑定 parser/required optional/resolution。 |
| S3-C05 | 条款 | J1 | 偏离 | join 标签不是通用 journal；无 writer/body/execution id。 |
| S3-C06 | 条款 | J2 | 偏离 | request 无 evaluation scope/key/replay/原子 mutation。 |
| S3-C07 | 条款 | J3 | 偏离 | 无 journal consumer 或 decision+effect writer。 |
| S3-C08 | 条款 | J4 | 偏离 | fingerprint 与 epoch 未正交。 |
| S3-C09 | 条款 | J5 | 偏离 | item.created 无 evaluation scope且事件在 commit 后。 |
| S3-C10 | 条款 | J6 | 符合现状基线 | 普通 operator duplicate conflict 基线存在，scope 引入后须保持。 |
| S3-C11 | 条款 | J7 | 偏离 | 无统一 decision ADT/typed ingress。 |
| S3-C12 | 条款 | K1 | 偏离 | 普通 hook 声明不是 name→script binding。 |
| S3-C13 | 条款 | K2 | 偏离 | placeholder 无 required/optional。 |
| S3-C14 | 条款 | K3 | 静态可判定偏离 | 无 preset compile/instance binding caller。 |
| S3-C15 | 条款 | K4 | 部分骨架 | 层序有，无同名选择/shadowed/effective script。 |
| S3-C16 | 条款 | K5 | 静态形态符合 | placeholder 不含 path，但 DSL 未交付。 |
| S3-C17 | 条款 | L1 | 偏离 | join union/DB 无 script variant。 |
| S3-C18 | 条款 | L2 | 偏离 | chain-complete 仍是私有二词。 |
| S3-C19 | 条款 | L3 | 偏离 | consume 不可逆；无 target/correction/cursor/budget 原子 reopen。 |
| S3-C20 | 条款 | L4 | 偏离/迁移素材 | 顶层 chain-complete 仍走 trigger 私有路径。 |
| S3-C21 | 条款 | L5 | 静态不可证明完整符合 | 未扩查 payload；closure 可作为有无工作来源。 |
| S3-C22 | 条款 | B2–B4 | 偏离 | 无三词 parser、精确 correction IDs、原子 claim/effect/consume。 |
| S3-C23 | 条款 | I4–I5 | 偏离 | 专用 metadata/fingerprint 过宽且无 declaration hash/epoch。 |
| S1-U01 | 未知 | 最小实验未知 | — | observer 出现后才可测 slow/nonzero/timeout/spawn-failure、旁路、stdin、进程组和重启孤儿。 |
| S1-U02 | 未知 | P3 未裁决 | — | 同脚本跨事件/chain 并发与重入保留未知。 |
| S1-U03 | 未知 | 外部供给未知 | — | definitionRef→完整 compile projection API/存储待 RFC-2。 |
| S1-U04 | 未知 | 跨树语义未知 | — | closure 六边需 RFC-1 逐边生产，不猜映射。 |
| S1-A01 | 资产 | A2/A3 声明半边 | — | observer point 派生、matcher/parser 拒绝。 |
| S1-A02 | 资产 | 声明 ADT/边界 | — | HookDeclaration、ArkType、global version document、tick 正整数。 |
| S1-A03 | 资产 | 四层存储/排序 | — | global/chain/item persistence 与 provenance helper；preset/生产接线未就绪。 |
| S1-A04 | 资产 | 事件底料 | — | ObservabilityEventBoundary、穷尽 scheduler conversion、query/render。 |
| S1-A05 | 资产 | 运行态底料 | — | TaskTree/Closure/session/pin/active runs。 |
| S1-A06 | 资产 | 编译底料 | — | PresetCompileProjectionBoundary 候选源。 |
| S1-A07 | 资产 | 进程经验 | — | agent async spawn/stdin/group SIGTERM→SIGKILL 仅供抽取原则。 |
| S1-T01 | 测试 | 有效覆盖 | — | A2 类型派生与 hook.* 排除。 |
| S1-T02 | 测试 | 有效覆盖 | — | declaration parse/layer/tick。 |
| S1-T03 | 测试 | 有效覆盖 | — | global reload、chain/item persistence、手工 layer order。 |
| S1-T04 | 测试 | 有效覆盖 | — | hooks 当前不进入 status transparent surfaces。 |
| S1-T05 | 测试 | 同错 | — | sentinel 明确以“调度中不执行”为骨架预期，不能证明执行。 |
| S1-T06 | 测试 | 同错 | — | 测试手工注入 preset placeholder，绕过 compiler/pinned producer。 |
| S1-T07 | 测试 | 同错 | — | layer equality 不证明匹配/全执行/AND。 |
| S1-T08 | 测试 | 盲区 | — | 全部 event writer observer 派发 |
| S1-T09 | 测试 | 盲区 | — | hook.* 发射期零派发 |
| S1-T10 | 测试 | 盲区 | — | slow observer 旁路 |
| S1-T11 | 测试 | 盲区 | — | stdin schema/version/export |
| S1-T12 | 测试 | 盲区 | — | timeout/spawn/nonzero diagnostics |
| S1-T13 | 测试 | 盲区 | — | 进程组孙进程回收 |
| S1-T14 | 测试 | 盲区 | — | daemon crash orphan |
| S1-T15 | 测试 | 盲区 | — | closure 六边与 metadata |
| S1-T16 | 测试 | 盲区 | — | pinned projection 解引用 |
| S1-T17 | 测试 | 盲区 | — | F8 GitHub 字段负向守护 |
| S1-T18 | 测试 | 盲区 | — | I2 消费者编译穷尽 |
| S1-T19 | 测试 | 盲区 | — | I9 全点统一合成 |
| S1-I01 | 影响 | 当前影响 | — | 声明无执行；observer/stdin/hook events/四层 runtime/closure subscriptions/payload 均不存在。 |
| S1-I02 | 影响 | 未来影响 | — | 仅接 scheduler、重编译当前 preset、透传 status 或复制 agent executor 都会形成遗漏/漂移。 |
| S1-I03 | 影响 | 证明缺口 | — | 类型/排序/closure tests 只证局部；F8 仅消极事实。 |
| S2-U01 | 未知 | 并发未知 | — | chain trigger await 与 whole-metadata keep-active 写是否造成 lost update，需隔离实验。 |
| S2-U02 | 未知 | shutdown 边界未知 | — | shutdown-held 时 socket 可查且无新调度的准入矩阵须需求投影后实验。 |
| S2-A01 | 资产 | 声明地基 | — | GateDecisionPoint/tick ADT/ArkType 与四层 provenance。 |
| S2-A02 | 资产 | 调度并发地基 | — | tick 单飞/pause、per-chain finalizing、Promise 异步形态。 |
| S2-A03 | 资产 | fingerprint 经验 | — | 稳定 JSON/排序/剔除自身；不保留私有存储/wire。 |
| S2-A04 | 资产 | 事务地基 | — | SQLite immediate write、WAL/busy timeout。 |
| S2-A05 | 资产 | 观测去重地基 | — | DecisionFingerprintState scope cleanup；不是 gate store。 |
| S2-T01 | 测试 | 有效覆盖 | — | hook parser/view/restart round-trip。 |
| S2-T02 | 测试 | 有效覆盖 | — | chain-complete 排他/抑制/上下文重问/fail-closed。 |
| S2-T03 | 测试 | 有效覆盖 | — | decision observability 去重/回收。 |
| S2-T04 | 测试 | 同错 | — | hooks integration 直接调 view，无 scheduler。 |
| S2-T05 | 测试 | 同错 | — | chain-complete tests 固化旧二词/fail-closed。 |
| S2-T06 | 测试 | 同错 | — | fingerprint tests 未覆盖 declaration/point/minimal/epoch。 |
| S2-T07 | 测试 | 盲区 | — | 真实 script/stdout/timeout/onFailure/跨 chain |
| S2-T08 | 测试 | 盲区 | — | 八点副作用前 hold 与 held state/节流 |
| S2-T09 | 测试 | 盲区 | — | 四层 AND/multi-reopen/conflict |
| S2-T10 | 测试 | 盲区 | — | crash/recovery/idempotency/stale refusal |
| S2-T11 | 测试 | 盲区 | — | metadata concurrent lost-update |
| S2-M01 | 迁移 | 迁移事实 | — | 旧 chain metadata 可跨升级携专用 state。 |
| S2-M02 | 迁移 | 迁移缺口 | — | 旧 keep-active 不能静默解释成 journal epoch。 |
| S2-M03 | 迁移 | 迁移未裁决 | — | 专用历史行迁移/忽略/清理策略未定。 |
| S2-I01 | 影响 | 当前影响 | — | gate 声明零执行；仅私有 chain completion hold。 |
| S2-I02 | 影响 | 未来影响 | — | 就近接线会在副作用后 hold；复制 metadata/单 callback 破坏协议。 |
| S2-I03 | 影响 | 证明缺口 | — | 声明穷尽和旧测试不证明统一 evaluator。 |
| S3-U01 | 未知 | 未来恢复未知 | — | decision/effect 同事务后四 kill 点真实恢复序列须故障注入。 |
| S3-U02 | 未知 | 外部供给未知 | — | target/correction/cursor/budget 权威 API 待 RFC-1，不能由枚举反推。 |
| S3-A01 | 资产 | 认证地基 | — | command auth 穷尽表与 operator/agent ADT。 |
| S3-A02 | 资产 | mutation 地基 | — | add/update/reorder validation/audit 与 batch transaction。 |
| S3-A03 | 资产 | SQLite 地基 | — | WAL/busy timeout/BEGIN IMMEDIATE。 |
| S3-A04 | 资产 | identity 地基 | — | task identity、join binding version/epoch FK、closure/active-run FK。 |
| S3-A05 | 资产 | 恢复模式 | — | typed reachability 与 consumption intent outbox。 |
| S3-A06 | 资产 | 绑定/防抖骨架 | — | placeholder layer order 与 fingerprint 经验；不保留专用 store。 |
| S3-T01 | 测试 | 有效覆盖 | — | 旧 seed migration/new enum。 |
| S3-T02 | 测试 | 有效覆盖 | — | closure intent reopen DB/mark emitted。 |
| S3-T03 | 测试 | 有效覆盖 | — | reachability fact 幂等/same-chain/保活。 |
| S3-T04 | 测试 | 有效覆盖 | — | effective view 层序保形。 |
| S3-T05 | 测试 | 同错 | — | join snapshot round-trip 可容忍零生产 transition |
| S3-T06 | 测试 | 同错 | — | placeholder TS 注入绕过 parser/resolution/executor |
| S3-T07 | 测试 | 同错 | — | reachability enum test 不证明 decision consumer 原子 seed |
| S3-T08 | 测试 | 同错 | — | intent 手工 emitted 未注入四 kill 窗口 |
| S3-T09 | 测试 | 同错 | — | fingerprint 不重复测试掩盖 store/过宽/hash/epoch 偏离 |
| S3-T10 | 测试 | 同错 | — | auth tests 无 scope/replay/atomicity/audit |
| S3-R01 | 恢复事实 | 恢复窗口 | — | consume commit 后 cleanup 前：可由 pending intent 恢复。 |
| S3-R02 | 恢复事实 | 恢复窗口 | — | cleanup 后 event 前：会幂等重清并发事件。 |
| S3-R03 | 恢复事实 | 恢复窗口 | — | event 后 mark emitted 前：可能重复事件，at-least-once。 |
| S3-R04 | 恢复事实 | 恢复窗口 | — | emitted 后 clear 前：重启继续清资源。 |
| S3-I01 | 影响 | 当前影响 | — | 字面量/表名非功能；无 script join/reopen/mutation replay/binding。 |
| S3-I02 | 影响 | 未来影响 | — | 可复用 auth/transaction/identity/outbox；须新增统一 consumer/scope/binding/ingress。 |
| S3-I03 | 影响 | 证明缺口 | — | round-trip/迁移/局部事务不证明 crash、共用 consumer、原子 reopen、required restore。 |

### B1. 影响分类规则

- `S*-I*` 明列当前影响、未来能力出现后的影响、纯证明缺口；条款项以其原报告状态保留，不把“未实现”合成一个 finding。
- `资产` 只表示可保留底料或算法经验；凡报告限定“不可视为交付/不可保留专用形态”的限制已写进观察事实。
- `未知` 与 `迁移未裁决` 不转写为方案；测试绿色只登记其局部证明范围。

## C. 互证与冲突表

| ID | 来源 | 关系 | 登记（不裁决） |
|---|---|---|---|
| X-01 | S1 D2/I9；S2 D2/H1；S3 D4/K4 | 互证 | 四层排序 helper 是共同资产；三者都确认无生产 consumer、AND 或绑定 resolution。 |
| X-02 | S1 I2；S2 I2 | 表述差异 | S1 写“偏离/证明缺口”，S2 写“声明符合/证明缺口”；共同事实是声明穷尽存在、执行/payload/event 处置面不存在。后续须按稳定条款拆声明半边与执行半边复核。 |
| X-03 | S2 I4/I5/J4；S3 I4–I5/J4；S1 E5 | 互证/防混同 | chain-complete durable fingerprint 是私有先例；daemon observability fingerprint 是内存事件去重；两者均不是统一 evaluation journal。 |
| X-04 | S1 A4/F7/U04；S2 A7；S3 L3/B2–B4/U02 | 边界重叠 | closure 转移事件、post-exit hold、reopen consumer 共同卡在 RFC-1 供给；报告分别从 observer、gate host、持久 consumer 观察，不能互相替代。 |
| X-05 | S1 F3/U03；S3 K3/K5 | 边界重叠 | pinned compile projection 解引用与 preset named binding producer 均依赖 RFC-2；placeholder 手工对象不证明供给存在。 |
| X-06 | S2 U01/T盲区；S3 SQLite/transaction assets | 未决风险 | immediate transaction 是资产，但不能裁决旧 chain snapshot whole-metadata 写的 lost update；需保留隔离实验未知。 |
| X-07 | S1 process assets；S2 async assets | 互证 | 既有 async/process-group 代码只提供形态经验；共同执行层尚不存在，不得据此判 G/H 已交付。 |
| X-08 | 三报告测试项 | 互证 | 测试普遍证明 schema/round-trip/私有先例，却与缺少生产 consumer 同错；绿灯不是 v3 证明。 |

## D. 全覆盖映射

映射单位定义：条款表每一行、摘要中的每个编号资产/未知/影响项、测试章节每个 bullet、以及报告单列的迁移/恢复窗口，均作为一个原子项。正文因果与证据章节是这些原子项的展开，不重复制造 finding；其章节覆盖见 D2。

### D1. 逐原子映射与机械计数


#### 04-supply-observer-payload.md

- 条款表（27 行）：A1→S1-C01；A2→S1-C02；A3→S1-C03；A4→S1-C04；D1→S1-C05；D2→S1-C06；E1→S1-C07；E2→S1-C08；E3→S1-C09；E4→S1-C10；E5→S1-C11；F1→S1-C12；F2→S1-C13；F3→S1-C14；F4→S1-C15；F5→S1-C16；F6→S1-C17；F7→S1-C18；F8→S1-C19；G1→S1-C20；G2→S1-C21；G3→S1-C22；G4→S1-C23；G5→S1-C24；G6→S1-C25；I2→S1-C26；I9→S1-C27。
- 非条款原子：S1-U01, S1-U02, S1-U03, S1-U04, S1-A01, S1-A02, S1-A03, S1-A04, S1-A05, S1-A06, S1-A07, S1-T01, S1-T02, S1-T03, S1-T04, S1-T05, S1-T06, S1-T07, S1-T08, S1-T09, S1-T10, S1-T11, S1-T12, S1-T13, S1-T14, S1-T15, S1-T16, S1-T17, S1-T18, S1-T19, S1-I01, S1-I02, S1-I03（33 项）。
- 小计：60；映射：60；未映射：0。

#### 05-supply-gate-runtime.md

- 条款表（18 行）：A5→S2-C01；A6→S2-C02；A7→S2-C03；B2→S2-C04；B5→S2-C05；B6→S2-C06；D2→S2-C07；D3→S2-C08；H1→S2-C09；H2→S2-C10；H3→S2-C11；I1→S2-C12；I2→S2-C13；I3→S2-C14；I4→S2-C15；I5→S2-C16；J1→S2-C17；J4→S2-C18。
- 非条款原子：S2-U01, S2-U02, S2-A01, S2-A02, S2-A03, S2-A04, S2-A05, S2-T01, S2-T02, S2-T03, S2-T04, S2-T05, S2-T06, S2-T07, S2-T08, S2-T09, S2-T10, S2-T11, S2-M01, S2-M02, S2-M03, S2-I01, S2-I02, S2-I03（24 项）。
- 小计：42；映射：42；未映射：0。

#### 06-supply-persistence-binding-reopen.md

- 条款表（23 行）：C1→S3-C01；C2→S3-C02；D3→S3-C03；D4→S3-C04；J1→S3-C05；J2→S3-C06；J3→S3-C07；J4→S3-C08；J5→S3-C09；J6→S3-C10；J7→S3-C11；K1→S3-C12；K2→S3-C13；K3→S3-C14；K4→S3-C15；K5→S3-C16；L1→S3-C17；L2→S3-C18；L3→S3-C19；L4→S3-C20；L5→S3-C21；B2–B4→S3-C22；I4–I5→S3-C23。
- 非条款原子：S3-U01, S3-U02, S3-A01, S3-A02, S3-A03, S3-A04, S3-A05, S3-A06, S3-T01, S3-T02, S3-T03, S3-T04, S3-T05, S3-T06, S3-T07, S3-T08, S3-T09, S3-T10, S3-R01, S3-R02, S3-R03, S3-R04, S3-I01, S3-I02, S3-I03（25 项）。
- 小计：48；映射：48；未映射：0。

### D2. 章节覆盖映射

| 报告章节 | Ledger 范围 |
|---|---|
| 04 A2/B1 | S1-C01–S1-C27 |
| 04 A4 | S1-I01–S1-I03 |
| 04 A5 | S1-A01–S1-A07 |
| 04 A6/B9 | S1-U01–S1-U04 |
| 04 B2–B7、B10 | 对应 S1-C 条款及 S1-A/U；为证据/索引展开，无新增未映射 finding |
| 04 B9 | S1-U01 的实验矩阵展开，并交叉覆盖 S1-T 盲区 |
| 04 B11/收口 | 对应 S1-C/A/U/T/I 全集的边界核对 |
| 04 B8 | S1-T01–S1-T19 |
| 05 A2/B1/B3–B6 | S2-C01–S2-C18 |
| 05 A3 | S2-I01–S2-I03 |
| 05 A4 | S2-A01–S2-A05 |
| 05 A5/B7 | S2-U01–S2-U02 |
| 05 B8 | S2-T01–S2-T11 |
| 05 B9 | S2-M01–S2-M03 |
| 05 B2/B4–B6/B10 | 对应 S2-C/A/T；证据与防混同展开 |
| 05 B11/C | 对应 S2 全集的证据索引与尾部核对 |
| 06 A1/B1 | S3-C01–S3-C23 |
| 06 A3 | S3-I01–S3-I03 |
| 06 A4 | S3-A01–S3-A06 |
| 06 A5/B9 | S3-U01–S3-U02 |
| 06 B3.4 | S3-R01–S3-R04 |
| 06 B8 | S3-T01–S3-T10 |
| 06 B2–B7 | 对应 S3-C/A/R；证据展开，无新增未映射 finding |
| 06 B9 | S3-U01/U02 的未来最小实验展开 |
| 06 B10/B11 | 对应 S3 全集的证据索引与报告收口 |

### D3. 漏项检查方法

1. 从三份报告提取 B1 条款表首列，逐行与 `S*-C*` 双射；计数分别 27/18/23。
2. 从“可保留资产”“未知/最小实验”“影响分类”“测试同错与盲区”逐 bullet 计数；另对 05 的迁移三项、06 的四个恢复窗口单列。
3. 将每个原子源项标记一次且仅一次；展开证据章节只回指，不二次计数。
4. 机械恒等式：S1 60 + S2 42 + S3 48 = 150；本表实际 ledger 行数应为 150，未映射应为 0。

## E. 证据边界与文件尾部核对

- 只读输入：三份 R4 正式报告、`aggregation.md`、`WORKFLOW.md` R5 段；未读取源码来纠正报告。
- 未运行测试或实验；报告冲突只登记。
- 未提出补法、选项、工期或 issue 边界；未创建 worktree；未修改产品代码、测试、配置或 `WORKFLOW.md`。
- 文件尾部核对：统一总账、互证/冲突表、逐报告全覆盖映射、计数与漏项方法均在场。
