# #734 docs(v3): context 冻结 SHA 综合验收

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:10Z  | updated: 2026-07-27T01:00:43Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/734
- comments: 0  | timeline events: 7

---

## Body

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

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:37:11Z `assigned` @RiriAgent
- 2026-07-17T20:38:52Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-17T20:38:54Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:38:55Z `cross-referenced` @RiriAgentsrc=732
- 2026-07-17T20:38:56Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-17T20:40:08Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:50Z `cross-referenced` @RiriAgentsrc=598