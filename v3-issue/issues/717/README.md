# #717 feat(engine): 渲染后 prompt 与 bindings 快照

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:32Z  | updated: 2026-07-27T01:00:23Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/717
- comments: 0  | timeline events: 5

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

落盘 per-attempt prompt.md 与 bindings.json，作为 GUI 只读输入。

每个 attempt 实际发给 runner 的 prompt 全文与绑定值，在该 run 目录留下持久快照，事后可查。

## 问题

> "**prompt 事后不可见**。`spawnOneAttempt` 只把 `promptChars`（字符数）写进 `status.json`……渲染后 prompt 全文只作为子进程 argv 传给 runner……不落盘。事后重放 `renderPrompt` 不可行——ctx 依赖 item 当时状态快照与一次性 `runId`。「prompt 展示」缺硬前置。" — #544 现状问题 2

## 预期结果

性质表述：

1. **一切 attempt 都留快照**：凡经 `spawnOneAttempt` 发出的 attempt（fresh 与 resume、全部 runner kind）在其 run 目录留下 prompt 全文与绑定值快照；落盘输入与 argv 构造取自同一个 `effectivePrompt` 值——「展示的」与「实发的」在构造点同源，不可能分叉。
2. **resume 如实**：resume attempt 落盘内容 = 当次实发的真实 `effectivePrompt`，并携带 resume 标记与所续 session 引用。scheduler 主路径 resume 会重新渲染完整 phase prompt；不得把 chain-complete finalizer 专用的固定「继续」外推到普通 resume。
3. **绑定快照完整**：每个 `{{KEY}}` 的 source 与渲染值都在 `bindings.json`；值形态基线为现状渲染值，#737（变量绑定类型流）落地后 additive 携带类型化值——shape 预留类型化位，届时不做 breaking 重构。
4. **落盘失败不挡 run、不静默**：写入失败发 diagnostic observability 事件后 attempt 照常执行（快照是观测辅助，不是执行前置；静默丢失被事件可见性排除）。
5. **定义来源固定**：effective prompt 与 bindings 从该 attempt 所属实例的 #743 pinned definition 解引用；不得在 spawn、retry 或 daemon 重启恢复后重读同路径当前 preset。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | fresh attempt 落盘 | `bun test`（新增用例：spawn 一次 fresh attempt 后断言 `prompt.md` 内容 === 传给 `buildRunnerInvocation` 的 prompt 参数、`bindings.json` 含全部 KEY 与值） | 本机 | 断言通过；同源断言（同一变量引用）在场 |
| function | resume attempt 落盘 | `bun test`（新增用例：普通 scheduler resume 断言落盘内容等于当次完整 `effectivePrompt`；chain-complete finalizer 专用路径另断言固定「继续」；两者均含 resume 标记 + session 引用） | 本机 | 两条路径分别与实际 argv 完全一致，不把 finalizer 专用 prompt 外推到普通 resume |
| function | 落盘失败语义 | `bun test`（新增用例：注入写失败，断言 attempt 继续 + diagnostic 事件发射） | 本机 | 断言通过 |
| environment | 既有测试不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：L1 引擎 spawn 路径（`spawnOneAttempt`）的观测产物出口级——run 目录新增两个 per-attempt 工件；不改调度与渲染语义。
2. **全局坐标**：引擎 typed 域（渲染现场的 `effectivePrompt` + 绑定表）→ 文件系统观测域（`prompt.md`/`bindings.json`）；同源投影，无信任级变化（两侧均 engine-owned）。
3. **类型↔值不漂移**：防值漂移——「实发 prompt」与「展示 prompt」若各自来源即漂移，同一 `effectivePrompt` 值单源封死；`bindings.json` 值形态锚 #737 类型流，防第二套值编码。
4. **消除的错误类别**：「事后无法知道 agent 收到什么」从必然变为不可表达（每 attempt 必有快照）；「拿 `promptChars` 反猜」退役。

## log/观测义务

落盘失败发 diagnostic 事件（kind=diagnostic）——唯一新增事件义务；成功路径零新事件（文件本身即观测产物）。

## 依赖关系

- Depends on: 无。
- Blocks: #725、#729。


---

## Comments (0)

---

## Timeline (5)

- 2026-07-17T20:36:33Z `assigned` @RiriAgent
- 2026-07-17T20:38:46Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:47Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:15Z `cross-referenced` @RiriAgentsrc=572