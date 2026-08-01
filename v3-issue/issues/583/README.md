# #583 feat(gui): context entries 展示面——纯消费 #545 read boundary

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:25Z  | updated: 2026-07-17T20:41:37Z
- closed: 2026-07-17T20:41:37Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/583
- comments: 2  | timeline events: 17

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）与 #545（RFC: v3 context 共享 CLI）。继承条款逐字快照：

> "**RFC-3（#545，已裁）**：context entries 展示面消费 #545 read 命令的 arktype boundary（shape 归 #545 拥有），本 RFC 纯消费；分页/过滤形态随其实现 child。" — #544 接口假设

> "**RFC-5（#544，已裁）**：entries 的 read API 及其 JSON shape 归**本 RFC**——daemon socket 读命令的返回 boundary（arktype）即 GUI 消费契约，#544 纯消费不定义。" — #545 接口假设

> "entries 展示面——归 RFC-5。" — #545 范围外

范围说明：本 child 无 #544 关闭验证行对应（不在其关闭验证表内）——它是两 RFC 接缝的显式承诺（上引三条），验收自足于本 issue，不回填 #544 验收表。

## 目标

context entries 在 GUI 可见：按 scope（item / chain / group）浏览某 chain 的 entries，shape 纯消费 #545 read boundary。

## 使用场景

operator 排查「上一轮 agent 给下一轮留了什么」：打开 item 视图看其谱系 entries、chain 视图看链级公告、par 容器视图看分支组内通信——不用以 operator 身份跑 CLI 查询。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa。

- 数据源：#545 read 命令的 daemon socket 面与其 arktype 返回 boundary（"read API 返回 GUI 可消费 JSON……shape 与本 RFC read 命令的 arktype boundary 一致（#544 纯消费该契约）" — #545 关闭验证行 7）。网关以 operator 主体（零凭证）调用，"operator 无凭证路径全量读写任意 chain"（#545 设计裁决 3）。
- scope 词表（#545 设计裁决 2 逐字）："`item`（同一 item 的跨 run/跨 phase 谱系——retry 轮次之间、phase 之间）+ `chain`（跨 item 的链级公告）+ `group`（并行分支组内通信；scope 键 = par 节点物化时的稳定容器 id，#546 已裁）"。
- body 语义（#545 核心设计）："envelope 类型化、body 不透明……引擎对 body 逐字携带、永不提取语义"——GUI 同样原文透传展示 body，不解析不改写。
- 挂载位：#580 的 item/chain 视图；group scope 键源自 #558 钉住的容器稳定 id。

## 问题

#545 落地后 entries 是影响 agent 判断质量的一等中间态，但只有 CLI 查询面；#544/#545 接缝三处互指「展示面归 RFC-5」，若无本 child 该承诺无 owner。

## 预期结果

性质表述：

1. **三 scope 视图**：item 谱系 / chain 公告 / group 分支组三种 scope 的 entries 在对应对象视图可浏览，envelope 字段（id/ts/scope/author）与 body 原文如实展示。
2. **shape 零定义**：网关与前端的 entries 类型全部从 #545 read boundary 派生——GUI 代码无 entry shape 的平行定义；分页/过滤跟随 #545 实现 child 落地的形态，GUI 不自造维度。
3. **body 不透明贯穿**：GUI 对 body 只做原文透传（等宽/原样渲染），不 markdown 解析、不提取结构。

## 不应残留

- 本 child 范围内：entry shape 平行定义；对 body 的任何解析路径；绕过 daemon socket 直读 entries 存储（SQLite 表是 daemon 私有，网关快照面豁免不延伸到此——读一律经 #545 read 命令）。
- 范围之外不动：read API 与过滤/分页形态（归 #545 children）；scope 语义与存储（归 #545）；钻取骨架（归 #580）。

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
| integration | 三 scope 浏览 | 用 CLI 分别写 item/chain/group scope entries 若干，GUI 对应视图查看 | operator Mac + 浏览器 | 各 scope entries 落位正确、envelope 与 body 与写入一致 |
| function | shape 零定义 | code review + `grep` 网关代码 entry 字段的类型定义来源 | 本机 | 类型全部 import 自 #545 boundary，无平行定义 |
| function | body 不透明 | 写入含状态字面量/markdown/控制记号的 body 后查看 | 浏览器 | 原文透传显示，无解析副作用 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #576（网关宿主）、#580（挂载视图）、#595（context 共享读取命令面——scope 过滤查询与 GUI 消费 boundary）。
- Blocks: 无（#585 收尾在其后 gate）。


---

## Comments (2)

### comment #4866585327 by `RiriAgent` — 2026-07-02T14:02:30Z

## 架构切片

1. **系统定位**：A 域内容通道（context entries）的 GUI 只读展示面——纯消费 #545 read boundary。
2. **全局坐标**：daemon context 服务域 →（operator 主体 socket read 命令）→ 网关 → 前端；不触 entries 存储表。
3. **类型↔值不漂移**：防类型泄露——entry shape 平行定义；body 不透明贯穿——不解析即不把 body 语义编码进前端。
4. **消除的错误类别**：「查 entries 必须开终端跑 CLI」退役；「GUI 解析 body 引入第二套语义」不可表达（原文透传）。

## log/观测义务

无新增义务（读命令审计归 #545 机制）。


### comment #5007302186 by `RiriAgent` — 2026-07-17T20:41:36Z

重新拆分后由 #727 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (17)

- 2026-07-02T12:02:26Z `assigned` @RiriAgent
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:56Z `cross-referenced` @RiriAgentsrc=580
- 2026-07-02T12:03:03Z `cross-referenced` @RiriAgentsrc=585
- 2026-07-02T14:02:02Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:30Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T07:49:22Z `cross-referenced` @RiriAgentsrc=595
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:46Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:36:53Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:36:55Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:36:57Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:37:02Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-17T20:41:36Z `commented` @RiriAgent
- 2026-07-17T20:41:37Z `closed` @RiriAgentcommit=None