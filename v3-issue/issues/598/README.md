# #598 docs(v3): context 共享收尾对齐——无状态前提边界重述与文档同步

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T14:04:39Z  | updated: 2026-07-17T20:41:50Z
- closed: 2026-07-17T20:41:50Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/598
- comments: 1  | timeline events: 16

---

## Body

## 必须先读的关联 issue

#545（RFC: v3 context 共享 CLI——无状态 agent 的受控上下文传递）。继承条款逐字快照（边界重述全文）：

> "每个 agent 运行**仍是无状态的**；持久业务语义**仍只依赖 GitHub**。context entries 是引擎自有的、chain 生命周期内的**受控中间态**：影响下游 agent 判断质量，不承载持久业务语义、不承载流转信号；chain 删除即消失，agent 不得把它当持久事实源。" — #545「边界重述」

> "#411「A 域引擎不收编」修订为：A 域内容引擎仍不解析、不类型化其**语义**（body 不透明），但其中「跨 run 传递」这一子类的**传输与存储**由引擎提供服务（envelope 结构化、经 socket、可审计）。trace / evidence / `shared.md` 维持原状不收编。" — #545「边界重述」

> "B 域边界不变：引擎事件流不进 agent 视野，`logs.query` 对 agent 仍硬拒绝；context 读是独立的 A 域命令面，不经运维观测面。" — #545「边界重述」

`shared.md` 重定位（#545 裁决 1）：

> "并存，他们的场景不同，shared.md 我自己的定位是额外的 chains 级别的 prompt 注入，注入什么运行时说了算没有任何行为定义" — #545 设计裁决 1（操作员原文）

## 目标

context CLI 全部结构性 children 落地后，把 #545 边界重述与并存定位同步进仓内文档——CLAUDE.md 无状态前提、docs/ 的 shared.md/handoff 叙述、preset 作者手册。

## 使用场景

收尾对齐 child：headless agent 与 preset 作者读仓内文档时，看到的是 context CLI 落地后的实态——无状态前提带受控例外的新边界、shared.md 与 context CLI 的并存分工——而不是「本地文件必须做完即丢」的旧全称断言与新机制并存打架。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@a007fa4（行号实施前自行 grep 核对）。

- CLAUDE.md 前提原文（`CLAUDE.md:100-102`，小节 `### 每个 agent 运行都是无状态的`）：
  > "每次 `claude -p` spawn 的 agent 是独立进程，没有跨轮次记忆。本地文件会丢失、损坏、跨机器不可用。如果要用本地状态，必须每次做完即丢弃。持久业务语义只能依赖 GitHub（issues / labels / comments）。"
- docs/ 的 shared.md/handoff 叙述现场（已核，2026-07-02）：`docs/preset-authoring.md:18,86,343`、`docs/operations.md:188,191`、`docs/gh-issue-pr-iteration-fragments.md:33,193`、`docs/operator-quickstart.md`（handoff 命中）。
- 「两域 / A 域 / B 域」词汇在 docs/ 零命中（已核）——#411 模型未以此名入档，docs 以 `sharedContextPath`/handoff 散文描述同一机制。本 child 在既有叙述位置补边界，不发明新文档体系。
- 文档计数守护先例（CLAUDE.md「当前实现 vs 分层契约的差距」节）：engine fact 清单以测试守护文档计数不漂移——前序 children 若新增 binding/doc builder，按该流程同步。

## 问题

C1–C4 落地后，CLAUDE.md 前提的「如果要用本地状态，必须每次做完即丢弃。持久业务语义只能依赖 GitHub」不再是全量事实——引擎多了 chain 生命周期内的受控中间态；docs 各处「shared.md 是 agent 间传递面」的叙述缺并存分工。文档 drift 是一等偏离（#568 同款收尾先例）：不对齐则每个后续 headless agent 都读到与运行时矛盾的前提。

## 预期结果

性质表述：

1. CLAUDE.md 前提节以 #545 边界重述为准更新：受控中间态例外（chain 生命周期内、不承载持久业务语义与流转信号、删链即消失、不得当持久事实源）写入前提本文——**替换改写，不留新旧并存叠层**（旧断言 + 「但现在……」式补丁是禁止形态）。
2. docs/ 每处 shared.md/handoff 叙述现场与 context CLI 的并存分工一句到位：shared.md = chain 级自由 prompt 注入面（运行时定内容、零行为定义），context CLI = 结构化受控传递通道——引用 #545 裁决 1 语义，不复制机制细节。
3. preset 作者手册（docs/preset-authoring.md）含 context CLI 命令面与 toolRequirements 执法语义的作者视角说明；前序 children 新增的 binding/doc builder（若有）已按既有计数守护流程入册。
4. 全部修订读起来像第一次就这么写（no-legacy）：无删除线、无「更新：」叠层、无被否定旧段残留。

## 不应残留

- 本 child 范围内：CLAUDE.md 或 docs/ 中与 context CLI 实态矛盾的全称断言；shared.md 叙述位置缺并存分工的遗漏点（上下文节清单是完整现场，逐点核对）。
- 本 issue 范围之外不应改动：代码与任何运行时行为（本 child 纯文档）；`gh-issue-pr-iteration` 的 handoff 纪律本身（是否迁移 context CLI 归 RFC 落地后另立 issue——#545 开放问题 4，known-open）；#411 issue 原文（GitHub 不可变记录）。

## 约束

- 正文中文、固定 token 英文（repo 文档语言约定）。
- 文档修订遵守 no-legacy：改结论用新内容替换旧内容，版本历史归 git。
- gate：本 child 在全部结构性 children（存储写入面、读取面、group 真实化、执法）合并后执行——过早对齐会把未落地行为写成事实。

## 本 issue 的验证边界

- **验证层级**：文档/残留守护；运行文档中列出的静态一致性检查与相关测试守护。
- **本 issue 必须证明**：文档只描述已经落地且有 owner 的行为，旧术语/旧路径按正文清单退场，命令与 schema 引用可由当前代码验证。
- **不在本 issue 内执行**：不运行 v3 整链路 integration，也不运行 bundled preset compatibility real E2E。若审计发现产品行为缺口，回到对应 implementation issue；合流证明分别归 #684/#685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | CLAUDE.md 前提对齐 | 读 `CLAUDE.md` 无状态前提节 | local | 含受控中间态例外与其四个边界（chain 生命周期内 / 不承载持久业务语义 / 不承载流转信号 / 不得当持久事实源）；无新旧叠层 |
| function | shared.md 现场逐点对齐 | 对上下文节清单的每个命中文件逐点核读 | local | 每处有并存分工表述或确认无需改（逐点结论留 PR body）；无残留「唯一传递通道」类断言 |
| function | 作者手册覆盖 | 读 `docs/preset-authoring.md` context 相关节 | local | 命令面与 required\|expected 执法语义有作者视角说明 |
| environment | 计数守护绿 | `bun test` | local | 全绿（含 binding/doc 计数守护，若前序 children 有增改） |
| assumption | 实态一致 | 对照实现后的命令面（`coder-loop --help` 及新命令 help）核对文档所述 | local | 文档命令名/语义与实态一致，无凭记忆写入的漂移 |

## 依赖关系

- Depends on: #594（存储与写入面）、#595（读取命令面）、#596（group scope 真实化）、#597（「必须调用」执法）——本树全部结构性 children。
- Blocks: 无。


---

## Comments (1)

### comment #5007303526 by `RiriAgent` — 2026-07-17T20:41:49Z

重新拆分后由 #734 承接冻结 SHA 综合验收。旧 issue 无关联 PR，关闭。


---

## Timeline (16)

- 2026-07-02T14:04:40Z `assigned` @RiriAgent
- 2026-07-02T14:04:49Z `cross-referenced` @RiriAgentsrc=594
- 2026-07-02T14:04:59Z `cross-referenced` @RiriAgentsrc=595
- 2026-07-02T14:05:01Z `cross-referenced` @RiriAgentsrc=596
- 2026-07-02T14:05:03Z `cross-referenced` @RiriAgentsrc=597
- 2026-07-02T14:05:23Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:05:39Z `cross-referenced` @RiriAgentsrc=545
- 2026-07-12T00:51:43Z `cross-referenced` @RiriAgentsrc=655
- 2026-07-13T06:08:51Z `cross-referenced` @RiriAgentsrc=677
- 2026-07-17T20:37:02Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-17T20:37:04Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:37:06Z `cross-referenced` @RiriAgentsrc=732
- 2026-07-17T20:37:08Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-17T20:37:11Z `cross-referenced` @RiriAgentsrc=734
- 2026-07-17T20:41:49Z `commented` @RiriAgent
- 2026-07-17T20:41:50Z `closed` @RiriAgentcommit=None