# #545 RFC: v3 context 共享 CLI——无状态 agent 的受控上下文传递

- state: **open**  | author: `RiriAgent`  | created: 2026-07-02T07:53:37Z  | updated: 2026-07-26T16:15:03Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/545
- comments: 3  | timeline events: 45
- sub-issues:
  - #594 [CLOSED] feat(engine): context 共享存储与写入面——envelope ADT、SQLite append-only 表与凭证推导 author (mouriya-s-lab/coder-loop)
  - #595 [CLOSED] feat(cli): context 共享读取命令面——scope 过滤查询与 GUI 消费 boundary (mouriya-s-lab/coder-loop)
  - #596 [CLOSED] feat(engine): context 共享 group scope 真实化——par 容器稳定 id 键解析 (mouriya-s-lab/coder-loop)
  - #597 [CLOSED] feat(engine): context 共享「必须调用」执法——run 收尾 required|expected 判定 (mouriya-s-lab/coder-loop)
  - #598 [CLOSED] docs(v3): context 共享收尾对齐——无状态前提边界重述与文档同步 (mouriya-s-lab/coder-loop)
  - #730 [OPEN] feat(cli): context scope 过滤读取与 GUI boundary (mouriya-s-lab/coder-loop)
  - #731 [OPEN] feat(engine): real-par context group scope (mouriya-s-lab/coder-loop)
  - #732 [OPEN] feat(engine): ordinary run context required/expected 执法 (mouriya-s-lab/coder-loop)
  - #733 [OPEN] feat(engine): trigger 与 validator context outcome 集成 (mouriya-s-lab/coder-loop)
  - #734 [OPEN] docs(v3): context 冻结 SHA 综合验收 (mouriya-s-lab/coder-loop)

---

## Body

## 摘要

v3 context 共享 CLI：引擎提供一个经 daemon socket 的结构化 context 服务——agent 用 CLI 写入/读取带作用域的 context entry，使独立运行的无状态 agent 在 chain 生命周期内有受控的上下文传递能力。envelope 引擎类型化，body 引擎永不解析；prompt 可按 phase 声明「必须调用」，引擎在 run 收尾点执法。

本 RFC 是 v3 RFC 树的一员（拆分依据 `v3/rfc-split.md`，2026-07-02 总控裁定），承接 v3 目标 4 的 context 部分，是 #453 「context 流转能力暂缓」裁决（2026-06-12）的重启。设计裁决已由操作员在本 RFC 子会话（2026-07-02）逐项完成，见「设计裁决」节。

## 操作员目标（verbatim，2026-07-02）

> "然后可选的 prompt 要求必须调用某种特殊定义的 CLI 工具用于 context 共享，这样独立运行的无状态 agent 也有一定程度上的 context 传递能力。" — `v3/v3-goals.md` 目标 4

## 现状事实（基线 pr-529 分支，实施前自行 grep 核对）

- **唯一现存传递通道是 `shared.md`**：daemon 在 `ensureChainRuntimeLayout` 创建（`src/daemon.ts:1629`），之后 agent 按 prompt 纪律以文件系统直写 append——不经 daemon、无鉴权、无审计、无结构、整链单文件全量读；并行分支同时 append 是竞争源。
- **既有设计事实（#396 登记，不修）**：
  > "agent 间 handoff/shared 文件是自由文本通道……它影响下游 agent 的判断质量，不构成流转信号通道（#405 落地后流转信号全部收口于 CLI）。" — `mouriya-s-lab/coder-loop#396` body
- **既有两域裁决（#411 body）**：A 域资产（trace / `status.json` / evidence / handoff）"业务资产，引擎不收编"；B 域事件流对 agent 凭证硬拒绝（`logs.query`，#409）。
- **可复用地基**：#406 run-scoped 凭证（env 注入、CLI 自动附带、daemon 解析成 `operator | agent(run)` 和类型）；#409 命令四类鉴权分级 + 编译期穷尽分类（`src/daemon.ts:127-186`）；#411 统一事件流（每 mutation 1-3 条审计事件）；`phaseExitsEpilogue` 是「引擎向 prompt 注入 CLI 用法说明」的先例（`src/loop.ts:5320-5330`）。
- **引擎自有跨 run 状态先例**：`item.sessionIds`（per phase × runner 的 resume 会话 id）——但只服务 runner 会话恢复，非内容通道。
- **CLAUDE.md 前提**："每个 agent 运行都是无状态的……持久业务语义只能依赖 GitHub（issues / labels / comments）"——本 RFC 是给这条前提补的引擎自有受控例外，新边界见「边界重述」节。

## 设计裁决（操作员，2026-07-02，RFC-3 子会话）

1. **与 `shared.md` 并存，不替代**："并存，他们的场景不同，shared.md 我自己的定位是额外的 chains 级别的 prompt 注入，注入什么运行时说了算没有任何行为定义"——`shared.md` 重定位为 chain 级自由 prompt 注入面（运行时决定内容，引擎与 preset 对其零行为定义），context CLI 是结构化传递通道，互不侵占。
2. **scope 集合**：`item`（同一 item 的跨 run/跨 phase 谱系——retry 轮次之间、phase 之间）+ `chain`（跨 item 的链级公告）+ `group`（并行分支组内通信；scope 键 = par 节点物化时的稳定容器 id，#546 已裁）。不设 `run` scope（run 内自说自话无传递价值）、不设跨 chain（chain 是隔离边界）。
3. **授权无粒度，chain 内随意读写**：不扩展 `[phases.rights]`。#406 凭证只做两件事——entry 的 author（chain/item/run/phase）从凭证推导、不可自报；可见范围天然限定在凭证所属 chain。operator 无凭证路径全量读写任意 chain。
4. **「必须调用」两档执法**：执法对象是工具的确定性输出条件（outcome，#547 裁决 G）——context CLI 的 outcome = 该 run 凭证 author 下存在至少一条 entry。DSL 按 phase 声明 `required`（run 收尾时 outcome 不成立 → 判 run 失败，走现有指数退避重试、耗尽 attempts 落 exhausted 终态）或 `expected`（outcome 不成立只发 validation 事件，不影响调度）。outcome 不成立即未履约——不存在「合规但不可观测」类别。声明语法归 RFC-2。

### 边界补充：区域共享不承担后继交付

context CLI 只承载一定区域内的共享信息：`item` scope 表示同一 item 谱系可共同观察的区域，`chain` / `group` scope 分别表示链与并行组区域。它不承载“前驱完成时必须交付给后继”的必需输入，也不参与完成判定、路径选择或后继 prompt 构造。

前驱到后继的信息流归任务转移：preset 为每条合法后继路径声明可选 prompt 模板及其全部输入绑定；由当前 agent 产生的值来自类型化 `exit.*` 对象，固定或外部值继续使用 preset 既有的 `item.*` / `chain.*` / `runtime.*` / typed literal、`required | default` 与 projection 规则。完整 transition commit 才是 item 完成事实，并成为后继 invocation/prompt 的输入。context entry 不得替代、补齐或伪造 transition state。

## 核心设计（从裁决展开）

### entry 模型

- **envelope 类型化、body 不透明**：envelope 含 id、ts、scope、author（从凭证推导；operator 写入 subject=operator）、body。引擎对 body 逐字携带、永不提取语义——不做正则、不识别 marker、body 里出现状态字面量或控制记号没有任何效果。这维持 #396「内容通道 ≠ 流转信号」边界，与 #411 excerpt 的 carry-not-parse 同构。
- **append-only**：entry 不可更新、不可删除（chain 级联删除除外）。消掉并行分支覆写竞争，与「每个 agent 运行无状态、做完即丢」前提一致。
- **一律经 daemon socket**：写入获得 #406 主体判定与审计事件；文件系统上不存在可直写的对应物。读取是 agent 可用的命令面（区别于 `logs.query` 的 agent 硬拒绝——context 读是 A 域内容通道，本来就是给 agent 的），agent 凭证读自己 chain，operator 读任意 chain；新命令进 #409 的编译期穷尽分类。

### 读取形态：拉取制

agent 用 CLI 按 scope / item / since 等条件过滤查询；引擎不把 entry 内容渲染进 prompt（否则作用域过滤白设计）。经现有 doc-binding 机制注入一段「CLI 用法 + 本 run 的 scope 标识」说明（`phaseExitsEpilogue` 同款先例），注入的是用法文档，不是内容。

### 存储与生命周期

- SQLite 新表，daemon 唯一写入方；查询过滤天然、GUI（RFC-5）直接消费、`chain delete` 级联清除。
- body 不设引擎自造的任意字节上限，也不截断。若底层 socket/SQLite/CLI 存在经实测和文档确认的真实协议边界，admission 必须点名该外部边界并显式拒绝；不得用魔法数代替流式/引用式大内容协议。超大二进制或证据仍走既有 evidence 路径，context entry 只携带引用。
- entries 与 chain 同生共死，无独立 GC。

### 「必须调用」执法机制

所有写经 socket，daemon 在 run 收尾点（#406 凭证吊销的同一收尾路径）求值 context CLI 的 outcome——该 run 凭证 author 下存在至少一条 entry；凭证收尾吊销使证据窗口与判定窗口闭合于同一点，无迟到证据、无判定后补写。`required` 下 outcome 不成立 = 该 run 判失败（与现有「phase 未履约 → 退避重试」语义同构，如 review 退出未写 status——同为 run 收尾的确定性输出条件执法）；`expected` 下 outcome 不成立 = 发 validation 事件。执法点是 run 收尾，与 phase 种类无关——对一切 run（含 trigger phase、#546 validator 判定器的 run）一视同仁，preset 对该类 phase 声明 required 即生效。引擎只求值输出条件，不验证内容质量、不追问调用动作——判断力归 LLM（CLAUDE.md preset 前提），引擎只做可计算判定。

context 读取无输出条件：read 不产生引擎可计算的确定性输出，不在 `required` 可执法域——「必须读」是 prompt 纪律，不是引擎执法项。若未来需要 required-read，唯一合法路径是先给读定义真实输出（如读回执落库），届时回 RFC 层裁决。

### 边界重述（对 CLAUDE.md 无状态前提与 #411 两域模型的受控修订）

- 每个 agent 运行**仍是无状态的**；持久业务语义**仍只依赖 GitHub**。context entries 是引擎自有的、chain 生命周期内的**受控中间态**：影响下游 agent 判断质量，不承载持久业务语义、不承载流转信号；chain 删除即消失，agent 不得把它当持久事实源。
- #411「A 域引擎不收编」修订为：A 域内容引擎仍不解析、不类型化其**语义**（body 不透明），但其中「跨 run 传递」这一子类的**传输与存储**由引擎提供服务（envelope 结构化、经 socket、可审计）。trace / evidence / `shared.md` 维持原状不收编。
- B 域边界不变：引擎事件流不进 agent 视野，`logs.query` 对 agent 仍硬拒绝；context 读是独立的 A 域命令面，不经运维观测面。

## 跨 RFC 接口假设

- **RFC-1（#546，已裁）**：`group` scope 键 = par 节点物化时的稳定容器 id，存储位随 #546 的树运行态 shape 承诺（其首个实现 child 设计期钉住）一并落定；通道边界已裁——context CLI 是并行分支间唯一的结构化、受控、可审计上下文通道；`shared.md` 保留现有创建与 prompt 注入行为，作为零行为定义的 chain 级自由 prompt 注入面；git 工作产物与 GitHub 面是产物通道，不属 context。**产物通道口径精化**（2026-07-10 修订，源 #546 body「答复 #545（RFC-3）」节，供给条款 2）：push 到 origin 的闭包分支 ref 属声明通道，agent 未发布的自建 ref 是 escape 类。逐字快照：

  > "裁决通道边界：context CLI 是并行分支间唯一的结构化、受控、可审计上下文通道；`shared.md` 保留现有创建与 prompt 注入行为，继续作为 chain 级自由 prompt 注入面，零行为定义，不进入 context entry 的 scope、授权或流转语义。git 工作产物与 GitHub 面是产物通道，不属 context；push 到 origin 的闭包分支 ref 属声明通道，agent 未发布的自建 ref 是 escape 类。「不存在文件系统旁路」不作为对 agent 行为的断言成立，改为对引擎的可证断言——引擎递出的跨任务面必须被显式分类；`shared.md` 是已声明的 chain prompt 注入面，不是遗漏旁路。"

  「不存在文件系统旁路」不再作为对 agent 行为的断言（agent 行为不可静态量化），改为对**引擎**的可证断言——引擎递出的每个跨任务面都必须显式分类（详见 #546 body「引擎递出面定理」节）。`shared.md` 保留现有创建与 prompt 注入行为，并明确归类为 chain 级自由 prompt 注入面：运行时决定内容，引擎与 preset 对内容零行为定义；它不提供 context entry 的结构、scope、授权、审计或流转语义。context CLI 是并行分支间唯一的结构化、受控、可审计上下文通道。并行汇合（join）后下游对上游分支 entries 的可读性已由「chain 内自由读」天然覆盖，无需额外契约。
- **RFC-2（#547，已答）**：per-phase「必须调用」声明采本 RFC 裁决 4 的 `required | expected` 两档词表，声明位为 `[[tools]]` 注册表 + per-phase `toolRequirements`，工具 provider/availability/outcome/enforcement 四轴正交建模，编译期依据工具有无 outcome（确定性输出条件）判定可执法性——`required` 仅对定义了 outcome 的工具合法，判据双向（不可伪造 + 构造性完备），provider 不参与判据；CLI 用法 doc binding 由 `toolRequirementsDoc` doc builder（per-phase 切片）承载。工具本体、outcome 达成通道与 outcome 求值/run-fail 执法机制归本 RFC。
- **RFC-4（#543 已对齐）**：hook 如需读共享 context，经本 CLI 的普通读取面（hook 以 operator 身份跑，走 operator 路径），不新增契约。
- **RFC-5（#544，已裁）**：entries 的 read API 及其 JSON shape 归**本 RFC**——daemon socket 读命令的返回 boundary（arktype）即 GUI 消费契约，#544 纯消费不定义（其 body 同步更新）；分页/过滤维度由 #730 固定为类型化过滤闭集与稳定 keyset cursor。

## 已裁决的实现边界

- v3 首版 envelope 不加入自由 `topic`/tag；scope、author 与 cursor 足够构成首版查询面，真实新场景出现后再以 ADT 字段演进。
- 读取过滤闭集由 #730 固定为：scope variant + stable key、author subject/phase、`after` cursor；请求必须显式给正整数 `pageSize`，服务端不驻留魔法默认值或总结果截断。cursor 是稳定 keyset，不使用 offset。
- 大内容不设引擎任意 hard cap、不截断；仅在发现并引用真实外部协议限制时显式拒绝，证据类大内容走 evidence 引用。
- `gh-issue-pr-iteration` 的 Intent/Result handoff 是否迁移属于独立 preset 产品决策，不阻塞本 RFC；本 RFC 不静默改变 `shared.md` 纪律。

## 约束

- 引擎对 entry body 零解析、零语义提取；body 内容不得影响任何调度或状态决策（#396 内容通道 ≠ 流转信号）。
- 不新增第三类主体：读写主体沿用 #406 的 `operator | agent(run)` 和类型。
- **代码红线（操作员裁决 2026-06-12，全仓 issue 统一）**：必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。依据：#78 / #109 原始约束、#453 契约 T3/T5。

## 关闭验证

逐条钉终态条件。本 RFC 是设计 issue：实现 children 落地时把各行具体化为可逐字重跑的命令；上述已裁边界由 children 具体化并保持同步。

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | 写入经 CLI 落库且 author 从凭证推导 | agent 凭证 env 下写一条 entry，尝试自报 author 字段 | entry 落库、author = 凭证所属 (chain,item,run,phase)；自报字段无效或被拒 |
| 2 | scope 过滤读取成立 | 同一 item 跨两轮 run 写 item-scope；另一 item 写 chain-scope；第三 chain 的 agent 读 | item 谱系跨 run 可读；chain-scope 跨 item 可读；跨 chain 零可见 |
| 3 | append-only | 命令面查证 + 尝试更新/删除已有 entry | 不存在 agent 可达的更新/删除路径 |
| 4 | body 不透明（对抗行） | body 内写入状态字面量、`FINALIZER SUMMARY` 等控制记号后跑完整 tick | 调度、状态机、trigger 判定零受影响 |
| 5 | `required` 执法 | 声明 required 的 phase 正常退出但未写 context | run 判失败进退避重试；耗尽 attempts 落 exhausted；audit/validation 事件可见原因 |
| 6 | `expected` 执法 | 声明 expected 的 phase 未写 context | 仅 validation 事件，phase 正常推进 |
| 7 | operator 全量路径与 GUI 消费面 | 无凭证读写任意 chain entries；read API 返回 GUI 可消费 JSON | exit 0；shape 与本 RFC read 命令的 arktype boundary 一致（#544 纯消费该契约） |
| 8 | chain 级联 GC | `chain delete` 后查 entries | 该 chain entries 全部清除 |
| 9 | `shared.md` 并存不受影响 | 跑既有 preset 全链 | `shared.md` 创建与注入行为与现状一致，零回归 |

## 范围外

- `shared.md` 的任何机制改动——重定位（chain 级自由 prompt 注入面）是定位陈述，不是本 RFC 的实施项。
- evidence / issues 目录与其余 A 域文件资产——维持 FS 约定不收编。
- 并行结构标识与并行通信的唯一性裁决——归 RFC-1。
- 「必须调用」的 DSL 声明语法与装载校验——归 RFC-2。
- entries 展示面——归 RFC-5。
- `gh-issue-pr-iteration` handoff 纪律迁移——preset 业务，另立 issue。
- #534 audit 修复树的 v2 缺陷——与本 RFC 并行不悖，不吸进范围。

## 本 issue 的验证边界

- **验证层级**：本 RFC umbrella 不直接运行测试，也不以任一 implementation PR 的局部测试关闭。
- **关闭所需证明**：所有直接 children 达到各自正文声明的验证深度；跨 child 的 v3 新语义接缝由 #684 在冻结合流 SHA 上证明；现有 bundled preset 兼容性由 #685 在发布候选 SHA 上证明。
- **不在本 issue 内执行**：不在 RFC 迭代中重复运行 `scripts/real-e2e.ts`，不把 compatibility E2E 绿解释成 `RFC: v3 context 共享 CLI——无状态 agent 的受控上下文传递` 的新语义已经成立。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。




---

## Comments (3)

### comment #4863549524 by `RiriAgent` — 2026-07-02T08:05:04Z
_(last edited 2026-07-10T06:12:33Z)_

RFC-2 已落地为 #547。接缝答复：「必须调用」声明语法采本 RFC 裁决 4 的 required | expected 两档词表，声明位为 `[[tools]]` 注册表 + per-phase toolRequirements；CLI 用法 doc binding 由 toolRequirementsDoc doc builder（per-phase 切片）承载。工具本体与「调用过」判定/run-fail 执法机制仍归本 RFC。



### comment #4866615198 by `RiriAgent` — 2026-07-02T14:05:38Z

## 实现 children 拆解登记（2026-07-02，W2 拆解会话）

本 RFC 拆解为 5 个原子实现 children（已挂 sub-issue）：

| child | 承接 | Depends on |
|---|---|---|
| #594（存储与写入面） | entry 模型、存储与生命周期、裁决 2/3 | 无（地基） |
| #595（读取命令面） | 拉取制读取、#544 消费契约（read boundary） | #594 |
| #596（group scope 真实化） | 裁决 2 的 group scope、#546 接口假设 | #594、#558 |
| #597（「必须调用」执法） | 裁决 4、执法机制、#547 接口假设 | #594、#595、#553 |
| #598（收尾对齐） | 边界重述落文档 | #594–#597 |

### 关闭验证行覆盖映射（并集完整，无缩水）

| RFC 行 | 承接 child |
|---|---|
| 1 写入经 CLI + author 凭证推导 | #594 |
| 2 scope 过滤读取 | #595 |
| 3 append-only | #594 |
| 4 body 不透明（对抗行） | #594 |
| 5 required 执法 | #597 |
| 6 expected 执法 | #597 |
| 7 operator 全量路径与 GUI 消费面 | #594（写半边）+ #595（读半边与 shape） |
| 8 chain 级联 GC | #594 |
| 9 shared.md 并存零回归 | #594 |

group scope 无 RFC 验证行——#596 的验收是 children 并集对 RFC 表的超集扩展（裁决 2 的 group 承诺落验收）。

### 开放问题分配（body「开放问题」节逐条）

1. envelope topic/tag 有无及形态 → #594 显式决策项（envelope shape 所有者；#595 按裁决消费做等值过滤）。
2. 读取过滤维度最小集与分页游标 → #595 显式决策项。
3. body 字节上限值与超限语义 → #594 显式决策项。
4. handoff 纪律迁移 → **有意不分配**（known-open）：body 明文「RFC 落地后另立 issue 裁量，不在本 RFC 预设结论」——不是遗漏，勿用 child 补位。

### 拆解期裁决（decision-closure，可判定项当场裁，登记于此）

- **scope 键解析有效性**（#594 预期结果 6）：落库 entry 的 scope 键必须解析到 chain 内真实存在的寻址对象（item 存在 / par 容器存在）。依据：与 admission default-deny 哲学一致（#397 先例），防 typo 静默丢失；无契约反证。
- **group scope 的 v2 语义**（#594 预期结果 7）：v2 无树运行态 ⇒ 无可寻址 par 容器 ⇒ group 写一律 admission 拒绝——是解析有效性的自然推论，非 stub；正路径归 #596（Depends on #558）。
- **scope 键指定方式不当场裁**，降为 #594 显式决策项，但钉住裁决约束：不得引入授权粒度——裁决 3「授权无粒度，chain 内随意读写」同时是上界与下界，任何收窄只能以寻址有效性为由。（对抗审查第一轮发现并修正：草稿曾把「group 键仅凭证推导、不可自报」钉为性质，与裁决 3 冲突，已收回。）
- **「调用过」判定事实**（#597 预期结果 2，RFC 执法机制的具体化）：= 该 run 凭证 author 下存在至少一条 entry；operator 写入与他 run 写入不算。

### 跨树边（总控简报已钉，已物化）

- 边 1：#558 → #596（group 键存储位随 #558 shape 设计 comment 落定；#558 的 Blocks 行已回填）。
- 边 4：#553 → #597（声明位与 toolRequirementsDoc；#553 的 Blocks 行已回填）。
- #595 的 read boundary 是 #544 消费契约（#544 body「接口假设」明文纯消费）；#544 children 待立（W2），其树拆解后引用 #595。
- #543（hook）经 operator 普通读取面，无新契约、无边。

### 对抗审查记录

- 第一轮（设计自洽面）：发现「group 键不可自报」与裁决 3 授权无粒度冲突——已修正（见上）。同轮核实：RFC body 各节 → children 映射穷尽（裁决 1 的 shared.md 重定位是定位陈述，正确落 #598 文档面与各 child 范围外，无机制 child——与 body「范围外」首条一致）。
- 第二轮（验收自身的洞）：#595 prompt 零注入行补 sentinel 断言；#594 各拒绝行错误信息措辞改为在「指定方式」两种裁决下都成立的形态。
- 第三轮（字段面 + 组合一致性）：限流 exit（#478，不消耗 attempt，spawn +1 于 `src/scheduler.ts:990`、回滚于 `1269`）与 required 执法叠加为幂等（已失败 run 的判定不改变账目），登记于 #597 上下文。
- 第四轮（引用保真 + 代码实态核对，24 条引用逐条比对）：修正一处三列表项无标记拼接、一处句号丢失、一处粗体丢失；**坐实一个实现陷阱**——`chain delete` 是软删（`handleChainDelete` 只写 `status:"deleted"`，`src/daemon.ts:1886`），schema 的 `ON DELETE CASCADE` 在现行命令下从不触发，RFC 行 8 的 entries 清除不能靠 FK 级联——已作为事实钉进 #594 上下文。此轮后连续扫描无新发现，判干涸。



### comment #4957324952 by `RiriAgent` — 2026-07-13T11:11:49Z

## Coder-loop umbrella finalizer (run-1783937728307-85-review-item-7)

## What was checked

- Live umbrella [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545): body, both comments, full five-child sub-issue graph, closing references, and relevant timeline entries. Every queried connection reported `hasNextPage=false`.
- Live children [#594](https://github.com/mouriya-s-lab/coder-loop/issues/594), [#595](https://github.com/mouriya-s-lab/coder-loop/issues/595), [#596](https://github.com/mouriya-s-lab/coder-loop/issues/596), [#597](https://github.com/mouriya-s-lab/coder-loop/issues/597), and [#598](https://github.com/mouriya-s-lab/coder-loop/issues/598): bodies, comments, parent links, closing PR references, and relevant timelines.
- Closing PR [#677](https://github.com/mouriya-s-lab/coder-loop/pull/677): body, all three PR comments, reviews, review threads, commits, checks, files, closing edge, and merge timeline. It has no formal reviews or review threads, no configured checks, an ordinary accepted review comment, and is merged into `main` as `d381d06c0a55385fb211283adcfb05ffade94f88`.
- Dependency state relevant to remaining children: [#553](https://github.com/mouriya-s-lab/coder-loop/issues/553) is open with no closing PR; [#558](https://github.com/mouriya-s-lab/coder-loop/issues/558) is open and its closing PR [#675](https://github.com/mouriya-s-lab/coder-loop/pull/675) is still open.
- Central chain `v3-594`: one queue item only, #594=`done`; `continuable=0`, `terminal=1`, chain still `active` during this finalizer.

## Child closure table

| Child | GitHub / review closure | Queue / local evidence | Conclusion |
|---|---|---|---|
| #594 | CLOSED (`COMPLETED`); PR #677 MERGED; accepted review at [PR comment](https://github.com/mouriya-s-lab/coder-loop/pull/677#issuecomment-4957258619); durable [issue closure record](https://github.com/mouriya-s-lab/coder-loop/issues/594#issuecomment-4957262111) | queue item `done`; `evidence/594/verify-retry/report.md`; `evidence/594/e2e-retry-run-1783926267449-72/report.md`; `evidence/594/replay-run-1783937728307-85-review-item-7/` | Complete |
| #595 | OPEN; no closing PR, review, or closure record | not queued; depends only on completed #594 | Remaining, executable next child |
| #596 | OPEN; no closing PR, review, or closure record | not queued; depends on completed #594 and open #558 / open PR #675 | Remaining, dependency-gated |
| #597 | OPEN; no closing PR, review, or closure record | not queued; depends on #595 and open #553 | Remaining, dependency-gated |
| #598 | OPEN; no closing PR, review, or closure record | not queued; depends on #594–#597 | Remaining, final gated documentation child |

## Remaining scope

The umbrella's own decomposition comment explicitly assigns its incomplete verification rows to #595–#598. No new issue is needed: those four existing sub-issues represent the remaining coherent scope.

[#595](https://github.com/mouriya-s-lab/coder-loop/issues/595) is the next executable follow-up and should be injected into `v3-594` with preset `gh-issue-pr-iteration`. This finalizer cannot safely perform that mutation: `presets/gh-issue-pr-iteration/preset.toml` deliberately gives `createItems` only to `review` and states that `umbrella-finalizer` inherits default-deny. Bypassing the run credential to impersonate an operator would violate that admission contract. #596, #597, and #598 should remain proposed until their published dependencies are satisfied.

## Local evidence

- Chain handoff: `/Users/mouriya/.coder-loop/loop-data/chains/v3-594/shared.md`
- Accepted verification: `/Users/mouriya/.coder-loop/loop-data/chains/v3-594/evidence/594/verify-retry/report.md`
- Accepted direct/canonical E2E: `/Users/mouriya/.coder-loop/loop-data/chains/v3-594/evidence/594/e2e-retry-run-1783926267449-72/report.md`
- Independent review replay: `/Users/mouriya/.coder-loop/loop-data/chains/v3-594/evidence/594/replay-run-1783937728307-85-review-item-7/`
- Final review trace: `/Users/mouriya/.coder-loop/loop-data/chains/v3-594/runs/run-1783937728307-85-review-item-7/review/`

## Finalizer decision

`keep-active`. Do not close #545: four explicit children remain open, two have live external dependency gates, and the next executable child #595 is not yet in the chain queue. No PR was merged, no child was closed, and no merged record was edited by this finalizer.



---

## Timeline (45)

- 2026-07-02T07:53:38Z `assigned` @RiriAgent
- 2026-07-02T07:59:59Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-02T08:04:39Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-02T08:05:04Z `commented` @RiriAgent
- 2026-07-02T09:33:31Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-02T10:29:07Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T10:29:09Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-02T11:12:30Z `cross-referenced` @RiriAgentsrc=553
- 2026-07-02T11:15:41Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-02T11:15:55Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-02T11:17:47Z `cross-referenced` @RiriAgentsrc=562
- 2026-07-02T12:02:05Z `cross-referenced` @RiriAgentsrc=574
- 2026-07-02T12:02:26Z `cross-referenced` @RiriAgentsrc=583
- 2026-07-02T14:03:55Z `cross-referenced` @RiriAgentsrc=594
- 2026-07-02T14:04:08Z `cross-referenced` @RiriAgentsrc=595
- 2026-07-02T14:04:23Z `cross-referenced` @RiriAgentsrc=596
- 2026-07-02T14:04:29Z `cross-referenced` @RiriAgentsrc=597
- 2026-07-02T14:04:40Z `cross-referenced` @RiriAgentsrc=598
- 2026-07-02T14:05:19Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:05:20Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:05:21Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:05:22Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:05:23Z `sub_issue_added` @RiriAgent
- 2026-07-02T14:05:38Z `commented` @RiriAgent
- 2026-07-10T05:26:58Z `cross-referenced` @RiriAgentsrc=601
- 2026-07-10T05:32:20Z `referenced` @RiriAgentcommit=49d84106d5a3a23d8420278a739d6d4f992758ce
- 2026-07-10T11:21:10Z `cross-referenced` @RiriAgentsrc=567
- 2026-07-13T11:11:49Z `commented` @RiriAgent
- 2026-07-15T10:52:19Z `cross-referenced` @RiriAgentsrc=683
- 2026-07-17T20:13:25Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:13:34Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-17T20:36:53Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:36:55Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:37:02Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-17T20:37:04Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:37:06Z `cross-referenced` @RiriAgentsrc=732
- 2026-07-17T20:37:08Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-17T20:37:11Z `cross-referenced` @RiriAgentsrc=734
- 2026-07-17T20:37:20Z `cross-referenced` @RiriAgentsrc=738
- 2026-07-17T20:37:34Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:04Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:40:05Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:40:06Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:40:07Z `sub_issue_added` @RiriAgent
- 2026-07-17T20:40:08Z `sub_issue_added` @RiriAgent