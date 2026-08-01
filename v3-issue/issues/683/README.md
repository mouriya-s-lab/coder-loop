# #683 RFC: v3 整链路验收分层

- state: **open**  | author: `RiriAgent`  | created: 2026-07-15T10:52:18Z  | updated: 2026-07-15T12:58:49Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/683
- comments: 0  | timeline events: 7
- sub-issues:
  - #684 [OPEN] test(v3): 冻结合流 SHA 的整链路 integration 验收 (mouriya-s-lab/coder-loop)
  - #685 [OPEN] test(v3): bundled preset compatibility real E2E 验收 (mouriya-s-lab/coder-loop)

---

## Body

## 目标

为 v3 建立独立的整链路验收层，把 implementation issue 的局部验证、v3 全链路 integration、现有 bundled preset compatibility real E2E 分开承载。本 issue 自身是 umbrella，不直接产出 PR。

## 上下文

- **Repo**: `mouriya-s-lab/coder-loop`（path: `/Users/mouriya/Ext/code/coder-loop`）
- **Design source**: `v3/execution-orchestration.md`

> “Gate 由新的无状态验证 agent 执行，不由任一实现 agent自证。” — `mouriya-s-lab/coder-loop#546` 关联编排契约

> “引擎全链路验收 | `bun run typecheck && bun test && bun scripts/real-e2e.ts`” — `mouriya-s-lab/coder-loop#547` body

现有 v3 children 普遍把上述两类验证折叠到同一 acceptance row，导致单 issue 反复运行只能证明旧 GitHub preset 未回归的 real E2E，却没有独立 owner 在合流 SHA 上证明 v3 新语义已经连接。

## 问题

implementation issue 应只负责直接触发并观察本 issue 新增的行为。跨 issue 接缝和旧 preset 兼容性需要不同的 fixture、环境与失败归属；继续散落在各 implementation issue 中，会让局部 PR 自证整套系统，并把 compatibility 绿误报为 v3 功能完成。

## 预期结果

- 一个专用 child 在冻结合流 SHA 上运行 v3 专用整链路 integration，证明已经合流的生产者/消费者接口真正连通。
- 一个专用 child 在发布候选 SHA 上运行现有 bundled preset compatibility real E2E，证明真实 runner 与 GitHub 终态不回归。
- implementation issues 只保留自己的验证深度和最小专用场景，不再继承未归属的整链路 E2E。

## 约束

- integration 与 compatibility E2E 是两个独立问题，必须由两个 child 承担。
- compatibility real E2E 不能替代 v3 专用 integration。
- Gate 失败必须回到拥有断裂契约的 implementation issue；不得在验收 issue 中临时写产品修复。
- 所有证据来自同一冻结 SHA，并记录命令、fixture、观察值与失败归属。

## 子 issue

- #684：v3 整链路 integration 验收。
- #685：bundled preset compatibility real E2E 验收。

## 关闭条件

两个 child 均在同一发布候选系列的冻结 SHA 上完成，证据分别证明 v3 新语义连接与现有生产 preset 兼容；六个 v3 RFC umbrella 的关闭复核引用对应证据。

## 本 issue 的验证边界

- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## 依赖关系

- Depends on: #543、#544、#545、#546、#547、#548 的 implementation children 按各 checkpoint 合流。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-15T10:52:19Z `assigned` @RiriAgent
- 2026-07-15T10:53:40Z `cross-referenced` @RiriAgentsrc=684
- 2026-07-15T10:53:43Z `cross-referenced` @RiriAgentsrc=685
- 2026-07-15T10:53:53Z `sub_issue_added` @RiriAgent
- 2026-07-15T10:53:53Z `sub_issue_added` @RiriAgent
- 2026-07-16T23:17:59Z `referenced` @RiriAgentcommit=1e3e49d7dc91f05e54a2a0f23b9f756741cf6050
- 2026-07-16T23:23:41Z `referenced` @RiriAgentcommit=8dc9a9a407481f33a0a0fb55386b451335eb8533