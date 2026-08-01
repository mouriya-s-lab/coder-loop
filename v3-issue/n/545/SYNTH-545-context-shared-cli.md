# SYNTH-#545 v3 context 共享 CLI 与受控上下文传递

> 本文档是**本地合成**，未写回 GitHub。依据 RFC #545 与其全部 sub-issue 合并而成。
> 来源：`v3-issue/issues/<N>/`（issue.json + comments.json + timeline.json + subissues.json）+ `v3-issue/design/`。

## 范围与组成

- **源 RFC**：#545 — RFC: v3 context 共享 CLI——无状态 agent 的受控上下文传递
- **子 issue 总数**：10（OPEN 5 / CLOSED·COMPLETED 1 / CLOSED·NOT_PLANNED 4）
- **本合成 issue 编号**：`SYNTH-#545`（仅本地标识）

---

## 一、RFC 设计骨架（#545 原文）

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

## 二、当前实现 children（OPEN，当前 spec）

### #730 feat(cli): context scope 过滤读取与 GUI boundary

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545) 的共享契约与关闭验证。

## 目标

交付 item/chain/group 查询与 pagination 读取面。

落地 context entry 的读取命令面——经 daemon socket 的过滤查询、分页游标、以及作为 GUI 消费契约的 arktype 返回 boundary。

## 问题

地基 child 落地后 entries 只写不可读：agent 侧无任何拉取命令，#545「拉取制」读取形态没有载体；#544 的 entries 展示面没有可消费的 read boundary（其接口假设明文等待 #545 的实现 child）。

## 预期结果

性质表述：

1. **可见范围恒等于凭证所属 chain**：agent 凭证下的一切查询路径，结果集都限定在凭证所属 chain——跨 chain 零可见不依赖调用方自觉，由 daemon 从凭证推导，请求里的 chain 指定字段对 agent 无效或被拒。operator 无凭证读任意 chain。
2. **过滤维度经 arktype 请求 boundary 穷尽声明**：闭集为 scope variant + stable key、author subject/phase、`after` cursor；未声明参数被 boundary parse 拒绝，不存在隐藏过滤参数。
3. **返回 boundary 即 GUI 消费契约**：读命令返回经 arktype boundary 校验的 JSON（envelope 全字段 + 分页游标），#544 纯消费；shape 后续变更须在 PR body 显式列 diff（#544 的消费依赖）。
4. **引擎不把 entry 内容渲染进 prompt**：读取只经本命令面拉取；prompt 渲染路径（`renderPrompt`/doc builders）不出现 entries 内容注入。
5. **分页游标在 append-only 存储上稳定**：使用 `(ts, id)` 或等价单调稳定键的 keyset cursor；翻页期间新写入不导致漏读已有 entry 或重复游标。请求必须显式提供正整数 `pageSize`；引擎无魔法默认页长、无总结果截断，调用方沿 cursor 读至 exhausted。
6. 命令进 #409 编译期穷尽分类，agent 可用（区别于 `logs.query` 硬拒绝）。

### 查询契约裁决

- 过滤闭集：scope variant + stable key、author subject/phase、`after` cursor。无 topic/tag、无 offset、无自由查询字符串。
- `pageSize` 是每次请求的显式正整数，不提供引擎默认 magic number；响应返回 `nextCursor | exhausted`，调用方必须可持续翻页至穷尽。若底层 transport 出现真实单响应限制，必须引用该限制并以 boundary error 暴露，不得静默缩页或截断全集。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | scope 过滤读取成立（RFC 关闭验证行 2） | 同一 item 跨两轮 run 写 item-scope；另一 item 写 chain-scope；第三 chain 的 agent 凭证读 | local | item 谱系跨 run 可读；chain-scope 跨 item 可读；跨 chain 零可见 |
| function | agent 无法越 chain（主体对抗） | agent 凭证请求中显式指定他 chain 的标识查询 | local | 指定字段无效或被拒，结果仍限本 chain |
| function | operator 全量读 + GUI shape（RFC 行 7） | 无凭证读任意 chain entries，输出过 arktype boundary 断言 | local | exit 0；shape 与 read boundary 一致（#544 纯消费该契约） |
| function | 过滤维度逐一生效 | 对 scope、author subject/phase、after cursor 各构造命中/不命中查询（`bun test` 用例断言结果集） | local | 每维度命中集正确；boundary 外参数被拒 |
| function | 分页游标稳定 | 写入 N 条后按显式 pageSize 翻页至 exhausted，翻页间再写入新 entry | local | 已有 entries 无漏读无重复；新 entry 不打乱游标 |
| adversarial | prompt 零内容注入 | `bun test` 含用例：store 预置 body 为唯一 sentinel 串的 entries 后渲染各 phase prompt，断言渲染产物零 sentinel 命中 | local | 断言通过——entry 内容不经任何渲染路径进 prompt |
| type | boundary 精确 | `bun run typecheck`；审查请求/返回 boundary 定义 | local | 通过；请求与返回均为精确 arktype schema，无匿名 `"object"` |

## 依赖关系

- Depends on: #594。
- Blocks: #731、#734、#727。


### #731 feat(engine): real-par context group scope

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545) 的共享契约与关闭验证。

## 目标

必须依赖真实 par 生产调度，以两个真实并行 branch credential 写读同一稳定 group id；禁止直接 store fixture 冒充。

group scope 从「一律拒绝」真实化为可用：par 容器内的 run 写 group entry 时，daemon 从 #558 的树运行态推导容器稳定 id 作为 scope 键；读取按 group 键过滤命中同组 entries。

## 问题

地基 child 落地后 group variant 只有拒绝路径：daemon 无从推导写入者所属的 par 容器（v2 无树运行态）。#546 已裁 context CLI 是并行分支间唯一的结构化、受控、可审计上下文通道——par 调度（#698/#700）落地后，并行分支之间将不存在任何合法的引擎提供上下文通道，「平行函数」的通信面缺失。

## 预期结果

性质表述：

1. **正路径**：凭证所属 item 位于 par 容器内时，group 写入被接受，默认键（凭证推导）= #558 shape 存储位中该容器的稳定 id；同容器其他分支的 run 按 group 过滤可命中。
2. **键解析真实容器**：无论凭证推导还是显式指定（指定方式按地基 child 决策项裁决，不得引入授权粒度），落库的 group 键都解析到树运行态中真实存在的 par 容器——不存在指向虚空的 group entry（地基 child「scope 键解析有效」性质在 group 维度的真实化）。
3. **拒绝分支不变**：不存在可寻址 par 容器时的 admission 拒绝语义与地基 child 完全一致——不出现「树存在与否」的双路径兜底。
4. **join 后可读性零新增契约**：容器 terminal 后，下游 agent 经 chain 内自由读可见上游分支全部 entries（含 group entries）——由裁决 3 的 chain 可见性天然覆盖，本 child 不添加任何 join 专属读取逻辑。
5. 树节点消费经穷尽 switch：容器谱系遍历对 #558 的节点 ADT 穷尽，新增节点 variant 由编译器暴露处置点。

### 显式决策项（落地时裁，裁决留本 thread）

- 嵌套 par 下的 group 键取值：最近祖先容器单键，还是祖先链多容器可分别过滤——过滤结果可观察（目标级分叉），取决于 #558 shape 对容器谱系的表示形态，以其 shape 设计 comment 为输入裁决。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| assumption | #558 shape 契约输入在手 | 查 #558 comments | GitHub | shape 设计 comment 存在且写明 par 容器稳定 id 的存储位；本 child 实现引用该 comment |
| function | 同组互见 | fixture 构造 `par(leaf, leaf)` 树运行态（不经调度），两分支 run 凭证各写 group entry 后互相按 group 读 | local | 双向命中；scope 键 = 该容器稳定 id |
| function | 组外不命中 | 同 chain 容器外 item 的 run 按 group 过滤读 | local | 不命中该组 entries（chain-scope 读仍可见——scope 是过滤维度非可见性边界） |
| function | 键解析校验 | 显式指定不存在的 group 键写入（经允许显式指定的路径） | local | admission 拒绝，错误点名容器不存在；不产生指向虚空的 entry |
| function | 拒绝分支不变 | 无容器 item 的 run 凭证写 group entry（凭证推导路径） | local | admission 拒绝，行为与地基 child 验收一致 |
| function | join 后下游可读 | 容器置 terminal 后，同 chain 后续 leaf 的 run 凭证读上游分支 entries | local | chain 内自由读命中，无 join 专属逻辑参与 |
| type | 穷尽消费 | `bun run typecheck`；审查容器谱系遍历对节点 ADT 的 switch | local | 通过；穷尽检查在位 |

## 依赖关系

- Depends on: #594、#730、#698、#699。
- Blocks: #734。


### #732 feat(engine): ordinary run context required/expected 执法

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545) 的共享契约与关闭验证。

## 目标

只在普通 scheduler run 的可达 credential/finalize 路径交付 required|expected。

消费 #738 的 `[[tools]]` / `toolRequirements` 声明位：把 context CLI 注册为 `provider = engine` capability union 的第一个真实成员（含用法文档内容），其 entries 存在性条件是 outcome（确定性输出条件）的首个 variant（entry-existence）；在 run 收尾点落地对 outcome 求值的 `required | expected` 两档执法。

## 问题

#738 落地后声明位在引擎侧没有执法消费端：`required`/`expected` 声明无运行期判定，缺写不产生任何后果；context CLI 未注册为 engine capability 成员，preset 无法在 `[[tools]]` 引用它；`toolRequirementsDoc` 对 engine 工具没有用法内容可渲染。「可选的 prompt 要求必须调用某种特殊定义的 CLI 工具」（v3 目标 4 verbatim）的执法半边悬空。

## 预期结果

性质表述：

1. **capability 注册**：context CLI 是引擎闭合 capability union 的成员，携带覆盖读写两面的用法文档内容；`toolRequirementsDoc` 渲染声明该工具的 phase 时输出该用法（注入的是用法文档，不是 entry 内容）。成员经穷尽 switch 消费——新增 capability 由编译器暴露全部处置点。
2. **判定事实唯一且可计算**：判定是对该工具 outcome（确定性输出条件）的求值，provider 不参与判定——context CLI 的 outcome = entry-existence：该 run 的凭证 author 下存在至少一条 entry（entries 表存在性查询），求值的是输出条件，不是调用动作；首波 outcome union 仅 entry-existence 一个 variant。引擎不验内容质量、不看 body。
3. **required 缺写 = run 判失败**：进入现有指数退避重试链路、消耗 attempt、耗尽落 exhausted 终态——复用 `withNextSchedulerBackoff` / `exhaustItemsOverAttemptLimitForRepo` 既有机制，不自立失败通道；audit/validation 事件写明失败原因（缺 required context 写入）。
4. **expected 缺写 = 仅 validation 事件**：调度、状态、attempts 零影响。
5. **执法与 phase 种类无关**：判定逻辑只依赖「run 收尾 + 该 phase 的 toolRequirements 声明」，源码中不存在按 phase 种类（trigger / validator / 普通）豁免或特判的分支——声明即生效，对一切 run 一视同仁。
6. **未声明零扰动**：未声明 toolRequirements 的 phase，run 收尾路径行为与现状完全一致。

### 显式决策项（落地时裁，裁决留本 thread）

- 「本 run 的 scope 标识」注入形态：#406 凭证已让 daemon 端到端推导 author 与 scope 键，用法文档可能无需携带运行时 id（agent 直接调命令即可正确寻址）。按凭证推导充分性裁决；若裁定不注入具体 id（偏离 #545「CLI 用法 + 本 run 的 scope 标识」的字面），在本 thread 记录理由与 #545 登记 comment 同步。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | required 执法（RFC 关闭验证行 5） | fixture preset 声明 required 的 phase 正常退出（exit 0）但未写 context | local | run 判失败进退避重试；耗尽 attempts 落 exhausted；audit/validation 事件可见「缺 required context 写入」原因 |
| function | expected 执法（RFC 行 6） | fixture 声明 expected 的 phase 未写 context | local | 仅 validation 事件；phase 正常推进，attempts 不受影响 |
| function | required 满足零干预 | required phase 的 run 写入一条 entry 后正常退出 | local | run 成功、正常推进，无失败标记与退避 |
| function | 一视同仁（无种类豁免） | fixture 对 trigger phase 声明 required，其 run 未写 context | local | 同样判失败——与普通 phase 行为一致 |
| function | 用法文档注入 | fixture 声明 required 后渲染该 phase prompt | local | `toolRequirementsDoc` 输出含 context CLI 读写两面用法；不含任何已有 entry 内容 |
| adversarial | 判定不看 body | `bun test` 含用例：run 写入 body 为空白/控制记号的 entry，required 判定通过；未写任何 entry 时无论其他 run 写了多少，该 run 仍判失败 | local | 断言通过：判定事实仅为「本 run 存在性」，与 body 内容、他 run 写入无关 |
| type | capability union 穷尽 | `bun run typecheck`；审查 capability 成员消费 switch | local | 通过；穷尽检查在位，无 stringly 工具名分支 |
| integration | 执法证据闭环（自 #738 移交，编译半边留 #738） | 对 required 工具分别使 outcome 成立与不成立 | local | run finalize 分别通过/失败；provider 不参与判定，outcome 才是判据 |

## 依赖关系

- Depends on: #594、#738。
- Blocks: #733、#734、#744。



### #733 feat(engine): trigger 与 validator context outcome 集成

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545) 的共享契约与关闭验证。

## 目标

在 trigger/validator 已迁入统一 scheduler run lifecycle 后验收正负写入与 finalize；不以无 credential 的失败路径冒充。

消费 #738 的 `[[tools]]` / `toolRequirements` 声明位：把 context CLI 注册为 `provider = engine` capability union 的第一个真实成员（含用法文档内容），其 entries 存在性条件是 outcome（确定性输出条件）的首个 variant（entry-existence）；在 run 收尾点落地对 outcome 求值的 `required | expected` 两档执法。

## 问题

#738 落地后声明位在引擎侧没有执法消费端：`required`/`expected` 声明无运行期判定，缺写不产生任何后果；context CLI 未注册为 engine capability 成员，preset 无法在 `[[tools]]` 引用它；`toolRequirementsDoc` 对 engine 工具没有用法内容可渲染。「可选的 prompt 要求必须调用某种特殊定义的 CLI 工具」（v3 目标 4 verbatim）的执法半边悬空。

## 预期结果

性质表述：

1. **capability 注册**：context CLI 是引擎闭合 capability union 的成员，携带覆盖读写两面的用法文档内容；`toolRequirementsDoc` 渲染声明该工具的 phase 时输出该用法（注入的是用法文档，不是 entry 内容）。成员经穷尽 switch 消费——新增 capability 由编译器暴露全部处置点。
2. **判定事实唯一且可计算**：判定是对该工具 outcome（确定性输出条件）的求值，provider 不参与判定——context CLI 的 outcome = entry-existence：该 run 的凭证 author 下存在至少一条 entry（entries 表存在性查询），求值的是输出条件，不是调用动作；首波 outcome union 仅 entry-existence 一个 variant。引擎不验内容质量、不看 body。
3. **required 缺写 = run 判失败**：进入现有指数退避重试链路、消耗 attempt、耗尽落 exhausted 终态——复用 `withNextSchedulerBackoff` / `exhaustItemsOverAttemptLimitForRepo` 既有机制，不自立失败通道；audit/validation 事件写明失败原因（缺 required context 写入）。
4. **expected 缺写 = 仅 validation 事件**：调度、状态、attempts 零影响。
5. **执法与 phase 种类无关**：判定逻辑只依赖「run 收尾 + 该 phase 的 toolRequirements 声明」，源码中不存在按 phase 种类（trigger / validator / 普通）豁免或特判的分支——声明即生效，对一切 run 一视同仁。
6. **未声明零扰动**：未声明 toolRequirements 的 phase，run 收尾路径行为与现状完全一致。

### 显式决策项（落地时裁，裁决留本 thread）

- 「本 run 的 scope 标识」注入形态：#406 凭证已让 daemon 端到端推导 author 与 scope 键，用法文档可能无需携带运行时 id（agent 直接调命令即可正确寻址）。按凭证推导充分性裁决；若裁定不注入具体 id（偏离 #545「CLI 用法 + 本 run 的 scope 标识」的字面），在本 thread 记录理由与 #545 登记 comment 同步。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | required 执法（RFC 关闭验证行 5） | fixture preset 声明 required 的 phase 正常退出（exit 0）但未写 context | local | run 判失败进退避重试；耗尽 attempts 落 exhausted；audit/validation 事件可见「缺 required context 写入」原因 |
| function | expected 执法（RFC 行 6） | fixture 声明 expected 的 phase 未写 context | local | 仅 validation 事件；phase 正常推进，attempts 不受影响 |
| function | required 满足零干预 | required phase 的 run 写入一条 entry 后正常退出 | local | run 成功、正常推进，无失败标记与退避 |
| function | 一视同仁（无种类豁免） | fixture 对 trigger phase 声明 required，其 run 未写 context | local | 同样判失败——与普通 phase 行为一致 |
| function | 用法文档注入 | fixture 声明 required 后渲染该 phase prompt | local | `toolRequirementsDoc` 输出含 context CLI 读写两面用法；不含任何已有 entry 内容 |
| adversarial | 判定不看 body | `bun test` 含用例：run 写入 body 为空白/控制记号的 entry，required 判定通过；未写任何 entry 时无论其他 run 写了多少，该 run 仍判失败 | local | 断言通过：判定事实仅为「本 run 存在性」，与 body 内容、他 run 写入无关 |
| type | capability union 穷尽 | `bun run typecheck`；审查 capability 成员消费 switch | local | 通过；穷尽检查在位，无 stringly 工具名分支 |
| integration | 执法证据闭环（自 #738 移交，编译半边留 #738） | 对 required 工具分别使 outcome 成立与不成立 | local | run finalize 分别通过/失败；provider 不参与判定，outcome 才是判据 |

## 依赖关系

- Depends on: #700、#705、#706、#732、#738。
- Blocks: #734、#744。



### #734 docs(v3): context 冻结 SHA 综合验收

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-17

## 必须先读的关联 issue

继承 [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545) 的共享契约与关闭验证。

## 目标

唯一综合 owner；新增真实 parallel group communication 关闭行。

context CLI 全部结构性 children 落地后，把 #545 边界重述与并存定位同步进仓内文档——CLAUDE.md 无状态前提、docs/ 的 shared.md/handoff 叙述、preset 作者手册。

## 问题

C1–C4 落地后，CLAUDE.md 前提的「如果要用本地状态，必须每次做完即丢弃。持久业务语义只能依赖 GitHub」不再是全量事实——引擎多了 chain 生命周期内的受控中间态；docs 各处「shared.md 是 agent 间传递面」的叙述缺并存分工。文档 drift 是一等偏离（#708 同款收尾先例）：不对齐则每个后续 headless agent 都读到与运行时矛盾的前提。

## 预期结果

性质表述：

1. CLAUDE.md 前提节以 #545 边界重述为准更新：受控中间态例外（chain 生命周期内、不承载持久业务语义与流转信号、删链即消失、不得当持久事实源）写入前提本文——**替换改写，不留新旧并存叠层**（旧断言 + 「但现在……」式补丁是禁止形态）。
2. docs/ 每处 shared.md/handoff 叙述现场与 context CLI 的并存分工一句到位：shared.md = chain 级自由 prompt 注入面（运行时定内容、零行为定义），context CLI = 结构化受控传递通道——引用 #545 裁决 1 语义，不复制机制细节。
3. preset 作者手册（docs/preset-authoring.md）含 context CLI 命令面与 toolRequirements 执法语义的作者视角说明；前序 children 新增的 binding/doc builder（若有）已按既有计数守护流程入册。
4. 全部修订读起来像第一次就这么写（no-legacy）：无删除线、无「更新：」叠层、无被否定旧段残留。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | CLAUDE.md 前提对齐 | 读 `CLAUDE.md` 无状态前提节 | local | 含受控中间态例外与其四个边界（chain 生命周期内 / 不承载持久业务语义 / 不承载流转信号 / 不得当持久事实源）；无新旧叠层 |
| function | shared.md 现场逐点对齐 | 对上下文节清单的每个命中文件逐点核读 | local | 每处有并存分工表述或确认无需改（逐点结论留 PR body）；无残留「唯一传递通道」类断言 |
| function | 作者手册覆盖 | 读 `docs/preset-authoring.md` context 相关节 | local | 命令面与 required\|expected 执法语义有作者视角说明 |
| environment | 计数守护绿 | `bun test` | local | 全绿（含 binding/doc 计数守护，若前序 children 有增改） |
| assumption | 实态一致 | 对照实现后的命令面（`coder-loop --help` 及新命令 help）核对文档所述 | local | 文档命令名/语义与实态一致，无凭记忆写入的漂移 |

## 伞 #545 的关闭终态条件（本 issue 复核对象）

以下是伞 #545 的关闭终态条件。本 issue 负责在冻结 SHA 上逐条复核并留证据；任一行不成立时回到拥有该契约的实现 issue 修复，不在本 issue 内写产品修复。

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | 写入经 CLI 落库且 author 从凭证推导 | agent 凭证 env 下写一条 entry，尝试自报 author 字段 | entry 落库、author = 凭证所属 (chain,item,run,phase)；自报字段无效或被拒 |
| 2 | scope 过滤读取成立 | 同一 item 跨两轮 run 写 item-scope；另一 item 写 chain-scope；第三 chain 的 agent 读 | item 谱系跨 run 可读；chain-scope 跨 item 可读；跨 chain 零可见 |
| 3 | append-only | 命令面查证 + 尝试更新/删除已有 entry | 不存在 agent 可达的更新/删除路径 |
| 4 | body 不透明（对抗行） | body 内写入状态字面量、`FINALIZER SUMMARY` 等控制记号后跑完整 tick | 调度、状态机、trigger 判定零受影响 |
| 5 | `required` 执法 | 声明 required 的 phase 正常退出但未写 context | run 判失败进退避重试；耗尽 attempts 落 exhausted；audit/validation 事件可见原因 |
| 6 | `expected` 执法 | 声明 expected 的 phase 未写 context | 仅 validation 事件，phase 正常推进 |
| 7 | operator 全量路径与 GUI 消费面 | 无凭证读写任意 chain entries；read API 返回 GUI 可消费 JSON | exit 0；shape 与 #545 read 命令的 arktype boundary 一致（#544 纯消费该契约） |
| 8 | chain 级联 GC | `chain delete` 后查 entries | 该 chain entries 全部清除 |
| 9 | `shared.md` 并存不受影响 | 跑既有 preset 全链 | `shared.md` 创建与注入行为与现状一致，零回归 |

## 依赖关系

- Depends on: #730、#731、#732、#733。
- Blocks: #545 closure。



---

## 三、已落地 children（CLOSED·COMPLETED，含关闭证据）

### #594 feat(engine): context 共享存储与写入面——envelope ADT、SQLite append-only 表与凭证推导 author

- state: **CLOSED·COMPLETED（已落地）** | author: `RiriAgent` | created: 2026-07-02
- closed: 2026-07-13
- 关联: referenced `22b68aae1ffc`, referenced `d381d06c0a55`, referenced `05ee53cc4202`

## 必须先读的关联 issue

#545（RFC: v3 context 共享 CLI——无状态 agent 的受控上下文传递）。本 child 是该 RFC 的地基 child，继承条款逐字快照：

> "envelope 含 id、ts、scope、author（从凭证推导；operator 写入 subject=operator）、body。引擎对 body 逐字携带、永不提取语义——不做正则、不识别 marker、body 里出现状态字面量或控制记号没有任何效果。" — #545「entry 模型」

> "**append-only**：entry 不可更新、不可删除（chain 级联删除除外）。消掉并行分支覆写竞争，与「每个 agent 运行无状态、做完即丢」前提一致。" — #545「entry 模型」

> "**一律经 daemon socket**：写入获得 #406 主体判定与审计事件；文件系统上不存在可直写的对应物。" — #545「entry 模型」

> "**scope 集合**：`item`（同一 item 的跨 run/跨 phase 谱系——retry 轮次之间、phase 之间）+ `chain`（跨 item 的链级公告）+ `group`（并行分支组内通信；scope 键 = par 节点物化时的稳定容器 id，#546 已裁）。不设 `run` scope（run 内自说自话无传递价值）、不设跨 chain（chain 是隔离边界）。" — #545 设计裁决 2

> "**授权无粒度，chain 内随意读写**：不扩展 `[phases.rights]`。#406 凭证只做两件事——entry 的 author（chain/item/run/phase）从凭证推导、不可自报；可见范围天然限定在凭证所属 chain。operator 无凭证路径全量读写任意 chain。" — #545 设计裁决 3

> - "SQLite 新表，daemon 唯一写入方；查询过滤天然、GUI（RFC-5）直接消费、`chain delete` 级联清除。"
> - "body 不设引擎自造的任意字节上限，也不截断；真实外部协议边界必须点名来源并显式拒绝，证据类大内容走 evidence 引用。"
> - "entries 与 chain 同生共死，无独立 GC。"
>
> — #545「存储与生命周期」（三条列表项）

## 目标

落地 context entry 的持久化与写入命令面——envelope ADT、SQLite append-only 新表、经 daemon socket 的写入命令、author 凭证推导、admission 与审计。

## 使用场景

agent 在 run 内经 CLI 写入一条 context entry（scope = item / chain / group），供同 item 后续 run/phase 或链内其他 item 的 agent 经读取面（后续 child）取回；operator 无凭证直接向任意 chain 写公告 entry。基座 child：为读取面、group scope 真实化、「必须调用」执法三个后续 child 提供唯一的存储与写入事实源。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行 grep 核对）。

- 唯一现存传递通道 shared.md：`ensureChainRuntimeLayout` 创建（`src/daemon.ts:1629`，`wx` flag、EEXIST 静默）；之后 agent 按 prompt 纪律文件系统直写 append——不经 daemon、无鉴权、无审计、无结构。
- #406 run-scoped 凭证：spawn 时 mint + env 注入（`src/scheduler.ts:1043-1048`，`LOOP_RUN_CREDENTIAL_ENV`）；CLI 自动附带 `withInjectedRunCredential`（`src/loop.ts:2162`，allow-list `AGENT_ATTRIBUTED_COMMANDS` `src/loop.ts:2193`）；daemon 侧 `resolveItemMutationCaller`（`src/daemon.ts:3182-3223`）解析为 `ItemMutationCaller = { kind:"operator" } | { kind:"agent", runId, phase }`（`src/daemon.ts:505-507`）——author 推导的现成来源。
- #409 命令鉴权分类：`DaemonCommandAuthClass` 四类（`src/daemon.ts:127-131`）、`DaemonCommandName` union（`133-173`）、`buildDaemonCommandSpecs` 的 `Record<DaemonCommandName, DaemonCommandSpec>` 穷尽映射（`1275-1307`）、`runAuthorizationGate` 穷尽 switch（`1332`，`assertNeverDaemonCommandAuthClass` `4934`）。新命令必须进这套编译期穷尽面。
- 审计事件先例（#411）：每条 mutation 1-3 条事件；`item.status.write_admission` emit 于 `src/daemon.ts:3150`；validation kind 样例 `daemon.preset_load_failed`（`src/observability.ts:352-375`）；事件 union `ObservabilityEventBoundary`（`src/observability.ts:243` 起）。
- SQLite 加表流程：`STATE_SCHEMA_VERSION = 13`（`src/sqlite-state.ts:488`）→ bump + `STATE_SCHEMA_SQL`（`436`）加 CREATE TABLE → `stateSchemaExists`（`536-544`）→ `migrateStateSchema`（`591-716`）事务内迁移。现有表仅 chains/items/runs/current_runs。
- **`chain delete` 是软删（GC 实现陷阱）**：`handleChainDelete` 只写 `status: "deleted"`（`src/daemon.ts:1879-1896`，写入 `1886`），chains 行从不物理 DELETE；schema 里 items/runs/current_runs 的 `ON DELETE CASCADE`（`src/sqlite-state.ts:448-461` 一带）在现行命令下**从不触发**。RFC 行 8 钉的是结果（delete 后 entries 全清）——实现不能靠 FK 级联，须在 `chain delete` 路径对 entries 显式清除（或等价机制）。
- 命名冲突已核：`src/` 内无任何 `context` 子命令、命令名或表名；现有 `context` 命中均为 `SchedulerRunCredentialContext`/`ResolveContext` 等无关结构，`sharedContextPath` 是 chain 级 shared.md 的 binding key（`src/loop.ts:1013`，消费 `src/scheduler.ts:2214`）。

## 问题

> "**唯一现存传递通道是 `shared.md`**……不经 daemon、无鉴权、无审计、无结构、整链单文件全量读；并行分支同时 append 是竞争源。" — #545「现状事实」

#545 核心设计的结构化受控通道没有任何存储与写入载体：无 entry 表、无写命令、无 author 推导、无 admission。读取面、group scope、执法三个后续 child 全部以本 child 为地基被阻塞。

## 预期结果

性质表述：

1. **envelope 全链路 ADT**：scope 是封闭 union（`item | chain | group` 三 variant，穷尽 switch——新增 scope 不过编译）；author 是封闭 union（operator variant | agent variant 含 chain/item/run/phase），**仅由凭证解析路径构造**（构造器收紧，#406 `ItemMutationCaller` 同款）——不存在客户端自报 author 的可达路径，请求里的自报字段无效或被拒。
2. **一切写入经 daemon socket**：文件系统上不存在 entry 的可直写对应物；写命令在 `DaemonCommandName` / `buildDaemonCommandSpecs` 穷尽分类中有归属且 agent 可用（凭证限定所属 chain）；operator 无凭证写任意 chain。每次写入判定（接受与拒绝）emit 审计事件。
3. **append-only 性质**：不存在 agent 或 operator 可达的 entry 更新/删除命令路径；唯一删除通道是 `chain delete` 级联清除（entries 与 chain 同生共死，无独立 GC）。
4. **body 不透明**：写入→存储全程 body 逐字携带，无解析、无正则、无 marker 识别；body 内容（含状态字面量、`FINALIZER SUMMARY` 等控制记号）不影响任何调度或状态决策。
5. **无任意 hard cap、无截断**：context body 不设置引擎自造字节上限。若实现触及经文档和实测确认的 socket/SQLite/CLI 外部限制，admission 只可点名该真实限制并显式拒绝；不得截断或静默丢内容。证据类大内容走 evidence 引用。
6. **scope 键解析有效**（拆解期裁决，理由见 #545 树登记 comment）：落库 entry 的 scope 键解析到本 chain 内真实存在的寻址对象——item scope 键指向存在的 item，group scope 键指向树运行态中存在的 par 容器，chain scope 键即 chain 自身；不存在指向虚空的 entry（typo 不静默丢失，与 admission default-deny 哲学一致）。
7. **group scope 的 v2 语义**：v2 无树运行态 ⇒ 不存在任何可寻址的 par 容器 ⇒ group scope 写入在 admission 一律拒绝、错误信息点名原因。这是性质 6 在 v2 的自然推论（非 stub、非兜底）；正路径（真 par 容器下的键解析）归 group 真实化 child（Depends on #558）。

### 已裁决的 envelope 与寻址形态

- body 不设引擎任意字节上限且永不截断；真实外部协议限制若存在，必须以来源明确的 boundary error 暴露。
- v3 首版 envelope 不加入自由 `topic`/tag。`item | chain | group` scope 已是语义闭集；未来若出现不能由 scope + author + cursor 表达的真实查询场景，再按新增 ADT 字段流程立 issue，不预埋松散字符串。
- 写命令必须显式提交 scope variant；`item`/`group` 同时提交目标稳定 ID，`chain` 无额外 key。agent 可指定凭证所属 chain 内任一真实 item/group，符合“chain 内随意读写”；operator 可指定任一 chain 内真实对象。所有路径都做存在性校验，不做隐式“猜当前 group”或静默 fallback。

## 不应残留

- 本 child 范围内：任何绕过 socket 的 entry 写路径；envelope 以匿名形状或裸 JSON 透传（无 arktype 边界）；scope/author 的 stringly switch 无穷尽检查；agent 或 operator 可达的 entry 更新/删除路径；body 的任何解析、截断或语义提取代码；无真实外部依据的字节 hard cap；自由 topic/tag 字符串；scope key 隐式猜测或 fallback。
- 本 issue 范围之外不应改动：`shared.md` 机制零改动（#545 范围外首条——重定位是定位陈述，不是实施项）；读取命令面（归读取 child）；group 键推导（归 group 真实化 child）；`required | expected` 执法（归执法 child）；`[phases.rights]` 不扩展（裁决 3）。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。依据：#78 / #109、#453 契约 T3/T5。
- #396 边界（#545 约束节逐字）："引擎对 entry body 零解析、零语义提取；body 内容不得影响任何调度或状态决策（#396 内容通道 ≠ 流转信号）。"
- 不新增第三类主体：读写主体沿用 #406 的 `operator | agent(run)` 和类型（#545 约束节）。
- schema 迁移保既有数据：走 `migrateStateSchema` 既有事务模式，旧 chain 数据完好。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 触同一批 `src/daemon.ts`/`src/scheduler.ts` 面，默认它们先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 写入经 CLI 落库且 author 凭证推导（RFC 关闭验证行 1） | agent 凭证 env 下经写入命令写 entry，请求中夹带自报 author 字段 | local | entry 落库、author = 凭证所属 (chain,item,run,phase)；自报字段无效或被拒 |
| function | append-only（RFC 行 3） | 枚举 socket 命令面（`DaemonCommandName` union 审查）+ 对已有 entry 尝试更新/删除 | local | 不存在 agent 或 operator 可达的更新/删除命令；尝试报错 |
| function | chain 级联 GC（RFC 行 8） | 写入若干 entry 后 `coder-loop chain delete`，查 entries 表 | local | 该 chain entries 全部清除 |
| function | operator 无凭证写任意 chain（RFC 行 7 写半边） | 无凭证 env 经写入命令向任一 chain 写 entry | local | exit 0；entry author subject = operator |
| function | 大内容不截断 | 写入跨多个常规 CLI buffer 大小的 UTF-8 body 并读回；同时检查代码中 context 专属 hard cap | local | 逐字 round-trip；无截断、无 context 任意 hard cap；若命中有来源的外部协议限制则显式 boundary error 点名来源 |
| function | scope 键解析有效 | 经允许显式指定的路径（至少 operator）写入指向不存在 item 的 item-scope entry | local | admission 拒绝，错误点名寻址对象不存在 |
| function | group 无容器拒绝 | v2 形态 chain 下写 group scope entry | local | admission 拒绝，错误信息点名「不存在可寻址的 par 容器」类原因 |
| adversarial | body 不透明（RFC 行 4） | `bun test` 含用例：store 预置 body 为状态字面量与 `FINALIZER SUMMARY: decision=complete` 的 entries，跑 `schedulerTick`，断言调度决策、item status、trigger 判定与无 entries 基线完全一致 | local | 断言通过：调度、状态机、trigger 判定零受影响 |
| integration | shared.md 并存零回归（RFC 行 9） | `bun scripts/real-e2e.ts` | local | 绿（PR MERGED / issue CLOSED）；shared.md 创建与注入行为与现状一致 |
| environment | 审计可见 | 一次接受 + 一次拒绝写入后以 operator 查 events | local | 两次判定各有审计事件，含判定结果与原因 |
| type | ADT 完好 | `bun run typecheck && bun test`；审查 envelope/scope/author 类型定义 | local | 全绿；封闭 union + 穷尽检查，无匿名形状，author 无公开构造路径 |

## 依赖关系

- Depends on: 无（本树地基）。
- Blocks: #595（读取命令面）、#596（group scope 真实化）、#597（「必须调用」执法）、#598（收尾对齐）。





---

## 四、已替代草稿（CLOSED·NOT_PLANNED，仅摘要）

- #595 [CLOSED·NOT_PLANNED（已替代草稿）] feat(cli): context 共享读取命令面——scope 过滤查询与 GUI 消费 boundary — 落地 context entry 的读取命令面——经 daemon socket 的过滤查询、分页游标、以及作为 GUI 消费契约的 arktype 返回 boundary。
- #596 [CLOSED·NOT_PLANNED（已替代草稿）] feat(engine): context 共享 group scope 真实化——par 容器稳定 id 键解析 — group scope 从「一律拒绝」真实化为可用：par 容器内的 run 写 group entry 时，daemon 从 #558 的树运行态推导容器稳定 id 作为 scope 键；读取按 group 键过滤命中同组 entries。
- #597 [CLOSED·NOT_PLANNED（已替代草稿）] feat(engine): context 共享「必须调用」执法——run 收尾 required|expected 判定 — 消费 #553 的 `[[tools]]` / `toolRequirements` 声明位：把 context CLI 注册为 `provider = engine` capability union 的第一个真实成员（含用法文档内容），其 entries 存在性条件是 outcome（确定性输出条件）的首个 variant（entry-existence）；在 run 收尾点落地对 outcome 求值的 `required | expected` 两档执法。
- #598 [CLOSED·NOT_PLANNED（已替代草稿）] docs(v3): context 共享收尾对齐——无状态前提边界重述与文档同步 — context CLI 全部结构性 children 落地后，把 #545 边界重述与并存定位同步进仓内文档——CLAUDE.md 无状态前提、docs/ 的 shared.md/handoff 叙述、preset 作者手册。

---

## 五、关键评论摘录（≥200 字符的决策性回复）

#### #594 评论 by `RiriAgent` (2026-07-13)

<!-- coder-loop:executable-contract schema=1 source-issue=594 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/594
- Observed issue-body edit timestamp: `2026-07-11T01:08:42Z` (`lastEditedAt`; editor `RiriAgent`). The complete issue timeline and all comments were re-read on 2026-07-13; the issue had zero comments before this marker.
- Operator-comment URLs used: none. The live issue body is the intent authority; the parent decomposition record is https://github.com/mouriya-s-lab/coder-loop/issues/545#issuecomment-4866615198.
- Historical implementation evidence only: closed/unmerged PR https://github.com/mouriya-s-lab/coder-loop/pull/655 and its review comments https://github.com/mouriya-s-lab/coder-loop/pull/655#issuecomment-4949383353, https://github.com/mouriya-s-lab/coder-loop/pull/655#issuecomment-4949466125, and closure decision https://github.com/mouriya-s-lab/coder-loop/pull/655#issuecomment-4953444053. Per that closure decision, PR #655 is not a code-migration or cherry-pick source; implementation restarts from current `main`.

## Deliverable

`implementation-pr`

One new PR from current `main` must close exactly #594. It implements only the context-entry storage/write foundation: closed envelope ADTs, append-only SQLite persistence, daemon-socket write command, credential-derived author, admission/audit, scope-key validation, and explicit soft-delete GC. Reading, real group-container support, `required | expected` enforcement, `shared.md` changes, and GUI work remain outside this issue.

## Checks

All rows are `shell` because coder-loop is a CLI/daemon/backend project and this issue has no browser behavior. Commands run from the issue checkout unless a row says otherwise.

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| C01 | type | shell | `bun run typecheck`; cwd = repo root; normal local env | Exit 0. Context scope, author, request, stored entry, response, error/reason and audit payload flow through precise types; no forbidden type degradation. |
| C02 | focused | shell | `bun test src/context-entry.test.ts src/sqlite-state.test.ts src/daemon.test.ts src/central-cli.test.ts src/scheduler.test.ts`; cwd = repo root | Exit 0. All new context, migration, daemon/CLI, credential, scheduling-opacity and premature-socket-close regressions pass. |
| C03 | suite | shell | `bun test`; cwd = repo root | Exit 0 with zero failures. Existing tests are not removed, renamed, skipped or weakened to obtain green. |
| C04 | author/admission | shell | `bun test src/daemon.test.ts -t "context append derives author from credential"`; cwd = repo root | Exit 0. A live agent credential produces author `(chain,item,run,phase)` derived by the daemon; a client-supplied author key is boundary-rejected and cross-chain/unknown/inactive credentials are denied. |
| C05 | operator/audit | shell | `bun test src/daemon.test.ts -t "context write admission audit"`; cwd = repo root | Exit 0. Credential-free operator append succeeds with `author.kind=operator`; at least one allow and one deny each emit a context-write admission audit event with outcome and reason. |
| C06 | scope | shell | `bun test src/daemon.test.ts -t "context scope admission"`; cwd = repo root | Exit 0. Existing item scope is admitted; missing item is denied with `item-not-found` or an equally typed reason; v2 group scope is denied with `group-unavailable-v2` or an equally typed reason naming absence of an addressable par container; chain scope targets the selected chain. |
| C07 | append-only/GC | shell | `bun test src/sqlite-state.test.ts -t "context entries are append-only and removed by chain delete"`; cwd = repo root | Exit 0. No update/delete store or daemon command is reachable; append persists; the existing soft-delete `chain delete` path explicitly removes all entries for that chain while other chains survive. |
| C08 | migration | shell | `bun test src/sqlite-state.test.ts -t "context schema migration preserves existing data"`; cwd = repo root | Exit 0. A real pre-current schema fixture migrates transactionally, preserves existing chains/items/runs/current-runs, creates the new table/indexes, and re-open is idempotent. |
| C09 | opaque body | shell | `bun test src/scheduler.test.ts -t "context body is opaque to scheduling"`; cwd = repo root | Exit 0. Bodies containing status literals and `FINALIZER SUMMARY: decision=complete` leave item status, selected phase, trigger decisions and scheduler result identical to a no-entry baseline. |
| C10 | direct CLI runtime | shell | `bun test src/central-cli.test.ts -t "context append real daemon runtime"`; cwd = repo root | Exit 0. The test must spawn `bun src/loop.ts daemon up` on an isolated local loop-data root, wait for its Unix socket, invoke the real `bun src/loop.ts context append` operator and live-agent paths, round-trip a multi-megabyte UTF-8 body byte-for-byte through SQLite, observe typed negative paths, prove an orderly peer `end`/`close` after a response prefix rejects instead of hanging, then run daemon down and prove shutdown. No mock daemon or direct store substitution counts. |
| C11 | command surface | shell | `bun src/loop.ts context update`; cwd = repo root; no run credential | Non-zero exit with an invalid/unknown context subcommand error. Repeat with `delete`; neither command may exist in `DaemonCommandName`, CLI routing, daemon specs or store API. |
| C12 | repository E2E | shell | `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture`; cwd = repo root; configured `gh`/runner auth, isolated harness root | Exit 0; harness reports its seed PR `MERGED`, seed issue `CLOSED`, fixture check passed, daemon stopped, fixture removed and mutex released. This is the repository-mandated engine/daemon integration gate and supporting acceptance evidence; C10 is the direct context-write Layer-4 behavior proof. |

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| P01 | `changed` | Review added/modified TypeScript for explicit `any`, non-`const` `as` assertions, anonymous/unparsed boundary objects, unchecked maps, or `unknown` propagated past parsing/catch boundaries. Query the complete `origin/main...HEAD` diff and inspect every hit in context-related code. | `unknown` only at an external parse or catch boundary; `as const` only. No other exception. | Zero violating changed sites; boundary inputs are parsed with arktype into named precise types before internal flow. |
| P02 | `changed` | `ContextScope`, `ContextAuthor`, request protocol, persisted envelope and expected failures must be discriminated unions/products with exhaustive handling. Query their definitions and every `kind` switch/branch in the complete diff. | One canonical context-owned type module plus typed import consumers; no duplicate anonymous envelope shapes. | Exactly three scope variants (`chain`, `item`, `group`) and two author variants (`operator`, `agent`); adding a variant makes exhaustive handling fail typecheck. Client requests have no author construction path. |
| P03 | `whole-tree` | `rg -n '"context\.(update|delete)"|updateContextEntry|deleteContextEntry' src -g '!*.test.ts'` | None. Chain deletion may call a narrowly named chain-GC primitive that deletes all entries as lifecycle cleanup, not an entry mutation API. | No agent/operator context-entry update/delete command, handler or store method exists. The only deletion behavior is explicit chain lifecycle GC. |
| P04 | `changed` | Inspect every read of context `body` added by the diff and query changed non-test code for status/marker/summary parsing adjacent to context code. | Transport chunk assembly, exact persistence, serialization, and test-only equality/assertion reads. | Zero semantic parsing, regex/marker recognition, scheduling/status/trigger branching, truncation, arbitrary byte cap, topic/tag field, implicit scope-key guess or fallback. |
| P05 | `changed` | Inspect new daemon commands against `DaemonCommandName`, `buildDaemonCommandSpecs`, `runAuthorizationGate`, credential injection allow-list and observability boundary unions. | The context append protocol may use multiple typed begin/chunk/commit socket commands to preserve complete large-body transport. | Every new command is exhaustively classified, agent-attributed where required, audited on accept/reject, and unreachable by filesystem direct write. No dead caller field such as PR #655's unread `rowId` remains. |

## Canonical runtime

- Setup: `bun install --frozen-lockfile`; verify Bun, `gh`, configured runner CLI, and `/Users/mouriya/Ext/code/coder-loop-e2e-fixture` origin. Use a local isolated loop-data directory; do not touch production `~/.coder-loop`.
- Start: `bun src/loop.ts daemon up --loop-data-root <isolated-local-root> --json`.
- Readiness: wait until `<isolated-local-root>/daemon.sock` accepts `bun src/loop.ts daemon status --loop-data-root <isolated-local-root> --json`; file existence alone is not readiness.
- Behavior: drive the real `bun src/loop.ts context append <chain> --scope <typed variant> ...` CLI through the daemon socket for operator, live-agent credential, missing-item, v2-group, forged/inactive credential, large UTF-8 body, audit, append-only and chain-delete GC paths. The exact final flag spelling must come from the implemented typed CLI help; no direct SQLite write may substitute for append behavior.
- Canonical repository E2E driver: `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` as mandated by `CLAUDE.md` and `docs/real-e2e-fixture.md` for daemon/engine changes. It must observe a real fixture PR merge and issue closure.
- Logs: capture direct CLI stdout/stderr, daemon status, relevant audit events, exact byte comparison and GC counts under the issue evidence directory; the PR packet must cite the current tested SHA and commands.
- Stop ownership: the test/driver that starts each isolated daemon owns `bun src/loop.ts daemon down --loop-data-root <isolated-local-root> --json`, child-process settlement, isolated-root cleanup and E2E mutex release. No phase-owned process may remain.

## Test delta

`required`

New tests must cover the context ADTs/boundaries, schema migration and preservation, append-only/soft-delete GC, operator and credential-derived author, agent chain confinement, missing-item and v2-group rejection, accept/deny audits, exact multi-chunk UTF-8 transport, body opacity against `schedulerTick`, and the PR #655 review regression where an orderly socket `end`/`close` before all sequence responses must reject rather than leave the CLI pending. Existing assertions survive unchanged: no removal, rename, skip, timeout inflation, narrowing, mock substitution, or weakening merely to pass. The PR must report base/head test inventory from the same `bun test` command and explain every delta.

## Dependencies

- Current implementation base is `main@f01560d5d0b324e791db7f599e502f09fc78a652`; local source inspection confirms schema v13 and no context command/table/module on main (`src/sqlite-state.ts`, `src/daemon.ts`, `src/loop.ts`).
- #535, #536 and #538 are closed by merged PRs #616, #619 and #610, so the issue's audit-tree ordering prerequisite is satisfied on current main.
- #558 remains open, but it is not a blocker for #594: v2 has no addressable par container, so group writes must be explicitly denied. Positive group scope belongs to #596 after #558.
- #594 blocks open children #595, #596, #597 and #598. Do not absorb their read API, real group resolution, enforcement, docs or GUI scope.
- PR #655 is closed and unmerged at `df1850a60287fc265e8766fe957384c9e464adba`. Its diff and review are historical investigation only; its closure comment explicitly forbids treating it as a migration/cherry-pick source. A fresh implementation must independently avoid its premature-socket-close hang and dead `ItemMutationCaller.agent.rowId`.
- The repository has no `.github/workflows`; local typecheck, full suite, direct runtime and canonical real-E2E evidence are therefore the active gates. `mouriya-s-lab/coder-loop-e2e-fixture` is currently reachable as a private repo, its default branch is `main`, and the local fixture checkout origin matches.
- No external blocker is currently verified. If configured GitHub/runner auth or fixture reachability fails during C12, report that concrete infrastructure failure rather than weakening or omitting the gate.

## Supersedes

none


#### #594 评论 by `RiriAgent` (2026-07-13)

## Coder-loop closure review (run-1783937728307-85-review-item-7)

Review verified this issue is fully handled.

- Acceptance criteria: independently replayed, all rows matched.
- Child/subtask issues: this atomic issue has no own subissues.
- Final transition made by coder-loop review.

Reason:
PR #677 at head `22b68aae1ffcadfe3910fbf6b7c2221f2ed1c327` passed independent diff-audit and replay: all ten changed files mapped, P01–P05 converged with zero sites, C01–C12 all matched, the canonical suite passed 520/520, direct CLI/daemon/operator/live-agent claims matched, and C12 observed fixture issue #512 CLOSED / PR #513 MERGED. PR #677 was squash-merged as `d381d06c0a55385fb211283adcfb05ffade94f88`.



---

## 六、依赖与关联

Sub-issue graph（来自 GraphQL）：
- #594 [CLOSED] feat(engine): context 共享存储与写入面——envelope ADT、SQLite append-only 表与凭证推导 author
- #595 [CLOSED] feat(cli): context 共享读取命令面——scope 过滤查询与 GUI 消费 boundary
- #596 [CLOSED] feat(engine): context 共享 group scope 真实化——par 容器稳定 id 键解析
- #597 [CLOSED] feat(engine): context 共享「必须调用」执法——run 收尾 required|expected 判定
- #598 [CLOSED] docs(v3): context 共享收尾对齐——无状态前提边界重述与文档同步
- #730 [OPEN] feat(cli): context scope 过滤读取与 GUI boundary
- #731 [OPEN] feat(engine): real-par context group scope
- #732 [OPEN] feat(engine): ordinary run context required/expected 执法
- #733 [OPEN] feat(engine): trigger 与 validator context outcome 集成
- #734 [OPEN] docs(v3): context 冻结 SHA 综合验收
