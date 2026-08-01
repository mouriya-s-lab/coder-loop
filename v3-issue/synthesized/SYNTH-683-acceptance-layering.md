# SYNTH-#683 v3 整链路验收分层

> 本文档是**本地合成**，未写回 GitHub。依据 RFC #683 与其全部 sub-issue 合并而成。
> 来源：`v3-issue/issues/<N>/`（issue.json + comments.json + timeline.json + subissues.json）+ `v3-issue/design/`。

## 范围与组成

- **源 RFC**：#683 — RFC: v3 整链路验收分层
- **子 issue 总数**：2（OPEN 2 / CLOSED·COMPLETED 0 / CLOSED·NOT_PLANNED 0）
- **本合成 issue 编号**：`SYNTH-#683`（仅本地标识）

---

## 一、RFC 设计骨架（#683 原文）

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

## 二、当前实现 children（OPEN，当前 spec）

### #684 test(v3): 冻结合流 SHA 的整链路 integration 验收

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-15
- 关联: referenced `1e3e49d7dc91`, referenced `8dc9a9a40748`, referenced `05ee53cc4202`

## 必须先读的关联 issue

- **umbrella #683**：继承“implementation 局部验证、v3 整链路 integration、compatibility real E2E 分离”的验收契约。
- **#543–#548**：读取进入本 checkpoint 的各 RFC 完成态与 child 验证边界。

## 目标

在冻结的合流 SHA 上运行一个非 bundled 的 v3 专用场景，证明已经合流的 compile、运行态、scheduler、gate、context、ingress、status/events 与 GUI 生产者/消费者真正连接。

## 使用场景

各 implementation PR 分别通过后，由未参与实现的验证者只拿冻结 SHA、公开 issue contract 和 fixture 执行本 issue。它不重新实现功能，只发现跨 issue 接缝断裂并把失败归属回具体 implementation issue。

## 上下文

- **Repo**: `mouriya-s-lab/coder-loop`（path: `/Users/mouriya/Ext/code/coder-loop`）
- **Design source**: `v3/execution-orchestration.md` 的 G1–G5

> “所有 required task 落到同一个默认分支 SHA 后，才运行该组 Gate。” — `v3/execution-orchestration.md`

## 完成态片段

- 非 GitHub、非 bundled v3 preset 能从 compile 产物进入真实 daemon 调度。
- 两层 `seq/par` 存在真实重叠执行，join 可 hold/reopen/correction 后 advance。
- daemon 重启后恢复 pinned definition、tree cursor、evaluation epoch、context 与事件因果链，不重复副作用。
- ingress、status/events 和 GUI 消费相同稳定 identity，不读取私有表猜字段。
- 失败报告能点名断裂的生产者、消费者、输入 SHA 与应回修的 implementation issue。

## 不应残留

- 不使用 `real-e2e-minimal` 或 `gh-issue-pr-iteration` 的 GitHub PR closure 代替 v3 场景。
- 不把分别运行的 mock demo 拼成“整链路通过”。
- 不在验收分支临时修产品代码。

## 本 issue 的验证边界

- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | integration | 冻结 SHA 上运行 v3 整链路场景 | `bun scripts/v3-integration.ts --checkpoint all` | clean local checkout + isolated loop-data | exit 0；输出输入 SHA、preset/fixture、各跨边界 identity 与事件序列 |
| 2 | integration | 并发、hold/reopen/correction 与顶层完成 | `bun scripts/v3-integration.ts --checkpoint task-tree,gates` | real daemon + deterministic runners | 存在重叠时间窗；第一次判定不推进，correction 完成后才推进；无重复 spawn |
| 3 | integration | 重启恢复与下游消费 | `bun scripts/v3-integration.ts --checkpoint recovery,consumers` | real daemon restart + gateway/browser | 重启前后 definition/tree/context identity 一致；status/events/GUI 可重建同一因果链 |
| 4 | function | 仓库日常 gate | `bun run typecheck && bun test && bun scripts/engine-integration.ts` | local | 全部 exit 0；不得把该行单独当作本 issue 通过 |

## 依赖关系

- Depends on: #543–#548 中进入目标 checkpoint 的 implementation children 已合流到同一 SHA。
- Blocks: #683 关闭；v3 RFC umbrella 最终关闭复核；bundled preset compatibility E2E 的发布候选判定。


### #685 test(v3): bundled preset compatibility real E2E 验收

- state: **OPEN** | author: `RiriAgent` | created: 2026-07-15
- 关联: referenced `1e3e49d7dc91`, referenced `8dc9a9a40748`

## 必须先读的关联 issue

- **umbrella #683**：继承“v3 整链路 integration 与现有 bundled preset compatibility real E2E 分离”的验收契约。
- **#604**：bundled preset v3 化完成态。

## 目标

在发布候选 SHA 上运行现有 bundled preset 的真实 runner + GitHub 终态路径，只回答一个问题：v3 引擎与 preset 迁移后，现有生产 GitHub 工作流是否仍兼容。

## 使用场景

本 issue 在相关机制和 bundled preset 修改合流后运行一次，不进入每个 implementation issue 的中间 commit/retry。失败时按日志把回归归属到具体 implementation issue，不在本 issue 临时修复。

## 上下文

- **Repo**: `mouriya-s-lab/coder-loop`（path: `/Users/mouriya/Ext/code/coder-loop`）
- **Fixture repo**: `mouriya-s-lab/coder-loop-e2e-fixture`
- **Design source**: #683、#604、`docs/real-e2e-fixture.md`

> “验收主线是 real-e2e 全保真：`bun scripts/real-e2e.ts --preset gh-issue-pr-iteration` 绿跑（PR MERGED / issue CLOSED）” — `mouriya-s-lab/coder-loop#604` body

## 完成态片段

- `real-e2e-minimal` 在发布候选 SHA 上完成真实 issue → PR → merge → issue close。
- `gh-issue-pr-iteration` 在最终收尾时完成全保真路径，包括迁移后的 trigger、retry、closure 与闭包分支契约。
- 证据明确写成 compatibility 结论，不把它表述成 task tree、gate、context 或 GUI 的 v3 功能证明。

## 不应残留

- 不由 implementation issue 的每轮迭代重复承担。
- 不以 engine-integration 或 mock runner 代替真实 runner/GitHub。
- 不用本 issue 的绿覆盖 #684 的 v3 整链路 integration 失败。

## 本 issue 的验证边界

- **现有 GitHub real E2E**：本 issue 必须运行 `bun scripts/real-e2e.ts --preset real-e2e-minimal` 与 `bun scripts/real-e2e.ts --preset gh-issue-pr-iteration`。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | integration | 最小 compatibility real E2E | `bun scripts/real-e2e.ts --preset real-e2e-minimal` | clean release-candidate checkout + fixture repo | exit 0；真实 PR MERGED、seed issue CLOSED、default branch 含 fixture 改动 |
| 2 | integration | bundled preset 全保真 compatibility | `bun scripts/real-e2e.ts --preset gh-issue-pr-iteration` | clean release-candidate checkout + fixture repo | exit 0；真实 PR MERGED、issue CLOSED；trigger/retry/closure 与闭包分支契约成立 |
| 3 | integration | 证据归属 | 保存两次 run 的输入 SHA、runId、PR/issue URL、终态与清理结果 | GitHub + local loop-data | 所有证据来自同一发布候选 SHA；结论只声称 bundled preset compatibility |

## 依赖关系

- Depends on: #604；#684 在同一发布候选系列上通过。
- Blocks: #683 与六个 v3 RFC umbrella 的最终关闭复核；发版或同步到 app。



---

## 三、已落地 children（CLOSED·COMPLETED，含关闭证据）

_(无 COMPLETED child)_

---

## 四、已替代草稿（CLOSED·NOT_PLANNED，仅摘要）

_(无 NOT_PLANNED child)_

---

## 五、关键评论摘录（≥200 字符的决策性回复）

_(无长评论)_

---

## 六、依赖与关联

Sub-issue graph（来自 GraphQL）：
- #684 [OPEN] test(v3): 冻结合流 SHA 的整链路 integration 验收
- #685 [OPEN] test(v3): bundled preset compatibility real E2E 验收
