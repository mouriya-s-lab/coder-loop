# #572 feat(engine): 渲染后 prompt 与绑定值快照落盘（prompt.md + bindings.json）

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:01:58Z  | updated: 2026-07-17T20:41:15Z
- closed: 2026-07-17T20:41:15Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/572
- comments: 2  | timeline events: 16

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "**prompt 持久化点**：`spawnOneAttempt` 构造 argv 前把渲染后全文写 `<runDir>/<phase>/prompt.md`、绑定值快照写 `bindings.json`（`{{KEY}}` → 实际值）；resume attempt 同样落盘当次真实 `effectivePrompt` 并标记 resume。保留策略跟随 run 目录既有生命周期，不新增 GC 语义。" — #544 引擎侧新增工作 1

> "prompt 持久化深度｜**渲染文本 + 绑定值快照**（`prompt.md` + `bindings.json`）｜GUI 可展示变量→值对照，与 RFC-2 元信息预览衔接；绑定表本在内存，成本≈0" — #544 裁决记录 C

> "#544 的 prompt 落盘 child 原可先行；#552 落地后 `bindings.json` 必须消费类型化值，#605 裁决后 attempt 必须从实例 pinned definition 渲染。" — 当前依赖收口（取代 2026-07-02 的旧排序假设）

## 目标

每个 attempt 实际发给 runner 的 prompt 全文与绑定值，在该 run 目录留下持久快照，事后可查。

## 使用场景

- GUI prompt 展示页（#581）读取 per-attempt 全文与变量→值对照——#544 关闭验证行 4 的引擎半。
- operator 排障时直接打开 `<logDir>/<runId>/<phase>/` 看某 attempt 实际收到什么，不再从 `promptChars` 反猜。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（2026-07-02 核实，实施前自行 grep 行号）。

- `spawnOneAttempt`（`src/loop.ts:5829`）：函数体内唯一 `writeFile` 写 `status.json`（`promptChars: effectivePrompt.length`，`src/loop.ts:5861`，落盘 `:5872`）；prompt 全文只经 `buildRunnerInvocation`（调用点 `:5845`，argv 注入 `:6217-6274`）传给子进程——渲染后 prompt 现不落盘。
- resume 固定 prompt：`RESUME_CONTINUE_PROMPT = "继续"`（`src/loop.ts:979`）。
- 绑定解析链：`renderPrompt`（`:5120`）→ `resolvePhaseBinding`（`:5148`）→ `stringifyBindingValue`（`:5420`）——绑定表在渲染现场内存可得。
- run 目录生命周期（2026-07-02 核实）：无任何独立 GC；唯一清除路径是 `chain.delete` 的 `cleanupChainRuntime`（`src/daemon.ts:2174`）。「跟随既有生命周期」即随 chain 删除级联，无新增语义。

## 问题

> "**prompt 事后不可见**。`spawnOneAttempt` 只把 `promptChars`（字符数）写进 `status.json`……渲染后 prompt 全文只作为子进程 argv 传给 runner……不落盘。事后重放 `renderPrompt` 不可行——ctx 依赖 item 当时状态快照与一次性 `runId`。「prompt 展示」缺硬前置。" — #544 现状问题 2

## 预期结果

性质表述：

1. **一切 attempt 都留快照**：凡经 `spawnOneAttempt` 发出的 attempt（fresh 与 resume、全部 runner kind）在其 run 目录留下 prompt 全文与绑定值快照；落盘输入与 argv 构造取自同一个 `effectivePrompt` 值——「展示的」与「实发的」在构造点同源，不可能分叉。
2. **resume 如实**：resume attempt 落盘内容 = 当次实发的真实 `effectivePrompt`，并携带 resume 标记与所续 session 引用。scheduler 主路径 resume 会重新渲染完整 phase prompt；不得把 chain-complete finalizer 专用的固定「继续」外推到普通 resume。
3. **绑定快照完整**：每个 `{{KEY}}` 的 source 与渲染值都在 `bindings.json`；值形态基线为现状渲染值，#552（变量绑定类型流）落地后 additive 携带类型化值——shape 预留类型化位，届时不做 breaking 重构。
4. **落盘失败不挡 run、不静默**：写入失败发 diagnostic observability 事件后 attempt 照常执行（快照是观测辅助，不是执行前置；静默丢失被事件可见性排除）。
5. **定义来源固定**：effective prompt 与 bindings 从该 attempt 所属实例的 #605 pinned definition 解引用；不得在 spawn、retry 或 daemon 重启恢复后重读同路径当前 preset。

## 不应残留

- 本 child 范围内：不留「只写长度不写内容」的旧路径语义描述（`promptChars` 字段本身保留兼容）；不留绕过落盘的 spawn 分支。
- 范围之外不动：渲染逻辑与绑定语义（归 #552）、GUI 消费面（归 #581）、run 目录 GC（明确不新增）、#534 audit 树在修的 v2 缺陷。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- 排序默认（总控简报 2026-07-02）：#534 audit 树 children 先合，本 child 在其后 rebase；偏离需在 PR 说明。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | fresh attempt 落盘 | `bun test`（新增用例：spawn 一次 fresh attempt 后断言 `prompt.md` 内容 === 传给 `buildRunnerInvocation` 的 prompt 参数、`bindings.json` 含全部 KEY 与值） | 本机 | 断言通过；同源断言（同一变量引用）在场 |
| function | resume attempt 落盘 | `bun test`（新增用例：普通 scheduler resume 断言落盘内容等于当次完整 `effectivePrompt`；chain-complete finalizer 专用路径另断言固定「继续」；两者均含 resume 标记 + session 引用） | 本机 | 两条路径分别与实际 argv 完全一致，不把 finalizer 专用 prompt 外推到普通 resume |
| function | 落盘失败语义 | `bun test`（新增用例：注入写失败，断言 attempt 继续 + diagnostic 事件发射） | 本机 | 断言通过 |
| environment | 既有测试不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #552（`bindings.json` 的类型化值形态与 required/type 语义）、#605（attempt 必须从实例 pinned definition 渲染，不得重读当前 preset）。
- Blocks: #581（GUI prompt 展示）；#581 不得在缺少类型化 bindings 的降级形态下关闭。


---

## Comments (2)

### comment #4866583242 by `RiriAgent` — 2026-07-02T14:02:17Z

## 架构切片

1. **系统定位**：L1 引擎 spawn 路径（`spawnOneAttempt`）的观测产物出口级——run 目录新增两个 per-attempt 工件；不改调度与渲染语义。
2. **全局坐标**：引擎 typed 域（渲染现场的 `effectivePrompt` + 绑定表）→ 文件系统观测域（`prompt.md`/`bindings.json`）；同源投影，无信任级变化（两侧均 engine-owned）。
3. **类型↔值不漂移**：防值漂移——「实发 prompt」与「展示 prompt」若各自来源即漂移，同一 `effectivePrompt` 值单源封死；`bindings.json` 值形态锚 #552 类型流，防第二套值编码。
4. **消除的错误类别**：「事后无法知道 agent 收到什么」从必然变为不可表达（每 attempt 必有快照）；「拿 `promptChars` 反猜」退役。

## log/观测义务

落盘失败发 diagnostic 事件（kind=diagnostic）——唯一新增事件义务；成功路径零新事件（文件本身即观测产物）。


### comment #5007299808 by `RiriAgent` — 2026-07-17T20:41:14Z

重新拆分后由 #717 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (16)

- 2026-07-02T12:01:59Z `assigned` @RiriAgent
- 2026-07-02T12:02:58Z `cross-referenced` @RiriAgentsrc=581
- 2026-07-02T12:03:03Z `cross-referenced` @RiriAgentsrc=585
- 2026-07-02T14:01:48Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:17Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T07:53:40Z `cross-referenced` @RiriAgentsrc=552
- 2026-07-10T11:55:45Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:33Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-17T20:36:48Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:36:51Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-17T20:36:57Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:37:18Z `cross-referenced` @RiriAgentsrc=737
- 2026-07-17T20:41:14Z `commented` @RiriAgent
- 2026-07-17T20:41:15Z `closed` @RiriAgentcommit=None