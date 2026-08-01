# #584 feat(gui): 移动端与 PWA——mesh 内手机可用的首屏与控制面

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:27Z  | updated: 2026-07-17T20:41:39Z
- closed: 2026-07-17T20:41:39Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/584
- comments: 2  | timeline events: 18

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "**移动端**：同一响应式应用 + PWA（可加主屏），不做原生壳；移动首屏偏「跑没跑 + 异常清单 + 控制面动作」，深层浏览与 PC 同构。" — #544 信息架构

> "移动端可用｜手机经 netbird mesh 打开 + PWA 安装｜首屏与控制面动作在移动端可完成；PWA 可加主屏" — #544 关闭验证行 6

> "GUI 的设计需要同时考虑 PC 和移动端" — #544 操作员目标（verbatim，`v3/v3-goals.md` 目标 1）

## 目标

手机经 netbird mesh 使用 GUI 成立：PWA 可加主屏，移动首屏聚焦「跑没跑 + 异常清单 + 控制面动作」，深层浏览与 PC 同构。

## 使用场景

operator 不在电脑前，手机收到异常感知（或例行瞥一眼）：打开主屏 PWA → 首屏即见 daemon 三证/异常清单 → 当场 unblock / 重启 daemon——#544 裁决 F 理由（"手机场景 = 看见异常当场处置"）的完整落地。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa。

- 前置页面：#578（首屏）、#579（控制面动作）、#580（深层浏览）已按「响应式（移动可用）」约束落地——本 child 不是移动化 retrofit，而是移动形态的收口：PWA 化 + 移动首屏信息裁剪 + 真机验证。
- mesh 可达性：网关监听 netbird 接口（#576），手机在 mesh 内直接访问；#571 spike 已验证 mesh 设备可达性机制。
- 无原生壳（#544 范围外节："原生移动 app——PWA 覆盖"）。

## 问题

PC 浏览器可用不等于手机可用：无 PWA manifest 则无法加主屏、每次翻浏览器输 mesh 地址；首屏信息密度按 PC 设计时，手机上「一眼跑没跑」退化为滚动翻找；控制面按钮的触控可用性未经真机验证——关闭验证行 6 在此之前无法闭合。

## 预期结果

性质表述：

1. **PWA 成立**：manifest + 可安装性达标，手机可加主屏并以独立窗口打开。
2. **移动首屏裁剪**：移动视口下首屏优先呈现跑没跑（三证+活 run）、异常清单、控制面动作；深层信息可达但不挤占首屏。
3. **控制面动作可完成**：#578/#579 全部动作在手机上可触达并生效；有 capability 时可从 decision dossier 提交 per-epoch operator decision，无 capability 时只展示 authority 缺口。
4. **同构不分叉**：移动与 PC 是同一应用同一路由——无移动专用第二实现。

## 不应残留

- 本 child 范围内：移动专用平行页面/路由分叉；PC 端回归（响应式改动破坏 PC 布局）。
- 范围之外不动：页面功能本体（归 #578/#579/#580）；鉴权（D 裁决：mesh-only 裸信任，token 是登记的可选演进，不在本 child 引入）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- 不做原生壳（#544 范围外）。

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 真机全流程（#544 关闭验证行 6 具体化） | 手机经 netbird mesh 打开网关 → 安装 PWA → 主屏打开 → 首屏核对 → 执行一次控制面动作（如 unblock、daemon restart，或有 capability 时的 per-epoch operator decision） | mesh 内真机手机 | 每步成功；动作生效（status 核对）；证据截图（经 image-share 上传）附 PR |
| function | 移动首屏裁剪 | 移动视口（真机或 devtools 模拟）打开首屏 | 手机/浏览器 | 跑没跑 + 异常清单 + 控制面动作无滚动可见 |
| function | PC 不回归 | PC 视口过一遍 #578/#579/#580 主要页面 | 浏览器 | 布局与功能无回归 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #578（首屏）、#579（控制面动作）、#580（深层浏览）。
- Blocks: 无（#585 收尾在其后 gate）。


---

## Comments (2)

### comment #4866585548 by `RiriAgent` — 2026-07-02T14:02:32Z

## 架构切片

1. **系统定位**：同一应用的移动形态收口级——PWA 化 + 首屏裁剪 + 真机验证；无独立部件。
2. **全局坐标**：mesh 网络域 ↔ 手机浏览器/PWA；无新增服务边界。
3. **类型↔值不漂移**：防值漂移——移动专用平行实现即双副本；同一路由同构封死。
4. **消除的错误类别**：「手机上不可用/不可达」从未验证假设变为真机证据钉住。

## log/观测义务

无新增义务。


### comment #5007302411 by `RiriAgent` — 2026-07-17T20:41:38Z

重新拆分后由 #728 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (18)

- 2026-07-02T12:02:28Z `assigned` @RiriAgent
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:54Z `cross-referenced` @RiriAgentsrc=578
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=579
- 2026-07-02T12:02:56Z `cross-referenced` @RiriAgentsrc=580
- 2026-07-02T12:03:03Z `cross-referenced` @RiriAgentsrc=585
- 2026-07-02T14:02:03Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:32Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:42Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:36:44Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:36:46Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:36:55Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:36:57Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:41:38Z `commented` @RiriAgent
- 2026-07-17T20:41:39Z `closed` @RiriAgentcommit=None