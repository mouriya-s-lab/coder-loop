# #728 feat(gui): mesh 内移动端与 PWA

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:56Z  | updated: 2026-07-27T01:00:35Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/728
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

在 gateway/control 页面完成后交付移动端。

手机经 netbird mesh 使用 GUI 成立：PWA 可加主屏，移动首屏聚焦「跑没跑 + 异常清单 + 控制面动作」，深层浏览与 PC 同构。

## 问题

PC 浏览器可用不等于手机可用：无 PWA manifest 则无法加主屏、每次翻浏览器输 mesh 地址；首屏信息密度按 PC 设计时，手机上「一眼跑没跑」退化为滚动翻找；控制面按钮的触控可用性未经真机验证——关闭验证行 6 在此之前无法闭合。

## 预期结果

性质表述：

1. **PWA 成立**：manifest + 可安装性达标，手机可加主屏并以独立窗口打开。
2. **移动首屏裁剪**：移动视口下首屏优先呈现跑没跑（三证+活 run）、异常清单、控制面动作；深层信息可达但不挤占首屏。
3. **控制面动作可完成**：#722/#723 全部动作在手机上可触达并生效；有 capability 时可从 decision dossier 提交 per-epoch operator decision，无 capability 时只展示 authority 缺口。
4. **同构不分叉**：移动与 PC 是同一应用同一路由——无移动专用第二实现。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| integration | 真机全流程（#544 关闭验证行 6 具体化） | 手机经 netbird mesh 打开网关 → 安装 PWA → 主屏打开 → 首屏核对 → 执行一次控制面动作（如 unblock、daemon restart，或有 capability 时的 per-epoch operator decision） | mesh 内真机手机 | 每步成功；动作生效（status 核对）；证据截图（经 image-share 上传）附 PR |
| function | 移动首屏裁剪 | 移动视口（真机或 devtools 模拟）打开首屏 | 手机/浏览器 | 跑没跑 + 异常清单 + 控制面动作无滚动可见 |
| function | PC 不回归 | PC 视口过一遍 #722/#723/#724 主要页面 | 浏览器 | 布局与功能无回归 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 架构切片

1. **系统定位**：同一应用的移动形态收口级——PWA 化 + 首屏裁剪 + 真机验证；无独立部件。
2. **全局坐标**：mesh 网络域 ↔ 手机浏览器/PWA；无新增服务边界。
3. **类型↔值不漂移**：防值漂移——移动专用平行实现即双副本；同一路由同构封死。
4. **消除的错误类别**：「手机上不可用/不可达」从未验证假设变为真机证据钉住。

## log/观测义务

无新增义务。

## 依赖关系

- Depends on: #720、#722、#723。
- Blocks: #729。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:36:58Z `assigned` @RiriAgent
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:42Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:38:43Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:40:01Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:39Z `cross-referenced` @RiriAgentsrc=584