# RFC #543 · R10 script join / reopen 需求侧报告

> 证据边界：只读 `01-clauses.md` 的 B2–B4、D3、J7、L，`23-expected-foundation.md`，以及 `06`、`15`、`20`、`27` 的既有摘要。本文只推导需求；不选择 schema、API、表、队列、锁、artifact 或模块签名，不读取源码、不做实验。RFC-1 拥有 join/reopen authority；#543 不复制该 authority，也不为文件、Git、数据库或第三方 effect 兜底。

## A. 摘要

`script` 是 join 判定主体的 additive variant，不是新的 join 状态机。容器成员全部 terminal 后，它在该 join point 的稳定 evaluation identity 下运行，接收公共 hook payload，经 script stdout typed ingress 提交统一三词 decision ADT；`advance`、`hold`、`reopen` 与未来 agent-phase validator 进入同一个 journal/consumer。脚本可先在 evaluation scope 内用 operator CLI 创建 correction items，但这些 mutation 不属于 reopen 消费事务。

`reopen` 只在容器推进/par join 与顶层 chain join 合法。#543 负责 decision 的解析、身份关联、同一挂点多判定合成、journal 与向 RFC-1 authority 的一次稳定交付；RFC-1 负责 target、correction claim、cursor、budget、生命周期以及 reopen effect 的权威校验和原子结果。相同 target 的多个 reopen 按声明稳定顺序合并、correction IDs 去重；不同 target 不任选，合成为 hold 并产生包含全部冲突 target 的 diagnostic。

需求集合共 **27 项**：修补后地基可承接 **4**，#543 本能力必须自建 **14**，外部 blocker **9**（RFC-1 **8**、RFC-2 **1**）。外部 blocker 只限制相应 completion claim，不授权 #543 建替代 authority。

## B. 语义

### B1. join variant 与统一判定

join declaration 的判定主体是穷尽 ADT：既有 variant 保持其语义，新增 `script` variant 只改变“由谁产生 decision”，不改变 join 的推进代数。到达 join 的权威条件、容器成员 terminal 判断与顶层 chain join 的宿主 identity 由 RFC-1 join authority 提供；#543 只在 authority 宣告可评估时执行 script。

script join 复用 hook subprocess 与 payload 合同，但它是 gate：producer 必须等待 typed decision 准入，不能采用 observer 的 fire-and-forget completion 语义。script 与 agent-phase validator 使用不同 ingress kind，却提交同一个 `advance | hold | reopen(target, correctionItemIds)` ADT，进入唯一 evaluation journal/consumer；不得为 join script 建第二套状态机。

### B2. payload 与 identity

payload 使用唯一 hook envelope：typed join point/host context、pinned public compile projection、当次 canonical runtime snapshot。它必须携带稳定 point、evaluation、execution identity；重问换 execution identity但不换未消费 epoch，restart 重放固定 pinned input。引擎不注入 mergedness、PR 状态或 merge commit；脚本自行查询外部真相，外部查询及副作用的幂等、锁与失败由脚本作者负责。

### B3. correction 与 reopen

corrections 必须先通过带 evaluation scope 的 operator CLI 创建，decision 仅引用精确既存 `correctionItemIds`。CLI mutation 的幂等 key、首次 response 与审计关联属于 #543 evaluation 地基；非确定重问可能创建不同 correction，#543 不自动撤销或判孤儿。

reopen decision 交付包含稳定 evaluation/decision identity、opaque target、精确 correction IDs。RFC-1 authority 穷尽判断 point×decision 合法性、target membership/已运行/同 seq、correction 可认领性、cursor 与 budget，并返回 typed outcome。成功效果中 correction claim、target reopen、cursor 回退、budget consumption 与 decision consumed 必须全有或全无；既有 terminal item 不改写，consumed closure 不复活。

### B4. 多 reopen 合成

同一 evaluation 中各命中 gate 仍按全局→chain→preset→item稳定顺序执行并分别留下 execution/decision 事实。合成是 pure、typed、穷尽的：

- 全为 `advance` 才 advance；
- 任一 `hold` 且无 reopen 时 hold；
- reopen 优先于 hold；
- 多个 reopen target 相同时，按稳定声明/结果顺序对 correction IDs 作首次出现保序并集；
- target 不同时，不调用 reopen authority，不按声明顺序选胜者；合成为 hold，并以稳定顺序列出全部冲突 target 的 diagnostic。

合成结果是该 evaluation 交给唯一 consumer 的权威 decision；单 hook decision 不是可各自消费的 reopen 命令。重复 ingress、restart 或 consumer retry 必须按相同 evaluation/decision identity 得到稳定吸收或同一 typed outcome。

### B5. 顶层 chain join

chain-complete 是顶层 join 实例，不保留专用二词协议。它与容器 join 共用 script variant、payload、三词 ADT、evaluation journal、合成与 RFC-1 reopen admission。差异仅在 RFC-1 提供的 host/target 合法域和 canonical fingerprint projection；#543 不以 chain metadata 或旧 keep-active carrier建立第二 authority。

## C. 原子需求

| ID | 原子需求 | 可证后果 | 分类 |
|---|---|---|---|
| SJ-01 | join 判定主体是含 `script` 的穷尽 typed variant | 新 variant 令所有 compile/runtime switch 显式处置，无 catch-all | RFC-2 blocker |
| SJ-02 | `script` 只替换 decision producer，不复制 join 状态机 | script 与其他 producer 的同词 decision 产生相同推进后果 | #543 自建 |
| SJ-03 | script 与 validator 使用 kind-specific typed ingress并提交同一 decision ADT | 非法 wire、非法 variant与stale execution穷尽拒绝；全系统一个 journal/consumer | #543 自建 |
| SJ-04 | script join 只在 RFC-1 authority 宣告 join 可评估时启动 | 未到全成员 terminal 的容器不能因 script 自行推进 | RFC-1 blocker |
| SJ-05 | join point具有 point×host stable identity，evaluation=`(point,epoch)` | restart/重问仍定位同一未消费判定 | #543 自建 |
| SJ-06 | 每次 script attempt有 execution identity，decision匹配当前 attempt | 迟到 stdout 不能覆盖新 attempt | #543 自建 |
| SJ-07 | payload来自唯一 hook envelope并含 join context、pinned compile projection、runtime snapshot | observer/gate/join无平行 payload；shape可导出 | 修补后地基 |
| SJ-08 | 同一 evaluation重放固定版本与 pinned payload | source漂移/restart不改变旧 evaluation输入 | 修补后地基 |
| SJ-09 | payload不注入 GitHub mergedness 等外部事实 | script自行查询；引擎不承担外部真相或effect | 修补后地基 |
| SJ-10 | `advance|hold|reopen` 对 join point穷尽，普通非容器点拒绝 reopen | 非法 point×decision 零推进并有 typed audit/diagnostic | #543 自建 |
| SJ-11 | hold consumed后按 per-point canonical fingerprint退避重问 | 无关状态不触发；相关 join状态或声明变化后可重问 | #543 自建 |
| SJ-12 | correction仅经带 evaluation scope 的 operator CLI预先创建 | stdout无 mutation；普通 operator路径不变 | #543 自建 |
| SJ-13 | evaluation-scoped correction mutation可重放吸收并返回首次 typed response | 同 scope+command+canonical args 至多一次引擎 mutation | 修补后地基 |
| SJ-14 | reopen decision只携带 opaque target与精确 correction IDs，并绑定evaluation/decision identity | 不用位置、显示名或当前路径猜 target/correction | #543 自建 |
| SJ-15 | corrections 的存在、membership、可认领性与竞争 claim由 authority穷尽判定 | 缺失、跨域、已认领、重复/竞争均有 typed outcome | RFC-1 blocker |
| SJ-16 | target 的已运行、同 seq、生命周期及 point 合法性由 authority判定 | 非法 target不改变容器、cursor、budget或item | RFC-1 blocker |
| SJ-17 | reopen cursor回退由 RFC-1 canonical seq authority执行 | #543 不解释或直接写 cursor | RFC-1 blocker |
| SJ-18 | reopen budget由 RFC-1 resolver/writer判定并消费 | 缺失/耗尽/竞争有 typed outcome；#543不解释 budgetRef | RFC-1 blocker |
| SJ-19 | 成功 reopen将 claim、target reopen、cursor、budget与decision consumed全有或全无 | 任一 kill point后可判定且无部分成功 | RFC-1 blocker |
| SJ-20 | reopen保持既有 terminal item，consumed closure不可复活 | correction追加不改写历史终态 | RFC-1 blocker |
| SJ-21 | 同 target多 reopen按稳定顺序合并并对correction IDs首次出现保序去重 | 声明重放得到同一合成 decision | #543 自建 |
| SJ-22 | 异 target多 reopen合成为hold并列全冲突target，不调用authority | 不存在隐式优先级或部分 reopen | #543 自建 |
| SJ-23 | reopen优先于hold；仅全advance才advance | 多层 gate AND 语义在join处不变 | #543 自建 |
| SJ-24 | 合成后的单一权威decision与pending intent原子建立 | restart不逐个重消费单 hook decision | #543 自建 |
| SJ-25 | authority重复/冲突outcome由同一delivery稳定记录，consumer retry不重跑脚本 | decided恢复直接消费，terminal不再消费 | #543 自建 |
| SJ-26 | chain-complete作为顶层join由RFC-1供给host/target合法域与canonical join facts | 顶层与容器join只在authority数据上有差异 | RFC-1 blocker |
| SJ-27 | 顶层chain join复用script ingress、ADT、journal、合成与consumer，不读旧专用carrier作authority | 无二词 keep-active 或 chain metadata 第二状态机 | #543 自建 |

## D. 分类与责任

### D1. 修补后地基可承接（4）

可直接依赖的是：唯一 typed/pinned payload envelope；同一 delivery/evaluation 的固定输入；外部事实不注入的边界；evaluation-scoped CLI mutation 的稳定身份、幂等响应与 operator admission。这些是 expected contracts，不表示 main 已实现。

### D2. #543 本能力必须自建（14）

#543 拥有 script subprocess adapter、typed stdout ingress、统一 decision ADT 接入、join point evaluation/execution identity、合法 decision point边界、hold重问、correction引用、multi-decision纯合成、decision+pending journal、恢复结果记录，以及顶层/容器 join 对同一 consumer 的复用。它不拥有 target、claim、cursor、budget或 join topology authority。

### D3. 外部 blocker（9）

- **RFC-2（1）**：编译产物必须供给 additive、穷尽的 typed `script` join variant及 pinned public projection；#543 不自造平行 preset/join shape。
- **RFC-1（8）**：join-ready authority；correction claim；target legality；cursor authority；budget authority；原子 reopen effect；terminal/lifecycle preservation；顶层 chain join 的 host/target/canonical facts。

这些 blocker 可由一个或多个物理接口共同解除；计数是原子需求数，不是要求上游建立八个 API。

## E. 接缝证明

1. **Variant/ingress：** 在冻结 RFC-2 供给上编译各 join variant，验证 switch穷尽；script输出三词、非法 JSON、非法 point decision及迟到 execution，观察同一 ingress/journal的 typed 结果。
2. **Payload/restart：** pin H1，改 source 为H2并 kill/restart未消费 evaluation；旧 evaluation仍获字节/语义等价H1，新实例获H2，missing/corrupt/version无当前路径fallback。
3. **Correction：** 同 evaluation重放同一 CLI add，返回首次 response且只产生一次 mutation；不同 canonical args可各自首次生效并保留审计关联。
4. **合成：** 覆盖全advance、advance+hold、hold+reopen、同target多reopen含重复IDs、异target多reopen及声明层排列；证明确定合成、冲突时零 authority call。
5. **RFC-1 admission：** 在冻结供给上覆盖合法、未运行、跨seq、missing/已认领 correction、竞争 claim、预算耗尽、consumed closure与terminal preservation。
6. **原子恢复：** 在 decision+pending 建立、authority effect各原子边界及 outcome记录前后 kill；证明无部分 reopen、decided不重跑script、terminal不重消费。
7. **顶层接缝：** 对等运行容器 join与chain-complete script；两者事件/decision/journal shape一致，仅host/合法target不同，且旧 keep-active carrier变化不影响新 authority。
8. **外部 effect：** script查询/写文件、Git或服务后崩溃可重复；只验证稳定 evaluation/execution identity与attempt诊断，不以外部最终状态宣称 exactly-once。

## F. 尾部

- 原子需求：**27**。
- 分类：修补后地基 **4**；#543 自建 **14**；外部 blocker **9**（RFC-1 **8**、RFC-2 **1**）。
- 已覆盖：script join variant、共享 decision ADT/typed ingress、payload、evaluation/execution identity、correction IDs、target/claim/cursor/budget/consumed、多 reopen 合成、重复/冲突/restart、顶层 chain join。
- 边界：#543 不实现 RFC-1 authority，不解释 target/budget，不用本地 journal冒充原子 reopen，不为外部 effect提供锁、事务、回滚或 exactly-once。
- 未选择 schema/API/表/队列/锁/artifact；未实现代码、未重拆 issue、未创建 worktree、未修改其他文件。
