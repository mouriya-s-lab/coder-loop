# v3 合成 issue（本地，未写回 GitHub）

按六个 RFC umbrella + 验收伞 #683 分组，把每个 RFC 下全部 sub-issue 合并成一份"大 issue"。
**这些文件不在 GitHub 上**，是本地合成产物，仅为阅读与归档。

## 文件

| 文件 | RFC | 子 issue 数 | 说明 |
|---|---|---|---|
| [SYNTH-543](SYNTH-543-hook-observability-gate.md) | #543 | 15 | 生命周期 hook、gate 执行 |
| [SYNTH-544](SYNTH-544-gui-observability-gateway.md) | #544 | 29 | 可观测性 API 与 Web GUI 网关 |
| [SYNTH-545](SYNTH-545-context-shared-cli.md) | #545 | 10 | context 共享 CLI |
| [SYNTH-546](SYNTH-546-task-model-seq-par.md) | #546 | 25 | 任务模型：序/并代数与调度 |
| [SYNTH-547](SYNTH-547-type-system-compile.md) | #547 | 21 | 类型系统与编译产物 |
| [SYNTH-548](SYNTH-548-external-runner-router.md) | #548 | 9 | 第三方调用、外部 runner、GitHub router |
| [SYNTH-683](SYNTH-683-acceptance-layering.md) | #683 | 2 | 整链路验收分层 |

## 每份合成 issue 的结构

1. **范围与组成** — RFC、子 issue 计数与状态分布
2. **一、RFC 设计骨架** — RFC body 原文
3. **二、当前实现 children (OPEN)** — 当前 spec，全文嵌入
4. **三、已落地 children (CLOSED·COMPLETED)** — 含关闭 commit/PR 证据
5. **四、已替代草稿 (CLOSED·NOT_PLANNED)** — 摘要（目标/预期结果片段）
6. **五、关键评论摘录** — ≥200 字符的决策性回复
7. **六、依赖与关联** — GraphQL sub-issue graph

## 数据来源

- `../issues/<N>/issue.json` — body + metadata
- `../issues/<N>/comments.json` — 全部回复
- `../issues/<N>/timeline.json` — 关闭/引用 commit
- `../issues/<N>/subissues.json` — GraphQL sub-issue 关系
- `../design/*.md` — v3 设计书
