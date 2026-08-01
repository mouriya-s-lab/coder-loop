# #720 feat(gui): TanStack 网关与严格只读数据面

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:39Z  | updated: 2026-07-27T01:00:26Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/720
- comments: 0  | timeline events: 14

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

网关只消费严格只读 snapshot 入口；不得迁移 SQLite、改变 WAL/journal 或复制 SQL snapshot builder。

网关进程存在且形态合规：coder-loop 仓内的 TanStack Start server（Bun），mesh-only 监听，绑定一个 loop-data root，带 socket RPC 客户端与 SQLite 只读快照两个数据面。

## 问题

> "**对外协议真空**。daemon 唯一控制面是 Unix socket 行 JSON RPC……无长连接、无订阅推送、无任何 HTTP/WS。……GUI 没有现成网络协议可用。" — #544 现状问题 1

## 预期结果

性质表述：

1. **进程形态合规**：一条命令启动网关进程；进程即 TanStack Start server（Bun 运行时），静态资产与 server routes 同进程。
2. **监听面收窄是配置不动点**：监听地址集合 = {localhost, netbird 接口}——不是默认 `0.0.0.0` 加防火墙备注；非 mesh 网络不可达。
3. **root 绑定单一**：一个网关实例绑定一个 loop-data root（默认生产 root，可配置）；网关内不存在跨 root 访问路径。
4. **两数据面就位**：socket RPC typed client（零凭证 = operator 主体；命令词表从引擎 `DaemonCommandName` 派生，不复制字符串表）；SQLite 只读快照 route（复用 `buildCoderLoopStatusSnapshot`，网关代码无任何 SQLite 写路径）。
5. **红线在前端同样成立**：网关↔前端之间的数据经边界 parse 为精确类型；无 `any`/匿名形状。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 进程可起 | 网关启动命令（PR 落定后逐字记录于 PR body） | operator Mac | 进程起、浏览器打开最小状态页、快照数据在场 |
| environment | mesh-only（#544 关闭验证行 8 具体化） | `lsof -iTCP -sTCP:LISTEN -P \| grep <port>`；LAN IP `curl`；mesh 设备访问 | operator Mac + mesh 内第二设备 | 监听仅 localhost + netbird 接口；LAN 不可达；mesh 可达 |
| function | SQLite 零写路径 | `grep` 网关代码中的 SQLite 写 API 调用 + code review | 本机 | 网关只经 `buildCoderLoopStatusSnapshot` 只读；无写调用 |
| function | RPC 词表单源 | 阅读网关 socket client：命令名来源 | 本机 | 类型自引擎 `DaemonCommandName` 派生，无字符串表拷贝 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #571、#716、#718。
- Blocks: #721、#722、#723、#724、#725、#726、#727、#728、#729。


---

## Comments (0)

---

## Timeline (14)

- 2026-07-17T20:36:40Z `assigned` @RiriAgent
- 2026-07-17T20:38:35Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:38:37Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:38:41Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:38:42Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:38:43Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:38:45Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:38:46Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-17T20:38:48Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:38:49Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:38:50Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:50Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:21Z `cross-referenced` @RiriAgentsrc=576