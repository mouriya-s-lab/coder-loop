# #581 feat(gui): prompt 展示——per attempt 渲染全文与变量→值对照

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:20Z  | updated: 2026-07-17T20:41:33Z
- closed: 2026-07-17T20:41:33Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/581
- comments: 2  | timeline events: 17

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "**prompt 展示**：per attempt 的渲染全文 + 变量→值对照表 + fresh/resume 标记。" — #544 信息架构

> "prompt 展示｜打开任一已完成 attempt｜渲染全文 + 变量→值对照 + fresh/resume 标记；全文与实际 argv 所发一致" — #544 关闭验证行 4

> "GUI 除了做全链路展示，还得有 prompt 展示。" — #544 操作员目标（verbatim，`v3/v3-goals.md` 目标 1）

## 目标

任一 attempt 的实发 prompt 在 GUI 可见：渲染全文 + 变量→值对照 + fresh/resume 标记。

## 使用场景

operator 怀疑某轮 agent 行为异常时，打开该 attempt 直接看它到底收到了什么 prompt、每个 `{{KEY}}` 当时的值——不再进 run 目录翻文件。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（实施前自行 grep 行号）。

- 数据源：#572 落盘的 `<logDir>/<runId>/<phase>/prompt.md` + `bindings.json`（同源性质："落盘输入与 argv 构造取自同一个 `effectivePrompt` 值" — #572 预期结果 1）——「与实际 argv 所发一致」由该性质承载，GUI 端不重复验证、只如实读取。
- bindings 值形态：基线为字符串化渲染值；#552 落地后 additive 携带类型化值（#572 预期结果 3）——对照表展示须容纳两种形态。
- 入口：#580 的 attempt 视图。
- 落盘豁免边界：网关直读 run 目录内 #572 产物属 B 裁决同款「同仓特许消费者」形态；对其他消费者 #411 禁令不变。

## 问题

> "**prompt 事后不可见**……「prompt 展示」缺硬前置。" — #544 现状问题 2

#572 补上持久化后，GUI 若无消费面，操作员目标「还得有 prompt 展示」仍未闭环。

## 预期结果

性质表述：

1. **全文如实**：attempt 页展示 `prompt.md` 全文，与文件字节一致（不截断、不 markdown 二次加工导致语义损失——原文透传呈现）。
2. **对照表**：`bindings.json` 的每个 KEY→值成对展示；resume attempt 明示 resume 标记、所续 session，并展示该 attempt 实发的完整 `effectivePrompt`；固定「继续」只属于 chain-complete finalizer 特例，不外推到普通 scheduler resume。
3. **缺失如实**：#572 落地前的历史 attempt（无落盘产物）显示「该 attempt 早于 prompt 持久化，无快照」——不报错、不留空白骗人。
4. **类型不塌**：`bindings.json` 经边界 parse 进精确类型再渲染。

## 不应残留

- 本 child 范围内：GUI 侧重放 `renderPrompt` 的任何尝试（#544 已钉不可行）；对 prompt 内容的解析/改写。
- 范围之外不动：落盘机制（归 #572）；attempt 钻取骨架（归 #580）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- 响应式（移动可用）。

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 展示如实（#544 关闭验证行 4 具体化） | 起一轮真实 run 后打开该 attempt 页，与 `<logDir>/<runId>/<phase>/prompt.md`、`bindings.json` 逐字对照 | operator Mac + 浏览器 | 全文一致；对照表 KEY/值与文件一致；fresh 标记正确 |
| integration | resume 形态 | 对普通 scheduler resume attempt 与 chain-complete finalizer resume 特例分别重复上项 | 同上 | 普通 resume 显示 resume 标记 + 所续 session + 当次完整 `effectivePrompt`；仅 finalizer 特例显示固定「继续」；两者均与实际 argv 完全一致 |
| function | 历史缺失如实 | 打开一个 #572 之前的旧 attempt | 同上 | 明示无快照的原因说明 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #572（落盘数据源）、#552（`bindings.json` 类型化值形态）、#576（网关宿主）、#580（attempt 视图入口）。
- Blocks: 无（#585 收尾在其后 gate）。


---

## Comments (2)

### comment #4866584962 by `RiriAgent` — 2026-07-02T14:02:28Z

## 架构切片

1. **系统定位**：attempt 明细级的 prompt 展示视图——#572 产物的唯一 GUI 消费者。
2. **全局坐标**：run 目录观测产物域 → 前端（`bindings.json` 边界 parse；`prompt.md` 原文透传）。
3. **类型↔值不漂移**：防值漂移——GUI 重放渲染即第二套值来源（#544 已钉不可行亦不可为）；只读文件单源。
4. **消除的错误类别**：「展示的 prompt ≠ 实发的 prompt」不可表达（#572 同源性质 + 原文透传）。

## log/观测义务

无新增义务。


### comment #5007301712 by `RiriAgent` — 2026-07-17T20:41:32Z

重新拆分后由 #725 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (17)

- 2026-07-02T12:02:22Z `assigned` @RiriAgent
- 2026-07-02T12:02:45Z `cross-referenced` @RiriAgentsrc=572
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:56Z `cross-referenced` @RiriAgentsrc=580
- 2026-07-02T12:03:03Z `cross-referenced` @RiriAgentsrc=585
- 2026-07-02T14:02:00Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:28Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:33Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:46Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:36:48Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:36:51Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-17T20:36:57Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:41:32Z `commented` @RiriAgent
- 2026-07-17T20:41:33Z `closed` @RiriAgentcommit=None