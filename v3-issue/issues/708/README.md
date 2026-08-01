# #708 docs(v3): 旧概念退役与任务模型收尾

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:37Z  | updated: 2026-07-27T01:00:11Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/708
- comments: 1  | timeline events: 17

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

在所有机制 child 落地后逐行登记旧概念退场和机制/参数分离，不承载实现补洞。

v3 任务模型全部结构性 children 落地后的收尾对齐：仓内文档与实态一致、旧概念退场完成登记、机制/参数分离（行 10）做全局验证。

## 预期结果

- 全部仓内文档对调度模型的描述与树模型实态一致：无 slot、无 phase 数组推进、无 stdout 判定、无 per-slot worktree 的现行时态描述（历史文档标注定位除外）。
- #546 行 10 全局验证通过并留证：引擎源码无 join 策略业务绑定（哪个容器用哪个 join 的字面量）、无 preset 业务状态字面量、无 reopen 预算业务值——机制 ADT 定义（variant tag 本身）属引擎，实例绑定与数值归声明。
- 旧概念退场登记：映射表逐行核对为「已落地」，结果以 comment 登记在 #546（RFC 关闭复核的输入）。
- 新增可计数契约面有测试守护（计数从代码派生，不手写）。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 旧概念现行时态清零 | `grep -rn "schedulerSlotKey\|slot 内串行\|数组顺序推进\|FINALIZER SUMMARY" CLAUDE.md docs/ templates/ presets/ --include="*.md"` | local | 零命中（或仅存于明确标注的历史快照文档） |
| function | 行 10：状态字面量 | `grep -rnE '"(queued|changes_requested|blocked|moot|done)"' src/*.ts` | local | 引擎源码零业务状态字面量命中（测试 fixture 除外） |
| function | 行 10：join 实例绑定与预算值 | 按各 child 落定的元数据键名 grep 引擎源码中的实例绑定/数值默认 | local | join 策略实例绑定与 reopen 预算值全部来自声明；引擎仅含 ADT 机制定义 |
| function | 映射表登记 | 查 #546 comments | GitHub | 存在逐行核对 comment：映射表 8 行各标「已落地（child 编号）」 |
| assumption | 计数守护 | `bun test`（既有守护测试套件内新增项） | local | 新契约面清单/计数由代码派生的测试守护，手写计数不存在 |
| type | 全仓一致 | `bun run typecheck && bun test` | local | 通过 |

## 依赖关系

- Depends on: #698、#699、#700、#701、#702、#703、#704、#705、#706、#707。
- Blocks: #709。


---

## Comments (1)

### comment #5055604426 by `RiriAgent` — 2026-07-23T07:23:43Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#708 承接 #568 v3 收尾文档 + 机制/参数分离守护）相对 baseline 的进度

- **已落地**: 无（本 issue 承载"全部结构性 children 落地后的收尾对齐"，前置全部未做完）。
- **半成品**: 无。
- **未开始**（全部）:
  - 仓内文档对调度模型的描述与树模型实态一致（`schedulerSlotKey` / `slot 内串行` / `数组顺序推进` / `FINALIZER SUMMARY` 现行时态清零）
  - #546 行 10 机制/参数分离全局验证：状态字面量、join 实例绑定、reopen 预算值全部来自声明，引擎源码零业务字面量
  - 旧概念退场登记：映射表 8 行核对为「已落地（child 编号）」并 comment 到 #546
  - 新增可计数契约面测试守护（计数从代码派生，不手写）

### 依赖

本 issue depends on **#698~#707 全部落地**。

### iteration agent

前置未落地时不动手；等 #698~#707 全部 close 后再启动。PR base = `coder-loop/v3-546-baseline`。



---

## Timeline (17)

- 2026-07-17T20:13:38Z `assigned` @RiriAgent
- 2026-07-17T20:14:10Z `cross-referenced` @RiriAgentsrc=707
- 2026-07-17T20:14:12Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-17T20:14:34Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:15:08Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-23T07:23:43Z `commented` @RiriAgent
- 2026-07-26T16:14:14Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-26T16:14:37Z `cross-referenced` @RiriAgentsrc=734
- 2026-07-27T04:26:49Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-27T04:26:50Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-27T04:26:52Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-27T04:26:53Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-27T04:26:54Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-27T04:26:55Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-27T04:26:56Z `cross-referenced` @RiriAgentsrc=704
- 2026-07-27T04:26:57Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-27T04:26:58Z `cross-referenced` @RiriAgentsrc=706