# RFC #543 · R9 expected foundation 独立复核

## A. 摘要

复核输入严格限于 `23-expected-foundation.md`、`aggregation.md`、`20-external-contract-resolution.md`、`21-runtime-consistency-resolution.md`、`22-observer-process-resolution.md` 与 `WORKFLOW.md` R8 裁决账本；未读源码、未实验、未创建 worktree，也未修改源文件。

复核结论：**PASS**。

`23` 明确是“修补后预期地基”，没有冒充 current main：开头声明不声称实现或运行证明完成（`23:3`），尾部再次声明不是当前 main 已达到状态（`23:75`）。逐域矩阵为每项 expected guarantee 同时保留稳定条款、既有 main 问题、裁决/归属、最弱保证、外部 blocker、待运行证明与非保证（`23:17-30`）。

初审 F1–F5 已按最小范围闭合：

- observer 任一 outcome 不改变 scheduler decision 已成为保证（`23:23`；`aggregation:125`）；
- 只有 crash 后非终态 attempt 恢复，known terminal 不自动重派（`23:20`；`aggregation:125`）；
- 派生 `hook.*` 零自反已成为保证（`23:22`；`aggregation:125`）；
- delivery/execution identity 明确贯穿 payload/stdin、持久事实、diagnostic 与 audit（`23:20-22,30`；`aggregation:125`）；
- P1/P2/P4/P5 只剩结果合同，物理表示由实现决定且可能无需新增表示（`aggregation:118`）。

三组外部 blocker及其冻结供给 SHA 上的解除证据完整保留（`23:32-40`）；observer、gate/runtime、RFC-2、RFC-1 与 RFC 全量关闭五组运行资格要求完整保留且明确尚未执行（`23:42-50`）。外部 effect 不兜底、全面并发、无 lane/锁/事务/exactly-once 的责任边界与 R8 一致（`23:13,30,40,52-60`；`aggregation:117,125,131`）。

## B. 覆盖矩阵

| 来源最弱合同 | `23` / `aggregation` 落点 | 判定 |
|---|---|---|
| `20` C1.1–C1.4：公共 projection、pinned ref、typed failure、物理形态不预裁 | `23:21,27,36,46,57,59`；`aggregation:118,127-131` | 4/4 完整 |
| `20` C2.1–C2.4：六边自动消费、上游时点/snapshot/identity、delivery 分域、外部 effect 边界 | `23:28,30,37,40,47,57`；`aggregation:117,129,131` | 4/4 完整 |
| `20` C3.1–C3.4：decision ADT、evaluation/IDs、RFC-1 admission/effect、物理形态不预裁 | `23:24,29,38,47,57,59`；`aggregation:126,130-131` | 4/4 完整 |
| `21` C1：typed current-state mutation | `23:9,25,45`；`aggregation:126` | 完整 |
| `21` C2：`shutdown-held` query/reject/no-dispatch/drain/无副作用 | `23:9,26,45,58`；`aggregation:126` | 完整 |
| `21` C3：durable evaluation/delivery authority 与 restart recovery | `23:9,24,45`；`aggregation:126` | 完整 |
| `21` C4：at-least-once、stable identity、外部重复归脚本 | `23:7,20,30,44,54-56`；`aggregation:117,125` | 完整 |
| `21` C5：terminal/consumed 只证明引擎 owned outcome | `23:9,24,54-56` | 完整 |
| `21` C6：legacy authority 隔离，不要求迁移/删除 | `23:45,60` | 完整 |
| `22` C1：每 match 独立 durable delivery，无 coalesce/skip/order | `23:7,30,44,54`；`aggregation:117,125,131` | 完整 |
| `22` C2：delivery/execution identity 分层并贯穿 stdin、持久事实、diagnostic、audit | `23:20-22,30`；`aggregation:125` | 完整 |
| `22` C3：同 delivery 固定 pinned payload | `23:7,21,44`；`aggregation:117,125` | 完整 |
| `22` C4：producer 等 admission/spawn/stdin、不等 completion；outcome 不改变 scheduler | `23:23,44`；`aggregation:125` | 完整 |
| `22` C5：clean stop 有界；crash 先回收再重派；关闭无主窗口 | `23:19-20,44`；`aggregation:125` | 完整 |
| `22` C6：at-least-once | `23:7,20,30,44,54-56`；`aggregation:117,125,131` | 完整 |
| `22` C7：known terminal 收敛且不触发通用失败 retry | `23:19-20,44,54`；`aggregation:125` | 完整 |
| `22` C8：execution terminal 权威、diagnostic 可恢复重复派生 | `23:7,22,44`；`aggregation:125` | 完整 |
| `22` C9：`hook.*` diagnostic 零自反 | `23:22,44`；`aggregation:125` | 完整 |
| `22` C10：全面并发、脚本承担外部协调幂等 | `23:13,30,44,55-56`；`aggregation:117,131` | 完整 |

逐条核算：

- `20`：12/12 完整。
- `21`：6/6 完整。
- `22`：10/10 完整。
- 合计：28/28 完整，漏项 0。

## C. 冲突 / 遗漏复核

### C1. Expected 与 current main

无冲突。`23:3,75` 明确限定 expected；矩阵的 main 列只引用 R4/R7 已有问题事实，没有把预期能力改写成已落地事实。

### C2. 旧预裁与伪产品裁决

无残留。`aggregation:118-119` 已将 P1/P2/P4/P5、schema、API、表、锁、队列、outbox、consumer、grace、batch 等归为结果合同下的实现参数或证明计划；没有要求新增某种表示。P3 仅保留已裁并发结果合同（`aggregation:117`）。

### C3. 外部 effect 边界

无冲突。引擎不为文件、Git、数据库、第三方服务、跨脚本 effect 提供事务、回滚、锁、幂等代理或 exactly-once（`23:13,30,40,54-56`）。目标资源自身能力归脚本作者依赖，不是 #543 blocker（`23:30,40`）。

### C4. 外部 blocker

3/3 完整：

1. RFC-2 pinned definition artifact/resolver（`23:36`）。
2. RFC-1 closure canonical transition/identity（`23:37`）。
3. RFC-1 structured reopen authority（`23:38`）。

三者只阻塞依赖它们的 completion claim，不授权 #543 建替代 authority（`23:40`）。

### C5. 运行证明

5/5 完整保留：

1. observer/process；
2. gate/runtime；
3. RFC-2 接缝；
4. RFC-1 接缝；
5. RFC 全量关闭。

`23:50` 明确这些尚不是已经执行的测试。不存在以局部 proof 外推 RFC 完成。

### C6. aggregation 历史冲突账本

`aggregation:133-144` 仍是明确标注的历史“冲突与存疑登记”，没有进入 expected guarantee，也没有推翻 `23` 或 R8 裁决。未发现正文互相矛盾或需求膨胀。

## D. Gate verdict

**PASS**

计数：

- 最弱合同：28；完整 28；部分 0；遗漏 0。
- Findings：0。
- 明确文本冲突：0。
- 外部 blocker：3/3 保留。
- 运行证明组：5/5 保留。
- 需求膨胀：0。
- current/expected 混淆：0。
- 剩余操作员产品裁决：0。

R9 expected-foundation gate 已满足。此 verdict 只证明回写合同完整、一致且未预裁机制，不证明实现或运行资格已经取得。

## E. 尾部

- 报告文件：`24-expected-foundation-review.md`
- Gate：**PASS**
- 未修改 `20/21/22/23`、`aggregation.md` 或 `WORKFLOW.md`。
- 未读源码、未实验、未建 worktree、未实现代码、未拆 issue。

<!-- END: 24-expected-foundation-review.md -->
