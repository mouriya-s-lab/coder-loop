# #571 Spike: TanStack Start (Bun) 网关宿主——多接口选择性绑定与 SSE/WS 推送可行性

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:01:56Z  | updated: 2026-07-05T09:10:21Z
- closed: 2026-07-05T09:10:21Z  | state_reason: `completed`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/571
- comments: 3  | timeline events: 16

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。本 child 是其 G/D 两项裁决所依赖假设的前置验证。继承条款逐字快照：

> "前端栈｜**TanStack Start**｜操作员指定。自带服务端运行时——网关进程即 TanStack Start server 本身，一个进程承载静态资产 + API server routes + WS/SSE 推送" — #544 裁决记录 G

> "网关只绑 localhost + netbird 接口，**无公网监听**；无应用层鉴权（D 裁决），token 为登记在案的可选演进。" — #544 约束

## 目标

验证一个假设：Bun 运行时下的 TanStack Start server 能同时做到——(a) 单进程承载静态资产 + API server routes + SSE/WS 长连接推送；(b) 监听面可选择性收窄到 localhost + netbird 接口两个地址，不监听其余接口。

## 上下文

- Repo: `mouriya-s-lab/coder-loop`。基线 main@b92ddaa（2026-07-02 核实）。
- 仓内无任何 HTTP server 先例；repo 为单包（`package.json` 无 `workspaces`），TanStack Start 依赖尚未引入。
- 验证环境：operator Mac（netbird 接口在场，mesh 内另有可发起访问的设备）。

## 假设原文

上引 G 裁决与约束节两句即假设本体。TanStack Start 是较新框架，其 Bun 运行时下的多地址选择性绑定与长连接行为属未文档化/未在本环境验证的第三方行为——#576（网关骨架）与 #577（实时推送）的实现形态整体建立在其上。

## 验证步骤

在 scratch 目录（不并入仓）起最小 TanStack Start app（Bun 运行时），逐项取证：

1. **server route**：一个返回 JSON 的 API route，`curl` 验证。
2. **长连接推送**：一个 SSE 流 route（或 WS，取更受支持者）持续推送递增事件，客户端观察到增量到达、连接保持 ≥60s 不被运行时切断。
3. **静态资产同进程**：build 后的前端资产由同一进程服务。
4. **监听面收窄**：配置只绑 `127.0.0.1` + netbird 接口 IP；`lsof -iTCP -sTCP:LISTEN` 证明无 `0.0.0.0`/LAN 接口监听；从 LAN IP 访问不可达、mesh 内设备访问可达。

## 结果分支

- **passed**：证据（版本号、关键配置、命令与输出）落本 issue comment；#576/#577 按 G 裁决实现，绑定与推送机制引用本 spike 结论。
- **failed**（任一能力缺失）：带证据回 #544 thread 走设计修正 comment（宿主形态重裁，例如 `Bun.serve` 自管 HTTP + TanStack Start 仅作前端层），**不进实现**。

## 不应残留

- 产出是证据与结论，不是生产代码；scratch 工程不并入仓、不留半成品目录。
- 不预写网关业务代码（归 #576）；不引入生产依赖变更。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| assumption | 四条验证步骤全部有可复现证据 | 按 comment 中记录的命令逐条重跑 | operator Mac + mesh 内第二设备 | 每条命令输出与 comment 证据一致 |
| assumption | 监听面收窄成立 | `lsof -iTCP -sTCP:LISTEN -P \| grep <port>` | operator Mac | 仅 127.0.0.1 与 netbird IP 两行监听；LAN IP `curl` 连接拒绝/超时，mesh 设备可达 |
| assumption | 结果分支已执行 | 查本 issue comment | GitHub | passed 证据 comment，或 failed 证据 + #544 设计修正 comment 存在 |

## 依赖关系

- Depends on: 无。
- Blocks: #576（网关骨架）、#577（events 直读与实时推送）。


---

## Comments (3)

### comment #4866583054 by `RiriAgent` — 2026-07-02T14:02:15Z

## 架构切片

1. **系统定位**：#544 架构图中「GUI 网关进程」宿主选型的前置验证件——不是系统部件，是 G/D 两裁决所依赖假设的证据供给。
2. **全局坐标**：验证的边界是「mesh 网络域 ↔ 网关监听面」（接口绑定收窄）与「网关 ↔ 浏览器」（长连接推送），不触引擎任何域。
3. **类型↔值不漂移**：不适用（无生产代码）；防的是「框架能力假设漂移」——假设写在 RFC，能力在第三方，spike 使两者以证据对齐。
4. **消除的错误类别**：「宿主选型错误在 #576/#577 实现中途才暴露」从可能变为不可能（先证后建）。

## log/观测义务

无运行期事件义务；证据与结论落本 issue comment（结果分支义务见 body）。


### comment #4885479901 by `RiriAgent` — 2026-07-05T09:05:17Z

## Spike 结果：**passed**

四条验证步骤全部有可复现证据。TanStack Start (Bun 运行时) 生产 build 产出的 handler 可直接被两个 `Bun.serve` 实例共享，绑到 loopback + netbird 接口，LAN 面完全不监听；SSE 长连接 65s 无中断、客户端断开后进程存活；静态资产、API server routes、SSE 由同一进程承载。#576/#577 的 G/D 裁决假设成立。

## 环境事实

- Bun `1.3.14`（`bun --version`）；macOS Darwin 24.6.0 arm64。
- 本机接口（`ifconfig`）：`en0=192.168.1.220` (LAN)、`utun100=100.85.126.69` (netbird)；其余 `bridge*` / `utun[0-5]` 为其他隧道，不参与本 spike。
- 远端 mesh peer 选定 `vctcn-runner`：netbird IP `100.85.156.166`，物理位置 OVH 云、LAN `172.16.1.181/24`——与本机 LAN `192.168.1.0/24` 完全不同段，**只能经 netbird mesh 到达本机**（`ssh root@100.85.156.166 ip -4 addr show eth0/wt0` 已核）。
- TanStack Start 版本：CLI scaffold `bunx @tanstack/cli create app --framework react -y`（`@tanstack/react-start` latest，`vite ^8.0.0`，`react ^19.2.0`）。scaffold 未加显式 nitro plugin——新版 `tanstackStart()` plugin 内部处理 build target，`vite build` 直接产出 `dist/client/*` + `dist/server/server.js`（59.49 kB），server 模块导出 `default` `{ fetch(request) }` 与 named `fetch`。

## 关键代码（可复现路径）

**`src/routes/api/hello.ts`**（JSON API route）：

```ts
import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/api/hello')({
  server: { handlers: {
    GET: async ({ request }) => Response.json({
      hello: 'world', spike: '571', url: request.url, ts: new Date().toISOString(),
    }),
  }},
})
```

**`src/routes/api/events.ts`**（SSE server route，用 `request.signal` 干净跟随断开——见"副作用发现 1"）：

```ts
import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/api/events')({
  server: { handlers: {
    GET: async ({ request }) => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          let n = 0, closed = false
          const close = () => {
            if (closed) return
            closed = true
            clearInterval(iv)
            try { controller.close() } catch {}
          }
          const push = () => {
            if (closed) return
            try {
              const line = `data: ${JSON.stringify({ n: n++, ts: Date.now() })}\n\n`
              controller.enqueue(encoder.encode(line))
            } catch { close() }
          }
          push()
          const iv = setInterval(push, 1000)
          request.signal.addEventListener('abort', close, { once: true })
        },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    },
  }},
})
```

**`server.ts`**（自定义 Bun 生产入口，两个 `Bun.serve` 实例共享同一 handler）：

```ts
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
// @ts-expect-error - built artifact
import handler from './dist/server/server.js'

const CLIENT_DIR = resolve(import.meta.dir, 'dist/client')
const PORT = Number(process.env.PORT ?? 3571)

async function serveStatic(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  let pathname = url.pathname
  if (pathname === '/') return null
  if (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  const abs = join(CLIENT_DIR, pathname)
  if (!abs.startsWith(CLIENT_DIR)) return null
  if (!existsSync(abs)) return null
  const file = Bun.file(abs)
  const stat = await file.stat()
  if (!stat.isFile()) return null
  return new Response(file)
}

async function fetchHandler(request: Request): Promise<Response> {
  const staticResponse = await serveStatic(request)
  if (staticResponse) return staticResponse
  return handler.fetch(request)
}

const HOSTNAMES = ['127.0.0.1', '100.85.126.69'] as const
const servers = HOSTNAMES.map((hostname) =>
  Bun.serve({ hostname, port: PORT, fetch: fetchHandler }),
)
for (const s of servers) console.log(`listening on http://${s.hostname}:${s.port}`)
process.on('SIGINT', () => { for (const s of servers) s.stop(true); process.exit(0) })
```

## 验证证据

### 1. server route（JSON API）

命令：`curl -s http://127.0.0.1:3571/api/hello`（本机 loopback）+ `curl -sm 5 http://100.85.126.69:3571/api/hello`（远端 mesh peer 侧）。

本机侧：

```json
{"hello":"world","spike":"571","url":"http://127.0.0.1:3571/api/hello","ts":"2026-07-05T08:55:59.477Z"}
```

远端 mesh peer 侧（`ssh root@100.85.156.166 curl -sm 5 http://100.85.126.69:3571/api/hello`）：

```json
{"hello":"world","spike":"571","url":"http://100.85.126.69:3571/api/hello","ts":"2026-07-05T09:00:16.213Z"}
```

### 2. 长连接推送（SSE，≥60s 不切）

命令（远端 mesh peer）：`ssh root@100.85.156.166 'timeout --signal=INT 65 curl -sN --output /tmp/sse.out http://100.85.126.69:3571/api/events'`。

结果：

```
elapsed=65s
bytes=2265
events=65
first 2 events:
data: {"n":0,"ts":1783242122974}

last 3 events:

data: {"n":64,"ts":1783242187059}
```

65s 期间事件计数 65（每秒 1 条，`n=0..64`），无丢无断。断开后立即：

```
$ ps -p 43569 -o pid,command
  PID COMMAND
43569 bun --bun run server.ts
```

进程未 crash，`curl http://127.0.0.1:3571/api/hello` 立刻正常返回——**SSE 客户端断开时正确回收 setInterval，subsequent request 无影响**。

### 3. 静态资产同进程

命令：`curl -sI http://127.0.0.1:3571/favicon.ico` + 远端 mesh peer 侧同请求。

```
HTTP/1.1 200 OK
content-length: 3870
```

两侧一致。scaffold 生成的 `dist/client/favicon.ico`（`Bun.file` 直接返回）——同一进程既 serve `/favicon.ico` 静态字节，又 handle `/api/*` server route。

### 4. 监听面收窄

`lsof -iTCP -sTCP:LISTEN -P | grep 3571`：

```
bun  43569 mouriya  4u  IPv4  TCP localhost:3571 (LISTEN)          # 127.0.0.1
bun  43569 mouriya  6u  IPv4  TCP macmini.mouriya.lan:3571 (LISTEN) # 100.85.126.69
```

**无 `*:3571` / `0.0.0.0:3571`，无 `192.168.1.220:3571`**——收窄成立。

- **LAN IP 从本机拒达**：`curl -sm 3 http://192.168.1.220:3571/api/hello` → `http_code=000 time=0.001265`（1ms 内 connection refused，因本机没在 en0 绑）。
- **LAN IP 从 mesh peer 拒达**：`ssh root@100.85.156.166 'curl -sm 4 http://192.168.1.220:3571/api/hello'` → `http_code=000 time=4.001663`（4s timeout，vctcn-runner 在 OVH 172.16.1.181/24，与本机 LAN 完全不通）。
- **netbird IP 从 mesh peer 可达**：见证据 1/2/3 三条远端命令的输出。

## 副作用发现（写进 #576/#577 的落地指引）

### 1. SSE handler 必须绑 `request.signal` 干净跟随客户端断开——否则进程崩

首次实现时未接 `request.signal.abort`，客户端断开后：`controller.close()` 已跑 → 下一次 `setInterval` `push` → `controller.enqueue` 抛 `TypeError: Invalid state: Controller is already closed` → uncaught → **Bun 进程退出**。日志证据：

```
TypeError: Invalid state: Controller is already closed
      at push (/.../dist/server/assets/router-Dc0KoRjR.js:268:16)
Bun v1.3.14 (macOS arm64)
```

修法（上「关键代码」`events.ts` 已内含）：`request.signal.addEventListener('abort', close, { once: true })` + `push` 用 try/catch 兜后手一次。**#577（events 直读与实时推送）落地时必须写这层——否则单个恶意/意外断开可打死 daemon 侧网关进程**，与「Bun 的可靠性优势」直接冲突。

### 2. 静态资产伺服归网关自实现——TanStack Start handler 不自动服务 `dist/client/*`

`handler.fetch(request)` 只处理 SSR route + server routes，不 serve `dist/client/*` 下的构建静态资产。自定义 `server.ts` 里前置 `serveStatic` 是**必需**一层（上「关键代码」已示范：路径存在性判断 + `Bun.file` 直接返回）。生产品质版可参考 TanStack Start hosting docs 的 Bun reference example（预压缩 gzip、ETag、Cache-Control）。**#576（网关骨架）应把该层作为自有职责登记**。

### 3. macOS 本机 curl → netbird IP 触发自 utun 自环 quirk

本机 `curl http://100.85.126.69:3571/api/hello` 超时。`route -n get 100.85.126.69` 显示 destination 走 `utun100` 接口，包被 route 到隧道内自身 IP 但不 loopback 回本地 socket——**这是 macOS 路由决策 quirk，不是 Bun.serve 绑定问题**。lsof 证明监听存在、远端 mesh peer 完美到达即证。**GUI 客户端方案不受影响**：本机浏览器访问 `http://127.0.0.1:PORT`；其他设备经 mesh 访问 `http://100.85.126.69:PORT`；无场景需要「本机 curl 到自身 netbird IP」。#576 文档里登记一句即可，不需要额外机制。

### 4. `Bun.serve` 一次调用一个 hostname——多接口靠多实例共享 handler

Bun 原生 `Bun.serve` `hostname` 参数是单值。多接口通过**多次 `Bun.serve()` 共享同一 `fetch` handler** 实现（上「关键代码」`HOSTNAMES.map(...)`）。这是稳定官方 API，无框架侵入——#576 落地时该模式可直接搬。若未来需要 SO_REUSEPORT / SO_BINDANY 之类 kernel 级多绑，需另开 spike，本 spike 不覆盖。

## 结论

- G 裁决（TanStack Start (Bun) 单进程承载静态资产 + API + SSE/WS 推送）：**验证通过**。
- D 裁决约束（网关只绑 localhost + netbird 接口，无公网监听）：**验证通过**——LAN IP 在本机与远端 mesh peer 两侧均拒达；`lsof` 无 `*` / LAN 网卡监听。
- #576 / #577 按 #544 已裁决实现，绑定与推送机制参照本 comment「关键代码」+「副作用发现」四条落地指引；SSE handler 必须接 `request.signal` 是硬门（否则进程崩）。
- spike scratch 工程留在本机 `/private/tmp/claude-501/.../scratchpad/571-spike/app`，不并入仓；本 issue 关闭。



### comment #4885493070 by `RiriAgent` — 2026-07-05T09:10:20Z

Spike passed。结论证据已扩散到下游被阻塞的 issue：#576（网关宿主）与 #577（events 直读与实时推送）各自收到本 spike 结论 comment，含可直接 copy 的关键代码与落地硬门。#544 G/D 裁决所依赖假设已验证成立。


---

## Timeline (16)

- 2026-07-02T12:01:57Z `assigned` @RiriAgent
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:52Z `cross-referenced` @RiriAgentsrc=577
- 2026-07-02T12:03:02Z `cross-referenced` @RiriAgentsrc=584
- 2026-07-02T14:01:47Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:15Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T09:05:17Z `commented` @RiriAgent
- 2026-07-05T09:10:20Z `commented` @RiriAgent
- 2026-07-05T09:10:21Z `closed` @RiriAgentcommit=None
- 2026-07-16T23:38:35Z `referenced` @RiriAgentcommit=05ee53cc42027da2343ce5f24c5a0103e919fdb8
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:37:00Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-26T23:49:21Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-26T23:49:29Z `cross-referenced` @RiriAgentsrc=728