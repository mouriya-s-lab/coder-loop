# RFC #546：序并任务模型

本目录有五份正式文档，另附两份本地输入/对照稿：

| 文件 | 唯一职责 |
|---|---|
| [RFC.md](RFC.md) | 三域模型设计草稿（task 对象 / 闭包函数 / 值、柯里化派生、三时态、异常语义），未经操作员验收 |
| [A.md](A.md) | 独立论证 RFC 建立了什么以及为何必须建立；以完整执行故事、反例、取舍与可证伪验收展开，不替代规范正文 |
| [DRAFT-seq-par-task-model.md](DRAFT-seq-par-task-model.md) | 找回的清洗稿（原自称 RFC 的单向序并任务模型稿，覆盖前最后状态），供回溯与对照 |
| [SYNTH-546-task-model-seq-par.md](SYNTH-546-task-model-seq-par.md) | #546 issue 聚合草稿本体（6388 行本地合成：RFC #546 + 全部 25 sub-issue），自 `../../synthesized/` 拷入；清洗稿的全部 `SYNTH:L…` 引注指向它 |
| [EVIDENCE.md](EVIDENCE.md) | 事实、实验、源码定位与原文件迁移索引；**证据不产生需求** |
| [WORKFLOW.md](WORKFLOW.md) | R0–R12 gate、主/subagent 边界、当前状态和下一步 |
| [OVERALL.md](OVERALL.md) | 工程总体草稿（未经操作员验收）：存活资产逐行标注 + 工程结论（**无待裁决项**，全部推导/归属；D-3/D-8/D-9 移交 RFC-2 平面）+ 拆分蓝图（W1–W10 + W-acc 候选；旧 children 全部关闭候选零继承）；重拆 issue 的前置 |
| `README.md` | 唯一入口，不承载第二份规范或过程报告 |

## 当前状态

**R8 已完成**（2026-07-31）。操作员裁决系列——三时态（定义 / 编译 / 运行）、运行态 = 锁 + 只增日志、对象 / 函数 / 值三域（task 是唯一调度对象、状态只在函数域、item/phase 是值）、柯里化派生、异常语义（fail-stop 依赖线 + par 隔离 + 声明消费者）、await 构造——已整体写入 RFC，旧结构稿全文替换；被 supersede 的旧裁决（(item, phase) 粒度、join 演化、子树取消、v3-goals）登记于 [RFC 附录 B](RFC.md#附录-bsupersession-与-r8-闭合记录2026-07-31)。

末两项已于同日闭合（[RFC 附录 B](RFC.md#附录-bsupersession-与-r8-闭合记录2026-07-31)）：① 原 B-D6-2 经源码调查证实 v2 trigger 为电平触发、每 episode 一次、无跨 episode 记忆（`src/scheduler.ts:649-655, 2974-2986`），await 派生语义逐点等价、零回归成立；② M2 `published` 裁定为自有通道 contains-tip 档位，定义入 RFC §四。**R8 完成，无剩余未决项**。工程总体草稿见 [OVERALL.md](OVERALL.md)（未经操作员验收，不生效）；重拆顺序 = 总体验收 → D 项逐一裁决 → 操作员放行 → 按 SYNTH 密度基准拆分。GitHub 未重拆，#698–#709 保持 OPEN 原状。

## 阅读纪律

1. 要了解产品合同，只读 [RFC.md](RFC.md)。
2. 要理解合同建立的机制及其因果理由，读 [A.md](A.md)。
3. 要复核主张或路径，读 [EVIDENCE.md](EVIDENCE.md)。
4. 要恢复主 agent 工作，读 [WORKFLOW.md](WORKFLOW.md)。
5. 调查报告、代码现状、测试结果、反例和评审只提供证据；未经 RFC 明确采纳，均不得新增机制、约束或需求。
