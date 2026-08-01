# RFC #546：证据与可追溯索引

> 本文只回答“观察到什么、如何复核、来源在哪里”。**证据不产生需求**；只有 [RFC.md](RFC.md) 是产品语义权威。下面的 `path:line` 是调查时冻结 main checkout 的定位，实施前必须重新核实。

## 1. 来源清点与需求谱系

本地冻结输入为 [`SYNTH-546-task-model-seq-par.md`](SYNTH-546-task-model-seq-par.md)，从仓库相对路径 `v3-issue/synthesized/SYNTH-546-task-model-seq-par.md` 拷入；共 6388 行，SHA-256 `b4c51e8de62af2507dd24510c59cb25a8b45a6fe4a1860c518e27b0058153dbe`。[对照稿](DRAFT-seq-par-task-model.md)中的全部 `SYNTH:L…` 均指本目录这份冻结副本。它被逐段清点：RFC 骨架、OPEN children、已落地 shape/authorization、依赖与验收边界进入稳定聚合；NOT_PLANNED 摘要、marker 供替链、重复 contract-invalid 评论和易变队列状态不进入规范。旧 backward reopen 评论被现行 C09 与操作员单向并发代数取代。

有效来源链为：外部 SYNTH 与操作员裁决 → 稳定能力语义 → 本目录 `RFC.md`。源码、实验和报告只用于确认地基与偏差，不能反向改写语义。

## 2. main 实然底图（能力 A–N）

冻结审计基点：`/Users/mouriya/Ext/code/coder-loop` 的 `main`，HEAD `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。只读源码审计结论：A、C–H、J、K、N 的目标运行行为未实现；I 部分实现（`baseBranch` 已消费，tree/top-level join 声明位未完成）；L shape 与 M authorization 已落地，但并不等于调度、判定或 mutation 已落地。

关键复核点：

| 能力 | 冻结路径证据 | 确定结论 |
|---|---|---|
| A | `src/loop.ts:475-478,606-616`; `src/daemon.ts:3320-3433` | exits 仍是 v2 status/chain action；没有 committed-transition 事务 |
| C | `src/task-runtime.ts:40-58`; `src/scheduler.ts:531-712,872-874` | tree shape 存在，生产调度仍走 slot + flat phase |
| D | `src/task-runtime.ts:28-38`; `src/sqlite-state.ts:703-724`; `src/loop.ts:5494-5535` | join shape 存在，validator/decision core 未生产化；finalizer 仍读 stdout |
| E | `src/sqlite-state.ts:2408-2413`; `src/scheduler.ts:1583-1596` | 只有未完成 closure activate 底座；不存在合法的反向树转移 |
| F/G | `src/sqlite-state.ts:344-353,1974-1980,2397-2432` | initial shape 可写，运行时 materialize/append binding mutation 未实现 |
| H | `src/daemon.ts:2554-2585` | 只有整 chain stop，没有子树取消 |
| I | `src/daemon.ts:2185-2187`; `src/scheduler.ts:904-910,3381-3390`; `src/runtime-data.ts:107-137` | baseBranch 已实现；任务树/top-level join metadata 未实现 |
| L/M | `src/task-runtime.ts`; `src/sqlite-state.ts`; phase-sliced sandbox 路径 | shape/授权是可保留地基，但消费者仍需按 RFC 重接 |

复核命令摘要：`git rev-parse --abbrev-ref HEAD`、`git rev-parse HEAD`，以及围绕 `committed_transition|taskTree|validator|materialize|joinBinding|cancel|baseBranch|FINALIZER SUMMARY` 的 `rg -n` 与逐段源码阅读。

## 3. 供给审计

- **闭包生命周期：** durable `active|suspended|consumed` 与 worktree/branch 资源已有部分供给，但 create、consume、cleanup、restart reconciliation 的事务边界与 exactly-once evidence 仍有接缝。
- **Git supply：** base fetch、pin、闭包 branch、remote tracking freshness 和 cleanup 必须拆开观察；共享 repo 写操作需要 namespace 与串行化。
- **shape：** schema 能表达 seq/par/join/closure，但生产路径仍可制造 flat/tree 分裂；shape 可表达不等于生产者遵守代数。
- **authorization：** phase sandbox 与递出面已有基础；repo/global read、shared write、runner roots 和 ambient Git 必须按 G3 分类，不得由“能访问”推导“是业务权威”。

供给总账的 gate 结论是“可保留资产与缺口均已枚举”，不是“实现已满足 RFC”。

## 4. R7 实验与静态调查结论

| 主题 | 结论摘要 |
|---|---|
| recovery / flat-tree | 现有 unblock/activate 路径可只改 flat/closure 状态而不改 tree；这证明当前实现偏离，**不证明回退是合法需求** |
| delete/history | 删除、runtime history 与 identity 生命周期的现有边界不一致；历史证据必须独立于活资源 |
| consume crash/dedup | durable intent 可支持重启后重发；采样与发射必须区分，避免重复或丢证据 |
| observer/GUI | 多读面可观察不同投影；observer 不能拥有推进权，需显式 freshness/divergence |
| Git start/recovery | fetch、base resolve、branch/worktree create 之间存在 crash residue；startup 必须对账而非静默猜测 |
| repo identity | cwd、remote URL、repo identity 与 chain identity 不是同一概念；共享写协调必须使用稳定 identity |
| origin failures | fetch/resolve/contains 的失败形态不同；当前分类存在压缩，publication 失败不得等同 unpublished |
| definition pin | in-flight instance 需要冻结定义 identity；磁盘 preset 漂移不能静默改写在途语义 |
| join epoch | binding version/epoch shape 已存在，但生产与 mutation 协议未闭合 |
| consumed identity | consumed 是不可逆生命周期事实，durable history 不能依赖已删除资源 |
| authorization/read/write | host env、runtime roots、global read 与 shared Git/config/hooks 是不同面；必须分别分类与审计 |
| concurrency/latency/migration | active-run uniqueness、daemon migration drift、Git hang/socket latency 与 runner alias/env 均有明确生产接缝，不能靠单元 shape 证明 |

R7 gate 核算：T1–T17 与原静态 unknown 均完成事实闭合；“闭合”只表示问题已查清，不表示产品语义已裁或代码已实现。

## 5. 任务代数的非法实现证据

生产代码与旧报告曾允许或设想：flat item 被解锁而 tree cursor 已越过、terminal ancestor 下出现未完成 descendant、事后重激活旧 identity、cursor 回退、terminal container 重开。操作员裁决与并发代数证明这些不是候选行为，而是不可达 shape。

独立纠偏 gate 检查 12 条跨层不变量和 12 个非法 shape；结论为全部纳入规范，旧 M1/Q05/反向恢复档案失效。当前实现偏离仅作为实施缺口记录：边界 parser、迁移、生产者和持久化必须拒绝非法 shape；不得把偏离写成新的产品选项。

## 6. M2：`published` 的事实边界

当前生产路径在 consume 时解析闭包 tip，刷新 `origin` heads，再对 remote-tracking refs 执行 contains 检查；它只覆盖所 fetch 的 heads，不覆盖 tags、provider synthetic PR refs 或其他 remote。第二次 fetch 失败时结果应不可求值；durable intent 在重启后复用采样结果，不重新查询远端。因此它是“消费时的一次观察”，不是 status 打开时的实时真相。

稳定边界已经排除：`published = merged`、publication 驱动 consume/GC/推进、旧 tracking ref 冒充当前远端、查询失败等于 unpublished。「引擎可靠计算的只有自有面」条款进一步排除了任意远端通道的内容问读法；档位已于 2026-07-31 裁定为自有通道 contains-tip，定义入 [RFC §四](RFC.md#四函数域资源合同)，闭合记录见 [RFC 附录 B](RFC.md#附录-bsupersession-与-r8-闭合记录2026-07-31)。

## 7. 决策与纠偏来源

- 已裁 D-13：runner runtime/session 根按可用性授权并登记为 G3 已知共享面。
- 已裁任务代数：完成吸收、seq cursor 单调、par 全员完成后才 evaluation、父层只消费 direct-child subtree complete；suspend/reopen/retry 仅作用于 current unfinished identity；append 仅向开放 frontier 加新 identity。
- 已撤回：Q01–Q40 伪问卷、M1/backward reactivation、把报告候选当需求的路线。
- 2026-07-31 操作员裁决系列（三时态、锁模型、对象/函数/值三域、柯里化派生、异常语义、await）后，末两项同日闭合：原 B-D6-2 经源码调查证实 v2 trigger 电平触发、每 episode 一次、无跨 episode 记忆（`src/scheduler.ts:649-655, 2974-2986`）；M2 `published` 裁定自有通道 contains-tip 档位。**R8 完成，无剩余未决项。** 原 7 个 B 类问题的逐项归宿与被 supersede 的旧裁决见 [RFC 附录 B](RFC.md#附录-bsupersession-与-r8-闭合记录2026-07-31)：B-D2-1/B-D3-1/B-D3-2 随子树取消出局，B-D4-1 併入 C 类 scope 词表，B-D6-1 由构造式派生吸收。

纠偏审计证明污染曾沿“聚合→供给→事实→决策档案→问卷→叙事→修复报告”扩散到 23 个文件；23 是报告 DAG 节点数，不是 RFC 草稿章节数。最终修复以唯一 RFC 替代层层覆盖。

## 8. 原文件到新章节的有效结论映射（92 项；来源覆盖 76/76）

> 本表是 2026-07-31 文档归并时点的落位台账，行内 RFC 章节锚点指向**归并时的旧结构稿**。RFC 已于同日被三域模型收敛稿整体替换（supersession 见 [RFC 附录 B](RFC.md#附录-bsupersession-与-r8-闭合记录2026-07-31)）；本表按台账体裁保留原样，不随重写改写。

此表是删除门禁。每份原文件至少有一个结论 ID；保留项按有效结论粒度拆分、当前精确 anchor、处置和理由；文件名只是历史来源标签，不是链接或当前消费者。

| ID | 原文件标签 | 有效结论 | 当前精确 anchor | 处置 | 理由 |
|---|---|---|---|---|---|
| E001 | `00-source-inventory.md` | 输入材料的保留/去重/丢弃边界已建立。 | [§1](#1-来源清点与需求谱系) | 保留归并 | 唯一 source inventory 事实进入 §1。 |
| E002 | `10-global.md` | 全局公理与总交付的有效规范已进入唯一 RFC。 | [RFC](RFC.md#2-全局公理与不变量) | 保留归并 | 规范去除调查史与旧覆盖层后进入 RFC。 |
| E003 | `20-capabilities.md` | 能力 A–G的有效规范已进入唯一 RFC。 | [RFC](RFC.md#4-能力-an) | 保留归并 | 规范去除调查史与旧覆盖层后进入 RFC。 |
| E004 | `21-capabilities.md` | 能力 H–N的有效规范已进入唯一 RFC。 | [RFC](RFC.md#4-能力-an) | 保留归并 | 规范去除调查史与旧覆盖层后进入 RFC。 |
| E005 | `30-annex.md` | 跨树/验收边界与 B/C 问题分类进入唯一 RFC。 | [RFC §6](RFC.md#6-跨树与验收边界) / [RFC §9](RFC.md#9-r8-真实行为问题树b共-7-项) / [RFC §10](RFC.md#10-r9-工程地基账c共-8-项) | 保留归并 | 边界、7 个 B 行为问题与 8 个 C 工程项分别落位。 |
| E006 | `40-code-audit.md` | 冻结 main 上 A–N 的实现/部分实现/缺失底图。 | [§2](#2-main-实然底图能力-an) | 保留归并 | path:line 与结论压缩进入实然底图。 |
| E007 | `50-supply-closure-semantics.md` | closure 生命周期供给不完整且存在事务接缝。 | [§3](#3-供给审计) | 保留归并 | 供给事实进入专题摘要；候选方案不升格。 |
| E008 | `51-supply-git-supply.md` | Git base/pin/branch/freshness/cleanup 必须分层。 | [§3](#3-供给审计) | 保留归并 | 供给事实进入专题摘要；候选方案不升格。 |
| E009 | `52-supply-shape.md` | shape 可表达树但生产路径未遵守代数。 | [§3](#3-供给审计) | 保留归并 | 供给事实进入专题摘要；候选方案不升格。 |
| E010 | `53-supply-authorization.md` | 递出授权面需按 task/declaration/shared-Git 分类。 | [§3](#3-供给审计) | 保留归并 | 供给事实进入专题摘要；候选方案不升格。 |
| E011 | `60-remediation-assessment.md` | 该处置草案不可信，不能作为需求或修复输入。 | [§7](#7-决策与纠偏来源) | 错误删除 | 被后续事实总账和代数纠偏推翻。 |
| E012 | `61-decision-D1-leaf-reactivation.md` | 其中 flat/tree 分裂是实现偏离；backward reactivation 候选无效。 | [§5](#5-任务代数的非法实现证据) | 被更强证据取代 | 单向代数取代候选，偏离事实并入 §5。 |
| E013 | `61-decision-D12-read-surface.md` | read surface、repo identity 与 observer 投影不是同一权威。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 可复核事实进入对应主题行。 |
| E014 | `61-decision-D14-delete-semantics.md` | 删除活资源不能删除 durable identity/history。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 可复核事实进入对应主题行。 |
| E015 | `62-feasibility-D1.md` | 其中 flat/tree 分裂是实现偏离；backward reactivation 候选无效。 | [§5](#5-任务代数的非法实现证据) | 被更强证据取代 | 单向代数取代候选，偏离事实并入 §5。 |
| E016 | `62-feasibility-D11.md` | definition/shape pin 与迁移漂移需要显式 identity。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 可复核事实进入对应主题行。 |
| E017 | `62-feasibility-D12.md` | repo identity、G3 surface 与共享 Git 协调边界可区分。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 可复核事实进入对应主题行。 |
| E018 | `63-supply-ledger-audit.md` | 该 gate 只证明阶段覆盖/unknown 关账，不证明产品完成。 | [§4](#4-r7-实验与静态调查结论) | 被更强证据取代 | 最终 coverage 核算已压入 §4。 |
| E019 | `64-r7-coverage-map.md` | 该 gate 只证明阶段覆盖/unknown 关账，不证明产品完成。 | [§4](#4-r7-实验与静态调查结论) | 被更强证据取代 | 最终 coverage 核算已压入 §4。 |
| E020 | `65-r7-T1-recovery-transactions.md` | unblock/activate 可制造 flat/tree 分裂，是实现偏离而非合法回退。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E021 | `65-r7-T10-join-epoch-production.md` | join version/epoch shape 存在，生产/mutation 协议未闭合。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E022 | `65-r7-T11-flat-tree-authority.md` | 生产调度仍走 flat path，tree shape 尚非唯一调度权威。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E023 | `65-r7-T12-consumed-schema-identity.md` | consumed identity/history 必须独立于被回收资源。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E024 | `65-r7-T13-g3-surface.md` | G3 runtime roots、声明面和共享 Git 面必须分类。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E025 | `65-r7-T14-global-read-host-env.md` | global read 与 host env 暴露是不同授权面。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E026 | `65-r7-T15-shared-write-surfaces.md` | shared write/config/hooks 需要稳定 repo identity 与协议。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E027 | `65-r7-T16-base-branch-prompt.md` | baseBranch 权威来自 chain 声明，prompt 不得成为第二权威。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E028 | `65-r7-T2-delete-runtime-history.md` | delete、runtime history 与 durable identity 当前边界不一致。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E029 | `65-r7-T3-consume-crash-dedup.md` | consume sampling、durable intent 与 emission retry 必须分离。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E030 | `65-r7-T4-observer-gui.md` | observer/GUI 是投影，不拥有推进判定权。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E031 | `65-r7-T5-git-start-recovery.md` | Git create 跨步骤 crash 会留下需 startup 对账的 residue。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E032 | `65-r7-T6-repo-identity.md` | cwd、remote URL、repo identity、chain identity 不等价。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E033 | `65-r7-T7-origin-error-classification.md` | fetch/resolve/contains 失败不同；publication 失败不能压成 unpublished。 | [§6](#6-m2published-的事实边界) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E034 | `65-r7-T8-startup-create-reconciliation.md` | startup 必须对账 DB/branch/worktree，不得静默猜测。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E035 | `65-r7-T9-definition-pin.md` | in-flight instance 必须冻结 definition identity，拒绝静默漂移。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E036 | `66-r7-T17-static-unknowns.md` | 该 gate 只证明阶段覆盖/unknown 关账，不证明产品完成。 | [§4](#4-r7-实验与静态调查结论) | 被更强证据取代 | 最终 coverage 核算已压入 §4。 |
| E037 | `67-r7-active-run-concurrency.md` | active-run uniqueness 需要 closure identity 执法，slot 偶然串行不足。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E038 | `67-r7-daemon-migration-drift.md` | daemon migration 与 definition 漂移需冻结版本和显式失败。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E039 | `67-r7-git-hang-socket-latency.md` | Git hang 与 socket latency 影响事务/timeout 边界。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E040 | `67-r7-runner-alias-env-knobs.md` | runner alias、runtime roots、env knobs 需显式声明与审计。 | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 实验/静态事实压入主题索引；过程删除。 |
| E041 | `68-r7-gate-audit.md` | 该 gate 只证明阶段覆盖/unknown 关账，不证明产品完成。 | [§4](#4-r7-实验与静态调查结论) | 被更强证据取代 | 最终 coverage 核算已压入 §4。 |
| E042-1 | `70-decision-R8-02-delete-contract.md` | delete acts on live resource identity and must not erase durable history. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E042-2 | `70-decision-R8-02-delete-contract.md` | consumed is irreversible; active/suspended delete cannot masquerade as consume. | [RFC §4.B](RFC.md#b--闭包资源生命周期与-git-supply) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E043-1 | `70-decision-R8-03-consumed-delivery.md` | consume sampling and durable intent precede external evidence emission. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E043-2 | `70-decision-R8-03-consumed-delivery.md` | restart retries emission from the stored sample rather than re-querying remote state. | [RFC §4.B](RFC.md#b--闭包资源生命周期与-git-supply) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E044-1 | `70-decision-R8-04-observer-authority.md` | observer/status/event are named projections of durable state, not mutation authority. | [RFC §2.G7](RFC.md#g7--判定权与准入) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E044-2 | `70-decision-R8-04-observer-authority.md` | GUI must expose freshness/divergence instead of silently reconciling conflicting views. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E045-1 | `70-decision-R8-05-git-residue-contract.md` | Git create can crash between fetch, branch, worktree and DB writes, leaving residue. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E045-2 | `70-decision-R8-05-git-residue-contract.md` | startup reconciles DB/branch/worktree and only cleans engine-owned namespace. | [RFC §4.B](RFC.md#b--闭包资源生命周期与-git-supply) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E046-1 | `70-decision-R8-06-repository-identity.md` | cwd, remote URL, chain identity and repository coordination identity are not interchangeable. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E046-2 | `70-decision-R8-06-repository-identity.md` | shared Git serialization requires one stable repository identity key. | [RFC §2.G3](RFC.md#g3--引擎递出面定理) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E047-1 | `70-decision-R8-07-origin-failure-contract.md` | fetch, ref resolution and containment have distinct typed failure causes. | [§6](#6-m2published-的事实边界) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E047-2 | `70-decision-R8-07-origin-failure-contract.md` | publication query failure remains unevaluable and cannot become unpublished. | [RFC §8](RFC.md#8-未闭合语义-r8-m2消费证据中的-published) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E048-1 | `70-decision-R8-08-startup-create-reconciliation.md` | startup must reconcile partially-created closure resources instead of guessing from one surface. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E048-2 | `70-decision-R8-08-startup-create-reconciliation.md` | create/reconcile must be idempotent across daemon restart. | [RFC §4.B](RFC.md#b--闭包资源生命周期与-git-supply) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E049-1 | `70-decision-R8-09-definition-identity.md` | in-flight task instances pin immutable execution-definition identity. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E049-2 | `70-decision-R8-09-definition-identity.md` | preset disk drift or migration mismatch must fail explicitly, not rewrite an instance. | [RFC §4.L](RFC.md#l--持久化-shape-与-status-快照--已落地) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E050-1 | `70-decision-R8-10-join-epoch-protocol.md` | an evaluation epoch samples exactly one join binding version. | [RFC §4.D](RFC.md#d--判定通道decision-core-与-validator-join) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E050-2 | `70-decision-R8-10-join-epoch-protocol.md` | binding append affects the next epoch; crash/retry in the same epoch keeps its sample. | [RFC §4.G](RFC.md#g--join-binding-演化) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E051-1 | `70-decision-R8-11-flat-tree-authority.md` | ready leaves and advancement come only from recursive tree state. | [RFC §3](RFC.md#3-任务代数的合法状态与-12-条不变量) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E051-2 | `70-decision-R8-11-flat-tree-authority.md` | flat queue compatibility cannot create an extra ready leaf or override tree completion. | [§5](#5-任务代数的非法实现证据) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E052-1 | `70-decision-R8-12-consumed-identity-history.md` | consumed lifecycle state is absorbing and has a durable identity. | [RFC §4.B](RFC.md#b--闭包资源生命周期与-git-supply) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E052-2 | `70-decision-R8-12-consumed-identity-history.md` | history/evidence survives deletion of worktree, branch and session resources. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E053-1 | `70-decision-R8-13-authorization-surface.md` | every runner-visible surface belongs exhaustively to task-private, declaration, or shared-Git class. | [RFC §2.G3](RFC.md#g3--引擎递出面定理) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E053-2 | `70-decision-R8-13-authorization-surface.md` | effective authorization is phase-sliced; no loop-data-wide fallback is valid. | [RFC §4.M](RFC.md#m--引擎递出授权面--已落地) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E054-1 | `70-decision-R8-14-global-read-env.md` | global read and host environment exposure are separate authorization surfaces. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E054-2 | `70-decision-R8-14-global-read-env.md` | absence of a declared runtime binding cannot fall back to a global read. | [RFC §4.M](RFC.md#m--引擎递出授权面--已落地) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E055-1 | `70-decision-R8-15-shared-write-trust.md` | objects/remotes/config/hooks are shared Git coordination surfaces, not task-private state. | [RFC §2.G3](RFC.md#g3--引擎递出面定理) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E055-2 | `70-decision-R8-15-shared-write-trust.md` | engine shared writes are serialized and limited to engine-owned refs/resources. | [§3](#3-供给审计) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E056-1 | `70-decision-R8-16-base-branch-authority.md` | chain.baseBranch is the sole declaration authority for closure base selection. | [RFC §4.I](RFC.md#i--chain-层任务树声明位与顶层-join) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E056-2 | `70-decision-R8-16-base-branch-authority.md` | prompt text and ambient checkout cannot become a second baseBranch authority. | [§4](#4-r7-实验与静态调查结论) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E057-1 | `70-decision-R8-17-published-ref.md` | current implementation observes refreshed origin heads containment, not arbitrary refs or mergedness. | [§6](#6-m2published-的事实边界) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E057-2 | `70-decision-R8-17-published-ref.md` | the product meaning/ref set remains B-M2-1 and is fully narrated in RFC §8. | [RFC §8](RFC.md#8-未闭合语义-r8-m2消费证据中的-published) | 保留归并 | 具体事实进入当前专题；未获裁决的候选删除。 |
| E058 | `71-r8-decision-archive-audit.md` | 该文件只记录已撤回问卷/呈现/纠偏过程，无独立产品结论。 | [§7](#7-决策与纠偏来源) | 错误删除 | 有效纠偏结果已进入 RFC；过程不再作为消费者。 |
| E059 | `72-operator-decision-ledger.md` | D-13 与单向代数已裁；M2 的产品语义仍未裁。 | [RFC §7](RFC.md#7-已裁决的运行时根授权d-13) / [RFC §8](RFC.md#8-未闭合语义-r8-m2消费证据中的-published) | 保留归并 | 已裁与未裁状态分别进入唯一 RFC。 |
| E060 | `73-r8-batch1-Q01-Q03.md` | 该文件只记录已撤回问卷/呈现/纠偏过程，无独立产品结论。 | [§7](#7-决策与纠偏来源) | 错误删除 | 有效纠偏结果已进入 RFC；过程不再作为消费者。 |
| E061 | `74-r8-Q01-Q03-authority-audit.md` | 该文件只记录已撤回问卷/呈现/纠偏过程，无独立产品结论。 | [§7](#7-决策与纠偏来源) | 错误删除 | 有效纠偏结果已进入 RFC；过程不再作为消费者。 |
| E062 | `74-r8-Q04-Q40-choice-triage.md` | 该文件只记录已撤回问卷/呈现/纠偏过程，无独立产品结论。 | [§7](#7-决策与纠偏来源) | 错误删除 | 有效纠偏结果已进入 RFC；过程不再作为消费者。 |
| E063 | `75-r8-Q03-audit-authority.md` | 该文件只记录已撤回问卷/呈现/纠偏过程，无独立产品结论。 | [§7](#7-决策与纠偏来源) | 错误删除 | 有效纠偏结果已进入 RFC；过程不再作为消费者。 |
| E064 | `75-r8-Q32-published-authority.md` | 稳定材料未定义 published 的精确 Git 关系。 | [§6](#6-m2published-的事实边界) | 保留归并 | 需求权威缺口进入 M2 事实边界。 |
| E065 | `76-r8-M2-published-narrative.md` | M2 的 Git 场景、用途边界与需裁产品句子完整成立。 | [RFC §8](RFC.md#8-未闭合语义-r8-m2消费证据中的-published) | 保留归并 | 完整叙事进入 RFC，避免无上下文标签。 |
| E066 | `76-r8-decision-presentation-audit.md` | 该文件只记录已撤回问卷/呈现/纠偏过程，无独立产品结论。 | [§7](#7-决策与纠偏来源) | 错误删除 | 有效纠偏结果已进入 RFC；过程不再作为消费者。 |
| E067 | `77-r8-backward-motion-rootcause.md` | 该文件只记录已撤回问卷/呈现/纠偏过程，无独立产品结论。 | [§7](#7-决策与纠偏来源) | 错误删除 | 有效纠偏结果已进入 RFC；过程不再作为消费者。 |
| E068 | `77-r8-monotonicity-cross-audit.md` | 该文件只记录已撤回问卷/呈现/纠偏过程，无独立产品结论。 | [§7](#7-决策与纠偏来源) | 错误删除 | 有效纠偏结果已进入 RFC；过程不再作为消费者。 |
| E069 | `79-task-algebra-authority.md` | 12 条单调不变量与 12 个非法 shape 是唯一代数权威。 | [RFC §3](RFC.md#3-任务代数的合法状态与-12-条不变量) | 保留归并 | 有效规范进入 RFC。 |
| E070 | `79-task-algebra-pollution-audit.md` | backward 语义污染命中 23 个报告 DAG 节点，不是 23 份 RFC。 | [§7](#7-决策与纠偏来源) | 保留归并 | 污染范围事实保留，过程文件删除。 |
| E071 | `80-task-algebra-remediation.md` | 单向代数纠偏 gate 通过，旧 M1/Q05/backward 路线失效。 | [§5](#5-任务代数的非法实现证据) | 被更强证据取代 | 最终规范与证据已吸收 gate 结果。 |
| E072 | `81-task-algebra-remediation-review.md` | 单向代数纠偏 gate 通过，旧 M1/Q05/backward 路线失效。 | [§5](#5-任务代数的非法实现证据) | 被更强证据取代 | 最终规范与证据已吸收 gate 结果。 |
| E073 | `82-rfc-consolidation-independent.md` | 顶层报告膨胀源于阶段产物未收敛；最终合同必须为四文档。 | [§7](#7-决策与纠偏来源) | 保留归并 | 收敛根因与四文档合同已执行。 |
| E074 | `82-rfc-file-proliferation-audit.md` | 顶层报告膨胀源于阶段产物未收敛；最终合同必须为四文档。 | [§7](#7-决策与纠偏来源) | 保留归并 | 收敛根因与四文档合同已执行。 |
| E075 | `README.md` | 入口/执行账本职责保留，但旧流水账与多入口删除。 | [README](README.md) | 保留重写 | 保留文件名，内容按唯一职责重写。 |
| E076 | `WORKFLOW.md` | 入口/执行账本职责保留，但旧流水账与多入口删除。 | [WORKFLOW](WORKFLOW.md) | 保留重写 | 保留文件名，内容按唯一职责重写。 |

## 9. 最小复核命令

```sh
find . -maxdepth 1 -type f -name '*.md' -print | sort
rg -n '\[[^]]+\]\(([^)]+\.md[^)]*)\)' README.md RFC.md EVIDENCE.md WORKFLOW.md
rg -n 'cursor (回退|后退)|事后恢复|重开 terminal|backward reopen|恢复已越过|级联 reopen' README.md RFC.md EVIDENCE.md WORKFLOW.md
rg -n '^## ' RFC.md EVIDENCE.md WORKFLOW.md
wc -l README.md RFC.md EVIDENCE.md WORKFLOW.md
```
