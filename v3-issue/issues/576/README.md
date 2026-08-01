# #576 feat(gui): 网关进程骨架——TanStack Start (Bun) + mesh-only 监听 + socket RPC/SQLite 只读两数据面

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:08Z  | updated: 2026-07-17T20:41:21Z
- closed: 2026-07-17T20:41:21Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/576
- comments: 7  | timeline events: 29

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "API 层宿主｜**独立 GUI 网关进程**（否决 daemon 内嵌 HTTP）｜GUI 价值最高的时刻恰是 daemon 不健康的时刻；观测面与被观测者同进程 = 监控随对象一起死。" — #544 裁决记录 A

> "仓库归属｜**monorepo**（coder-loop repo 内）｜B 裁决使 events 文件形态成为网关正式契约面，「钦定内部契约」只有同仓同版本演进才安全；跨 repo 即变成事实公共 API" — #544 裁决记录 E

> "前端栈｜**TanStack Start**｜操作员指定。自带服务端运行时——网关进程即 TanStack Start server 本身，一个进程承载静态资产 + API server routes + WS/SSE 推送" — #544 裁决记录 G

> "**三个数据面各司其职**：mutation 与瞬时状态走 socket RPC（网关无 agent 凭证，daemon 视之为 operator 主体……）；事件推送与历史走 events JSONL 直读；队列/链快照走 SQLite 只读——这不是新侧门，`buildCoderLoopStatusSnapshot` 本就以 `openSqliteStateStore({ createIfMissing: false })` 只读直读 SQLite……网关同仓 import 复用同一构建器。" — #544 架构

> "网关对 SQLite **严格只读**；一切 mutation 经 daemon socket RPC。" / "网关只绑 localhost + netbird 接口，**无公网监听**；无应用层鉴权（D 裁决）……" / "一个网关实例绑定一个 loop-data root（默认生产 `~/.coder-loop/loop-data`）；隔离 e2e root 不带 GUI。" — #544 约束

## 目标

网关进程存在且形态合规：coder-loop 仓内的 TanStack Start server（Bun），mesh-only 监听，绑定一个 loop-data root，带 socket RPC 客户端与 SQLite 只读快照两个数据面。

## 使用场景

基座 child：#577–#584 全部页面与能力挂在本进程上。本 child 交付后 operator 可从 mesh 内浏览器打开网关、看到快照数据渲染的最小状态页——完整首屏判据归 #578。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（2026-07-02 核实，实施前自行 grep 行号）。

- 仓为单包：`package.json` 无 `workspaces`；`tsconfig.json` `rootDir: "src"`、`include: ["src"]`——网关 app 的包/构建结构由实现定，硬约束只有两条：同仓（E 裁决）+ 能以编译期类型 import 引擎导出的契约（#573/#574 的 boundary 类型、快照构建器）。
- socket RPC 参照：`sendDaemonRequest`（`src/daemon.ts:3833`）——每请求一连接、行 JSON；daemon 命令词表是编译期 closed union `DaemonCommandName`（`src/daemon.ts:133-173`）。
- socket/pid 路径：`resolveLoopDataPaths`（`src/runtime-paths.ts:113`），`daemon.sock`/`daemon.pid` 文件名常量（`:13-14`）。
- 快照复用：`buildCoderLoopStatusSnapshot`（`src/loop.ts:2724`）只读构建——网关 server route 同仓 import 调用，不自写 SQL。
- 宿主可行性证据：#571 spike 结论（多接口绑定 + SSE/WS 机制）。
- #548 接缝（登记不消费）："第三方 ingress 不与本网关共用宿主/对外协议面（#548 裁决 B）；本 RFC「HTTP 面模块化可挂 route」的保证登记但无人消费"（#544 接口假设）——不构成本 child 的实现约束，不为 ingress 预留代码。

## 问题

> "**对外协议真空**。daemon 唯一控制面是 Unix socket 行 JSON RPC……无长连接、无订阅推送、无任何 HTTP/WS。……GUI 没有现成网络协议可用。" — #544 现状问题 1

## 预期结果

性质表述：

1. **进程形态合规**：一条命令启动网关进程；进程即 TanStack Start server（Bun 运行时），静态资产与 server routes 同进程。
2. **监听面收窄是配置不动点**：监听地址集合 = {localhost, netbird 接口}——不是默认 `0.0.0.0` 加防火墙备注；非 mesh 网络不可达。
3. **root 绑定单一**：一个网关实例绑定一个 loop-data root（默认生产 root，可配置）；网关内不存在跨 root 访问路径。
4. **两数据面就位**：socket RPC typed client（零凭证 = operator 主体；命令词表从引擎 `DaemonCommandName` 派生，不复制字符串表）；SQLite 只读快照 route（复用 `buildCoderLoopStatusSnapshot`，网关代码无任何 SQLite 写路径）。
5. **红线在前端同样成立**：网关↔前端之间的数据经边界 parse 为精确类型；无 `any`/匿名形状。

## 不应残留

- 本 child 范围内：`0.0.0.0` 监听；网关侧手写 SQL 或第二套快照构建；daemon 命令字符串字面量拷贝；对 agent 凭证机制的任何触碰。
- 范围之外不动：引擎代码（本 child 零引擎改动——若发现需要引擎改动，回 #544 thread 登记而非顺手改）；events 读取面（归 #577）；控制面动作（归 #578/#579）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- 上引约束节三句（SQLite 严格只读 / mesh-only 无公网监听无应用层鉴权 / 单 root 绑定）逐字生效。
- UI 从本 child 起响应式（移动可用）——row 6 的验收与 PWA 归 #584，但不做「先 PC 后补移动」的回工。

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 进程可起 | 网关启动命令（PR 落定后逐字记录于 PR body） | operator Mac | 进程起、浏览器打开最小状态页、快照数据在场 |
| environment | mesh-only（#544 关闭验证行 8 具体化） | `lsof -iTCP -sTCP:LISTEN -P \| grep <port>`；LAN IP `curl`；mesh 设备访问 | operator Mac + mesh 内第二设备 | 监听仅 localhost + netbird 接口；LAN 不可达；mesh 可达 |
| function | SQLite 零写路径 | `grep` 网关代码中的 SQLite 写 API 调用 + code review | 本机 | 网关只经 `buildCoderLoopStatusSnapshot` 只读；无写调用 |
| function | RPC 词表单源 | 阅读网关 socket client：命令名来源 | 本机 | 类型自引擎 `DaemonCommandName` 派生，无字符串表拷贝 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #571（宿主可行性 spike——绑定与推送机制以其结论为准）。
- Blocks: #577、#578、#579、#580、#581、#582、#583、#584。


---

## Comments (7)

### comment #4866583993 by `RiriAgent` — 2026-07-02T14:02:22Z

## 架构切片

1. **系统定位**：#544 架构图的「GUI 网关进程」本体 + 三数据面中两面（socket RPC、SQLite 只读）的接入端；A 裁决的独立进程边界即此。
2. **全局坐标**：mesh 网络域 ↔ 网关（监听面收窄）；网关 ↔ daemon（socket RPC，operator 主体）；网关 ↔ SQLite（只读，复用引擎构建器）。三条边各有约束点。
3. **类型↔值不漂移**：防类型泄露——RPC 命令词表从引擎 `DaemonCommandName` 派生不复制；防值漂移——快照复用引擎同一构建器，无第二套 SQL。
4. **消除的错误类别**：「观测面随 daemon 一起死」（A 裁决动机）从结构上不可表达——进程独立。

## log/观测义务

网关自身运行日志形态归实现；对引擎零新增事件义务。


### comment #4885492862 by `RiriAgent` — 2026-07-05T09:10:16Z

## #571 spike 结论：assumption 已验证，本 child 可启动

Spike #571（TanStack Start (Bun) 网关宿主可行性）已 passed，四条验证全绿，evidence comment https://github.com/mouriya-s-lab/coder-loop/issues/571#issuecomment-4885479901。#544 G/D 裁决所依赖的假设成立：TanStack Start (Bun) 生产 build 产出的 handler 可被两个 `Bun.serve` 实例共享，绑到 loopback + netbird 接口，LAN 面完全不监听。

## 本 child 从 spike 直接消费的两条模式（copy 即可）

### 1. 多接口选择性绑定 = 多次 `Bun.serve()` 共享同一 `fetch` handler

`Bun.serve` 的 `hostname` 参数是单值，多接口靠多实例共享 handler。稳定官方 API，无框架侵入：

```ts
// server.ts —— 自定义 Bun 生产入口（TanStack Start 官方 hosting docs 的 custom Bun implementation 路径）
// @ts-expect-error - built artifact
import handler from './dist/server/server.js'

const HOSTNAMES = ['127.0.0.1', '100.85.126.69'] as const
const PORT = Number(process.env.PORT ?? 3571)

const servers = HOSTNAMES.map((hostname) =>
  Bun.serve({ hostname, port: PORT, fetch: fetchHandler }),
)
```

`lsof` 证据（`spike` 期实测）：无 `*:port` / `0.0.0.0:port` / LAN 网卡监听，只有两条精确 hostname:port 条目。#544 D 裁决约束满足。

### 2. 静态资产伺服归网关自实现（**本 child 自有职责**）

TanStack Start 生产 `handler.fetch(request)` **不 serve `dist/client/*`**——只处理 SSR route + server routes。自定义 `server.ts` 必须前置 `serveStatic` 层：

```ts
async function serveStatic(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  let pathname = url.pathname
  if (pathname === '/') return null // let handler render index HTML
  if (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  const abs = join(CLIENT_DIR, pathname)
  if (!abs.startsWith(CLIENT_DIR)) return null // path traversal guard
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
```

生产品质增强（预压缩 gzip、ETag、Cache-Control、intelligent asset preloading）参考 TanStack Start hosting docs 的 Bun reference example；spike 已验最小可用形态，本 child 落地时可按需要拔高。

## 副作用登记（文档一句即可，非机制）

macOS 本机 curl → 自身 netbird IP 触发路由自 utun 自环 quirk（100.85.126.69 → utun100 → 隧道内自身包不 loopback 回 socket）。**不影响 GUI 使用**：本机浏览器访问 `http://127.0.0.1:PORT`；其他设备经 mesh 访问 `http://100.85.126.69:PORT`；无场景需要「本机 curl 自身 netbird IP」。#576 README/文档一句登记即可，无需机制。

## 与 #577 的边界

推送通道种类 SSE（#571 已实测 65s 无中断，65 条事件无丢无断）；SSE handler 必须绑 `request.signal` 干净跟随客户端断开是**硬门**（#571 副作用 1，已同步 #577）——本 child 不实现推送逻辑，只承担进程宿主与静态资产伺服。



### comment #4949048303 by `RiriAgent` — 2026-07-11T22:50:47Z

## Review verdict: blocked

Independent review cannot advance #576 on current `main@f01560d5d0b324e791db7f599e502f09fc78a652` without violating the live issue contract.

### Verified blockers

1. **The required exact snapshot boundary is not available.** `StatusSnapshotBoundary` still exposes seven anonymous `"object"` slots in `src/loop.ts:504-512`; #574 remains open and itself depends on open #558. #576 requires the gateway/frontend boundary to parse into exact engine-derived types and forbids a parallel gateway schema.
2. **The mandated snapshot builder is not strictly read-only today.** `buildCoderLoopStatusSnapshot` reaches `openSqliteStateStore`; that store opens SQLite with `readwrite: true`, may execute `PRAGMA journal_mode = WAL`, and always invokes schema migration (`src/sqlite-state.ts:500-527`). #576 simultaneously requires strict gateway read-only access, reuse of `buildCoderLoopStatusSnapshot`, and zero engine changes.

### Independent replay

- No closing PR or implementation head exists; the issue branch equals `origin/main` at `f01560d5…` and has an empty diff.
- Acceptance rows 1-4 fail on current head: there is no gateway process/start command, mesh listener runtime, snapshot route, or typed socket client; no PR evidence packet or runtime manifest exists.
- Acceptance row 5 passed after documented fixture-checkout setup: `bun scripts/real-e2e.ts` closed fixture issue #277 and merged fixture PR #278 at `50552fbb2b89e8bd471c31c0679972dbd1247581` (exit 0, 240s, isolated daemon self-cleaned).
- Acceptance row 6 passed: `bun run typecheck && bun test` exited 0 with `505 pass`, `0 fail`.

### Contract repairs needed before unblock

- Land #574/#558 so the exact snapshot boundary is importable, or literally rescope #576 to an already-available exact boundary.
- Land a dedicated engine-owned strict-read-only snapshot read path, or literally revise #576's strict-read-only/reuse/zero-engine-change combination.
- Repair the live acceptance table to include its required `#` column and add `## Pattern 验收` with exact `Pattern | Scope | Criterion` rows for the prose-named whole-tree/changed patterns.

Resume only after both implementation prerequisites are landed (or the live body explicitly authorizes a different contract). This is not a failed implementation retry: an immediate rerun against the same main cannot create the missing engine contracts without breaking #576's zero-engine-change boundary.

blockerRepo: mouriya-s-lab/coder-loop
blockerRef: #574 plus strict-read-only status-snapshot engine path



### comment #4954886360 by `RiriAgent` — 2026-07-13T06:00:19Z

<!-- coder-loop:executable-contract schema=1 source-issue=576 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/576
- Observed body last-edited timestamp: `2026-07-02T12:02:50Z` (`lastEditedAt`; the issue-wide `updatedAt` observed during enrichment was `2026-07-11T22:50:47Z`).
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4866583993
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4885492862
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4949048303
- Verified hosting evidence used: https://github.com/mouriya-s-lab/coder-loop/issues/571#issuecomment-4885479901
- Architecture authority: https://github.com/mouriya-s-lab/coder-loop/issues/544
- Current-source observation: fetched `origin/main@a3ff0e9ce64c5a55feed029dee3e07a5b7b3cb8d`; its tree is byte-identical to the inspected checkout tree. `StatusSnapshotBoundary` still has seven anonymous `"object"` slots (`src/loop.ts:504-512`), `buildCoderLoopStatusSnapshot` still reads through `openSqliteStateStore` (`src/loop.ts:2762-2825,3904-3936`), and that store still opens with `readwrite: true`, may set WAL, and always migrates (`src/sqlite-state.ts:500-527`). The baseline `bun run typecheck` and `bun test` both exited 0 on this tree during enrichment.

## Deliverable

`implementation-pr`

One PR closes #576. It adds the same-repository TanStack Start gateway and stable root-level operator commands `gateway:start`, `gateway:build`, `gateway:typecheck`, and `gateway:test`; the internal package directory remains an implementation choice. The Bun gateway process serves static assets, server routes, and the minimal responsive status page, binds exactly loopback plus configured NetBird addresses, binds exactly one loop-data root at startup, imports the engine-owned typed socket/status contracts, and has no agent-credential or events-stream implementation. Events reading remains #577; lifecycle/control actions remain #578/#579; full first-screen behavior remains #578; PWA/mobile completion remains #584; engine changes are not part of this PR.

## Checks

| ID | Dimension | Kind | Command / cwd / env or browser procedure | Expected exit/output or observation |
|---|---|---|---|---|
| `C0` | prerequisite contracts | `shell` | `test "$(gh issue view 558 -R mouriya-s-lab/coder-loop --json state --jq .state)" = CLOSED && test "$(gh issue view 574 -R mouriya-s-lab/coder-loop --json state --jq .state)" = CLOSED && bun test src/sqlite-state.test.ts src/db-main-loop.test.ts -t "read-only status snapshot"` from repository root with active `RiriAgent` GitHub auth | Exit 0. #558 and #574 are closed by merged implementations, and the engine-owned status-snapshot read path proves read-only SQLite open, no schema migration/journal mutation, exact parsed snapshot output, and successful reads while the daemon is down. Do not start #576 implementation while this row cannot pass; do not satisfy it by changing engine files in the #576 PR. |
| `C1` | gateway focused behavior | `shell` | `bun run gateway:test` from repository root with the test-owned isolated loop-data roots and loopback-only test ports | Exit 0. Tests cover one-root binding, typed status-route success/rejection, daemon-down snapshot availability, typed socket request/response parsing, static-asset traversal rejection, exact host configuration, graceful multi-server shutdown, and responsive minimal-page rendering data. |
| `C2` | gateway type/build integrity | `shell` | `bun run gateway:typecheck && bun run gateway:build` from repository root with Bun 1.3.14 and frozen dependencies | Exit 0. TanStack Start produces client assets plus a Bun-loadable server handler; gateway and frontend compile from engine-derived exact types with no `any`, anonymous domain shape, internal `unknown`, or non-const `as` assertion. |
| `C3` | repository regression | `shell` | `bun run typecheck && bun test` from repository root | Exit 0 with no failed tests. The root typecheck includes the gateway package rather than leaving it outside the project graph; existing tests are not removed, skipped, renamed to evade collection, or weakened. |
| `C4` | real gateway data planes | `shell` | `bun scripts/gateway-e2e.ts` from repository root with Bun 1.3.14; the driver owns an isolated loop-data root, loopback port, real daemon lifecycle, gateway owner PID, and cleanup | Exit 0. The driver creates a real active chain through engine APIs, stops the daemon, starts the production gateway, reads that chain through the HTTP status route while the daemon remains down, proves the DB/schema/WAL files are byte/metadata unchanged by repeated reads, then starts the daemon and sends a typed read RPC through the gateway client. Boundary-invalid responses fail explicitly. The owner PID, socket, listener, and isolated root are cleaned. |
| `C5` | canonical engine E2E | `shell` | `bun scripts/real-e2e.ts` from repository root with configured `gh` and phase-selected runner CLIs | Exit 0; fixture PR is `MERGED`, fixture issue is `CLOSED`, isolated daemon/fixture/mutex teardown completes, and the harness does not start or require the GUI. |
| `C6` | local browser user path | `browser` | Start/readiness: run the Canonical runtime start command below against the C4 seeded root and wait for `curl -fsS 'http://127.0.0.1:3571/api/status?target=%2Fabsolute%2Ffixture%2Fcwd&chain=gateway-e2e'`; action: in a real browser at a mobile-width viewport open `http://127.0.0.1:3571/`; observation: inspect the rendered page and network response | The production page loads its built static assets from the same gateway PID, has no horizontal overflow at mobile width, and visibly renders the seeded chain identity plus snapshot state from an ArkType-parsed HTTP boundary. A shell-generated HTML substitute or screenshot of a fabricated page does not satisfy this row. |
| `C7` | mesh browser user path | `browser` | Start/readiness: same production gateway, with listeners on `127.0.0.1` and `100.85.126.69`; action: from a browser running on a distinct connected NetBird peer open `http://100.85.126.69:3571/`; observation: inspect the rendered page and its status request | The same minimal status page and seeded snapshot are usable from the mesh peer without application login, while the local page remains usable. The request reaches the NetBird listener, not a LAN/public listener or proxy. |
| `C8` | network confinement | `shell` | With the canonical gateway live on operator Mac, run `PORT=3571; lsof -nP -iTCP:$PORT -sTCP:LISTEN; ! curl -fsS --connect-timeout 3 http://192.168.1.220:$PORT/; ssh root@100.85.156.166 "curl -fsS --connect-timeout 5 http://100.85.126.69:$PORT/ >/dev/null"` from repository root; the remote command writes no temporary artifact | Exit 0. `lsof` shows only `127.0.0.1:3571` and `100.85.126.69:3571`, never `*:3571`, `0.0.0.0:3571`, `[::]:3571`, or `192.168.1.220:3571`; LAN access fails and the separate mesh peer succeeds. If current interface addresses differ, re-enrichment must update this literal row rather than silently widening the listener. |
| `C9` | diff and contract audit | `shell` | `git diff --check origin/main...HEAD && git diff --unified=0 origin/main...HEAD -- '*.ts' '*.tsx' '*.json'` from repository root | Exit 0. Review the complete added/modified output against every Pattern row below; no runtime artifact is staged, no engine file is changed, and no test/assertion integrity loss is hidden by the diff. |

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| `P1` | `whole-tree` | `StatusSnapshotBoundary|CoderLoopStatusSnapshot|buildCoderLoopStatusSnapshot` | Canonical engine definitions/exports and gateway imports/calls/tests | One exact engine-owned snapshot schema and builder. Gateway/frontend derive from it and parse at the HTTP boundary; no copied snapshot union, anonymous fallback object, hand-written SQL projection, or second builder remains. |
| `P2` | `whole-tree` | `openSqliteStateStore|new Database|PRAGMA|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE` within gateway production code | No gateway production site; engine-owned strict-read-only snapshot entrypoint is imported instead | Gateway cannot write, migrate, change journal mode, or issue SQL. Repeated gateway reads leave DB, WAL and schema state unchanged, including with daemon down. |
| `P3` | `whole-tree` | `DaemonCommandName|sendDaemonRequest|daemon\.|chain\.|item\.|logs\.|queue\.` within gateway production code | Engine command/auth definitions and a gateway generic typed client importing them; endpoint-specific uses may select an engine-declared member but may not declare a second vocabulary | Command names and request/response variants remain engine-derived closed types. No copied string union, registry, permissive command string, agent credential, or parallel wire parser remains. |
| `P4` | `whole-tree` | `loopDataRoot|loop-data-root|CODER_LOOP_GATEWAY_ROOT` within gateway production code | One startup configuration parser and immutable typed runtime context passed to server routes | Exactly one root is selected at process start. HTTP/browser/RPC requests cannot supply, override, enumerate, or escape to another root; there is no fallback to a request-relative or target-local root. |
| `P5` | `whole-tree` | `Bun\.serve|hostname|0\.0\.0\.0|\[::\]|::` within gateway production code | One gateway server-owner module plus focused tests | The server owner creates one `Bun.serve` per explicitly configured loopback/NetBird hostname over one shared TanStack handler. Wildcard, LAN-derived, public, silent fallback, and independently drifting handlers converge to zero. |
| `P6` | `whole-tree` | static-file path resolution and `dist/client` access within gateway production code | One canonical static-asset layer in the server owner plus focused tests | Built client assets are served by the same PID before TanStack route handling; traversal and non-file paths fail explicitly; no second static server/process exists. |
| `P7` | `changed` | added/modified TypeScript/TSX lines containing `\bany\b|\bunknown\b|\bas\b|"object"|Record<string` | `unknown` only at external catch/parse entry immediately consumed by an exact ArkType parser; `as const` only | No explicit/implicit `any`, true assertion, anonymous domain shape, unchecked map, or internal `unknown`. Socket, HTTP, environment/CLI, and gateway-to-frontend data enter through named exact parsers and flow as discriminated types. |

## Canonical runtime

- Setup: clean #576 branch from a current `origin/main` that already contains the merged C0 prerequisites; `bun install --frozen-lockfile`; Bun 1.3.14; configured `gh`; current operator interfaces observed during enrichment were loopback `127.0.0.1`, NetBird `100.85.126.69`, LAN `192.168.1.220`, and connected remote peer `vctcn-runner.mouriya.lan` (`100.85.156.166`). `bun scripts/gateway-e2e.ts` creates the isolated root and seeded active chain without touching production `~/.coder-loop`.
- Start: from repository root, `bun run gateway:start -- --loop-data-root "$ROOT" --hostname 127.0.0.1 --hostname 100.85.126.69 --port 3571 >"$EVIDENCE/gateway.stdout" 2>"$EVIDENCE/gateway.stderr" & GATEWAY_PID=$!`. This root-level command is the stable operator surface; internal package layout is not contractual.
- Readiness: require `kill -0 "$GATEWAY_PID"`, both exact listeners in `lsof -nP -iTCP:3571 -sTCP:LISTEN`, and `curl -fsS 'http://127.0.0.1:3571/api/status?target=%2Fabsolute%2Ffixture%2Fcwd&chain=gateway-e2e'` returning an exact parsed snapshot whose `state.kind` is `ok`.
- Behavior: execute C4, then C6-C8 against the production build. Snapshot reads must continue while daemon is down; after daemon start, the typed client must complete an engine-declared read RPC. Browser rows prove actual static asset, route, responsive render, and mesh reachability behavior; C5 separately proves the pre-existing full daemon/runner/GitHub loop remains green without a GUI dependency.
- Logs: preserve source SHA, Bun/dependency versions, exact start command, PID, listener output, status/RPC responses, before/after SQLite/WAL/schema evidence, browser URL/observations, network results, C1-C5 exits, and teardown under `/Users/mouriya/.coder-loop/loop-data/chains/v3-573/evidence/576/`. Do not stage these artifacts.
- Stop ownership: the shell that captured `GATEWAY_PID` sends `kill -INT "$GATEWAY_PID"`, waits for that PID, and proves both listeners are absent. C4 owns and removes only its isolated local root; C5 owns its daemon, fixture, and mutex teardown. Remote mesh checks write no assistant artifact and leave no process.

## Test delta

`required`

Add gateway-focused tests and the real `scripts/gateway-e2e.ts` driver for exact host selection, one-root immutability, static assets/traversal, typed status HTTP parsing, daemon-down read behavior, byte/metadata-stable SQLite reads, typed socket request/response handling, build/start/stop ownership, and responsive render data. Integrity rule: the root typecheck must include gateway code; preserve all existing collected tests and assertion strength; do not mock away SQLite open mode, TanStack production build, `Bun.serve`, socket transport, browser rendering, or network binding merely to obtain green output. Tests may move only when the replacement is a strict behavioral superset and the base/head inventory is reported.

## Dependencies

- #571 is closed `passed`; its evidence proves TanStack Start's Bun handler can be shared by multiple `Bun.serve` instances, static assets need the gateway-owned front layer, and loopback plus NetBird selective binding works: https://github.com/mouriya-s-lab/coder-loop/issues/571#issuecomment-4885479901
- #573 is closed by merged PR #671 and does not remove either current status prerequisite: https://github.com/mouriya-s-lab/coder-loop/pull/671
- #558 remains open with PR #675 open and unmerged. #574 explicitly depends on #558's persisted task-tree/status shape, so C0 cannot yet pass: https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/pull/675
- #574 remains open with no closing PR. Current main still exposes all seven anonymous `"object"` slots, so the gateway cannot legally create the exact frontend boundary required by #576: https://github.com/mouriya-s-lab/coder-loop/issues/574
- A second hard blocker remains exactly as recorded at https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4949048303: current `buildCoderLoopStatusSnapshot` reaches the read-write/migrating `openSqliteStateStore`. No separate issue or PR for an engine-owned strict-read-only snapshot path was found during enrichment. Because #576 forbids engine changes, that prerequisite must receive and land its own issue/PR before this implementation starts; do not copy SQL or add a gateway-local workaround.
- #576 currently has no linked/closing PR and no sub-issues. Its complete timeline contains no earlier executable-contract marker, so this comment supersedes none.
- Current local network fact at enrichment time: NetBird 0.74.2 reported `macmini.mouriya.lan` as `100.85.126.69/16` and `vctcn-runner.mouriya.lan` (`100.85.156.166`) connected; `en0` was `192.168.1.220`. #571 is the durable source for the two-device verification shape; address drift requires explicit contract refresh, never wildcard binding.

## Supersedes

none



### comment #4954951173 by `RiriAgent` — 2026-07-13T06:11:23Z

<!-- coder-loop:executable-contract schema=1 source-issue=576 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/576
- Observed body last-edited timestamp: `2026-07-02T12:02:50Z` (`lastEditedAt`; the issue-wide `updatedAt` observed during re-enrichment was `2026-07-13T06:00:19Z`).
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4866583993
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4885492862
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4949048303
- Verified hosting evidence used: https://github.com/mouriya-s-lab/coder-loop/issues/571#issuecomment-4885479901
- Architecture authority: https://github.com/mouriya-s-lab/coder-loop/issues/544
- Superseded contract: https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4954886360
- Re-enrichment evidence: iteration run `run-1783922480956-59-iteration-item-10` recorded in `/Users/mouriya/.coder-loop/loop-data/chains/v3-573/shared.md` that the prior marker was contradictory: it selected `implementation-pr` while its `C0` was a currently impossible start gate and explicitly prohibited implementation. The superseding contract therefore keeps the issue's real deliverable route, removes dependency state from `Checks`, and records it only under `Dependencies` so the current run can take the ordinary planning-stage blocked path rather than `contract_invalid`.
- Current-source observation: fetched `origin/main@a3ff0e9ce64c5a55feed029dee3e07a5b7b3cb8d`; its tree is byte-identical to the inspected checkout tree. `StatusSnapshotBoundary` still has seven anonymous `"object"` slots (`src/loop.ts:504-512`), `buildCoderLoopStatusSnapshot` still reads through `openSqliteStateStore` (`src/loop.ts:2762-2825,3904-3936`), and that store still opens with `readwrite: true`, may set WAL, and always migrates (`src/sqlite-state.ts:500-527`). The baseline `bun run typecheck` and `bun test` both exited 0 on this tree during enrichment.

## Deliverable

`implementation-pr`

One PR closes #576. It adds the same-repository TanStack Start gateway and stable root-level operator commands `gateway:start`, `gateway:build`, `gateway:typecheck`, and `gateway:test`; the internal package directory remains an implementation choice. The Bun gateway process serves static assets, server routes, and the minimal responsive status page, binds exactly loopback plus configured NetBird addresses, binds exactly one loop-data root at startup, imports the engine-owned typed socket/status contracts, and has no agent-credential or events-stream implementation. Events reading remains #577; lifecycle/control actions remain #578/#579; full first-screen behavior remains #578; PWA/mobile completion remains #584; engine changes are not part of this PR.

`implementation-pr` describes #576's eventual deliverable; it does not authorize work around missing external contracts. While the blockers in `Dependencies` remain, iteration must use its planning-stage blocked path and leave implementation/verification/submission unstarted. `blocker-removal` is not the route for #576 because this issue does not deliver either missing engine contract.

## Checks

| ID | Dimension | Kind | Command / cwd / env or browser procedure | Expected exit/output or observation |
|---|---|---|---|---|
| `C1` | gateway focused behavior | `shell` | `bun run gateway:test` from repository root with the test-owned isolated loop-data roots and loopback-only test ports | Exit 0. Tests cover one-root binding, typed status-route success/rejection, daemon-down snapshot availability, typed socket request/response parsing, static-asset traversal rejection, exact host configuration, graceful multi-server shutdown, and responsive minimal-page rendering data. |
| `C2` | gateway type/build integrity | `shell` | `bun run gateway:typecheck && bun run gateway:build` from repository root with Bun 1.3.14 and frozen dependencies | Exit 0. TanStack Start produces client assets plus a Bun-loadable server handler; gateway and frontend compile from engine-derived exact types with no `any`, anonymous domain shape, internal `unknown`, or non-const `as` assertion. |
| `C3` | repository regression | `shell` | `bun run typecheck && bun test` from repository root | Exit 0 with no failed tests. The root typecheck includes the gateway package rather than leaving it outside the project graph; existing tests are not removed, skipped, renamed to evade collection, or weakened. |
| `C4` | real gateway data planes | `shell` | `bun scripts/gateway-e2e.ts` from repository root with Bun 1.3.14; the driver owns an isolated loop-data root, loopback port, real daemon lifecycle, gateway owner PID, and cleanup | Exit 0. The driver creates a real active chain through engine APIs, stops the daemon, starts the production gateway, reads that chain through the HTTP status route while the daemon remains down, proves the DB/schema/WAL files are byte/metadata unchanged by repeated reads, then starts the daemon and sends a typed read RPC through the gateway client. Boundary-invalid responses fail explicitly. The owner PID, socket, listener, and isolated root are cleaned. |
| `C5` | canonical engine E2E | `shell` | `bun scripts/real-e2e.ts` from repository root with configured `gh` and phase-selected runner CLIs | Exit 0; fixture PR is `MERGED`, fixture issue is `CLOSED`, isolated daemon/fixture/mutex teardown completes, and the harness does not start or require the GUI. |
| `C6` | local browser user path | `browser` | Start/readiness: run the Canonical runtime start command below against the C4 seeded root and wait for `curl -fsS 'http://127.0.0.1:3571/api/status?target=%2Fabsolute%2Ffixture%2Fcwd&chain=gateway-e2e'`; action: in a real browser at a mobile-width viewport open `http://127.0.0.1:3571/`; observation: inspect the rendered page and network response | The production page loads its built static assets from the same gateway PID, has no horizontal overflow at mobile width, and visibly renders the seeded chain identity plus snapshot state from an ArkType-parsed HTTP boundary. A shell-generated HTML substitute or screenshot of a fabricated page does not satisfy this row. |
| `C7` | mesh browser user path | `browser` | Start/readiness: same production gateway, with listeners on `127.0.0.1` and `100.85.126.69`; action: from a browser running on a distinct connected NetBird peer open `http://100.85.126.69:3571/`; observation: inspect the rendered page and its status request | The same minimal status page and seeded snapshot are usable from the mesh peer without application login, while the local page remains usable. The request reaches the NetBird listener, not a LAN/public listener or proxy. |
| `C8` | network confinement | `shell` | With the canonical gateway live on operator Mac, run `PORT=3571; lsof -nP -iTCP:$PORT -sTCP:LISTEN; ! curl -fsS --connect-timeout 3 http://192.168.1.220:$PORT/; ssh root@100.85.156.166 "curl -fsS --connect-timeout 5 http://100.85.126.69:$PORT/ >/dev/null"` from repository root; the remote command writes no temporary artifact | Exit 0. `lsof` shows only `127.0.0.1:3571` and `100.85.126.69:3571`, never `*:3571`, `0.0.0.0:3571`, `[::]:3571`, or `192.168.1.220:3571`; LAN access fails and the separate mesh peer succeeds. If current interface addresses differ, re-enrichment must update this literal row rather than silently widening the listener. |
| `C9` | diff and contract audit | `shell` | `git diff --check origin/main...HEAD && git diff --unified=0 origin/main...HEAD -- '*.ts' '*.tsx' '*.json'` from repository root | Exit 0. Review the complete added/modified output against every Pattern row below; no runtime artifact is staged, no engine file is changed, and no test/assertion integrity loss is hidden by the diff. |

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| `P1` | `whole-tree` | `StatusSnapshotBoundary|CoderLoopStatusSnapshot|buildCoderLoopStatusSnapshot` | Canonical engine definitions/exports and gateway imports/calls/tests | One exact engine-owned snapshot schema and builder. Gateway/frontend derive from it and parse at the HTTP boundary; no copied snapshot union, anonymous fallback object, hand-written SQL projection, or second builder remains. |
| `P2` | `whole-tree` | `openSqliteStateStore|new Database|PRAGMA|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE` within gateway production code | No gateway production site; engine-owned strict-read-only snapshot entrypoint is imported instead | Gateway cannot write, migrate, change journal mode, or issue SQL. Repeated gateway reads leave DB, WAL and schema state unchanged, including with daemon down. |
| `P3` | `whole-tree` | `DaemonCommandName|sendDaemonRequest|daemon\.|chain\.|item\.|logs\.|queue\.` within gateway production code | Engine command/auth definitions and a gateway generic typed client importing them; endpoint-specific uses may select an engine-declared member but may not declare a second vocabulary | Command names and request/response variants remain engine-derived closed types. No copied string union, registry, permissive command string, agent credential, or parallel wire parser remains. |
| `P4` | `whole-tree` | `loopDataRoot|loop-data-root|CODER_LOOP_GATEWAY_ROOT` within gateway production code | One startup configuration parser and immutable typed runtime context passed to server routes | Exactly one root is selected at process start. HTTP/browser/RPC requests cannot supply, override, enumerate, or escape to another root; there is no fallback to a request-relative or target-local root. |
| `P5` | `whole-tree` | `Bun\.serve|hostname|0\.0\.0\.0|\[::\]|::` within gateway production code | One gateway server-owner module plus focused tests | The server owner creates one `Bun.serve` per explicitly configured loopback/NetBird hostname over one shared TanStack handler. Wildcard, LAN-derived, public, silent fallback, and independently drifting handlers converge to zero. |
| `P6` | `whole-tree` | static-file path resolution and `dist/client` access within gateway production code | One canonical static-asset layer in the server owner plus focused tests | Built client assets are served by the same PID before TanStack route handling; traversal and non-file paths fail explicitly; no second static server/process exists. |
| `P7` | `changed` | added/modified TypeScript/TSX lines containing `\bany\b|\bunknown\b|\bas\b|"object"|Record<string` | `unknown` only at external catch/parse entry immediately consumed by an exact ArkType parser; `as const` only | No explicit/implicit `any`, true assertion, anonymous domain shape, unchecked map, or internal `unknown`. Socket, HTTP, environment/CLI, and gateway-to-frontend data enter through named exact parsers and flow as discriminated types. |

## Canonical runtime

- Setup: after every blocker in `Dependencies` has landed, create a clean #576 branch from current `origin/main`; run `bun install --frozen-lockfile`; use Bun 1.3.14 and configured `gh`. Current operator interfaces observed during enrichment were loopback `127.0.0.1`, NetBird `100.85.126.69`, LAN `192.168.1.220`, and connected remote peer `vctcn-runner.mouriya.lan` (`100.85.156.166`). `bun scripts/gateway-e2e.ts` creates the isolated root and seeded active chain without touching production `~/.coder-loop`.
- Start: from repository root, `bun run gateway:start -- --loop-data-root "$ROOT" --hostname 127.0.0.1 --hostname 100.85.126.69 --port 3571 >"$EVIDENCE/gateway.stdout" 2>"$EVIDENCE/gateway.stderr" & GATEWAY_PID=$!`. This root-level command is the stable operator surface; internal package layout is not contractual.
- Readiness: require `kill -0 "$GATEWAY_PID"`, both exact listeners in `lsof -nP -iTCP:3571 -sTCP:LISTEN`, and `curl -fsS 'http://127.0.0.1:3571/api/status?target=%2Fabsolute%2Ffixture%2Fcwd&chain=gateway-e2e'` returning an exact parsed snapshot whose `state.kind` is `ok`.
- Behavior: execute C4, then C6-C8 against the production build. Snapshot reads must continue while daemon is down; after daemon start, the typed client must complete an engine-declared read RPC. Browser rows prove actual static asset, route, responsive render, and mesh reachability behavior; C5 separately proves the pre-existing full daemon/runner/GitHub loop remains green without a GUI dependency.
- Logs: preserve source SHA, Bun/dependency versions, exact start command, PID, listener output, status/RPC responses, before/after SQLite/WAL/schema evidence, browser URL/observations, network results, C1-C5 exits, and teardown under `/Users/mouriya/.coder-loop/loop-data/chains/v3-573/evidence/576/`. Do not stage these artifacts.
- Stop ownership: the shell that captured `GATEWAY_PID` sends `kill -INT "$GATEWAY_PID"`, waits for that PID, and proves both listeners are absent. C4 owns and removes only its isolated local root; C5 owns its daemon, fixture, and mutex teardown. Remote mesh checks write no assistant artifact and leave no process.

## Test delta

`required`

Add gateway-focused tests and the real `scripts/gateway-e2e.ts` driver for exact host selection, one-root immutability, static assets/traversal, typed status HTTP parsing, daemon-down read behavior, byte/metadata-stable SQLite reads, typed socket request/response handling, build/start/stop ownership, and responsive render data. Integrity rule: the root typecheck must include gateway code; preserve all existing collected tests and assertion strength; do not mock away SQLite open mode, TanStack production build, `Bun.serve`, socket transport, browser rendering, or network binding merely to obtain green output. Tests may move only when the replacement is a strict behavioral superset and the base/head inventory is reported.

## Dependencies

- #571 is closed `passed`; its evidence proves TanStack Start's Bun handler can be shared by multiple `Bun.serve` instances, static assets need the gateway-owned front layer, and loopback plus NetBird selective binding works: https://github.com/mouriya-s-lab/coder-loop/issues/571#issuecomment-4885479901
- #573 is closed by merged PR #671 and does not remove either current status prerequisite: https://github.com/mouriya-s-lab/coder-loop/pull/671
- #558 remains open with PR #675 open and unmerged. #574 explicitly depends on #558's persisted task-tree/status shape, so #576 implementation remains blocked: https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/pull/675
- #574 remains open with no closing PR. Current main still exposes all seven anonymous `"object"` slots, so the gateway cannot legally create the exact frontend boundary required by #576: https://github.com/mouriya-s-lab/coder-loop/issues/574
- A second hard blocker remains exactly as recorded at https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4949048303: current `buildCoderLoopStatusSnapshot` reaches the read-write/migrating `openSqliteStateStore`. No separate issue or PR for an engine-owned strict-read-only snapshot path was found during enrichment. Because #576 forbids engine changes, that prerequisite must receive and land its own issue/PR before this implementation starts; do not copy SQL or add a gateway-local workaround.
- #576 currently has no linked/closing PR and no sub-issues. The previous marker is superseded because its dependency gate was incorrectly encoded as an implementation Check; the underlying source/dependency facts remain current: https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4954886360
- Current local network fact at enrichment time: NetBird 0.74.2 reported `macmini.mouriya.lan` as `100.85.126.69/16` and `vctcn-runner.mouriya.lan` (`100.85.156.166`) connected; `en0` was `192.168.1.220`. #571 is the durable source for the two-device verification shape; address drift requires explicit contract refresh, never wildcard binding.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4954886360



### comment #4955084809 by `RiriAgent` — 2026-07-13T06:31:29Z

<!-- coder-loop:executable-contract schema=1 source-issue=576 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/576
- Observed body last-edited timestamp: `2026-07-02T12:02:50Z` (`lastEditedAt`; the issue-wide `updatedAt` observed during this resumed re-enrichment was `2026-07-13T06:11:24Z`).
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4866583993
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4885492862
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4949048303
- Verified hosting evidence used: https://github.com/mouriya-s-lab/coder-loop/issues/571#issuecomment-4885479901
- Architecture authority: https://github.com/mouriya-s-lab/coder-loop/issues/544
- Superseded contracts:
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4954886360
  - https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4954951173
- Re-enrichment evidence: iteration run `run-1783923119030-65-iteration-item-10`, recorded at `/Users/mouriya/.coder-loop/loop-data/chains/v3-573/shared.md:206-230`, verified marker `4954951173` as structurally current and semantically valid but then selected the conditional `contract_invalid` exit. The materialized preset proves the ordinary route is instead `iteration` `on = "completed"` → `review` (`preset.toml:141-143`); `contract_invalid` is a separate conditional exit only for a missing, malformed, stale, or contradictory marker (`preset.toml:145-151`). This revision makes that no-status planning-stage route literal so the valid contract is not recycled again.
- Current-source observation: fetched `origin/main@a3ff0e9ce64c5a55feed029dee3e07a5b7b3cb8d`. The inspected cross-task worktree is `issue-573` HEAD `9a3140ff1a841b82216f456f51b95d7a32e535dd`, not a byte-identical checkout of main; its only main-relative differences are in `src/observability.ts` and `src/observability.test.ts`. The #576-relevant `src/loop.ts`, `src/sqlite-state.ts`, `package.json`, and `bun.lock` match `origin/main` byte-for-byte. On those current source files, `StatusSnapshotBoundary` still has seven anonymous `"object"` slots (`src/loop.ts:504-512`), `buildCoderLoopStatusSnapshot` still reads through `openSqliteStateStore` (`src/loop.ts:2762-2825,3904-3936`), and that store still opens with `readwrite: true`, may set WAL, and always migrates (`src/sqlite-state.ts:500-527`). The earlier enrichment baseline `bun run typecheck` and `bun test` both exited 0; this factual correction changes no implementation check or dependency verdict.

## Deliverable

`implementation-pr`

One PR closes #576. It adds the same-repository TanStack Start gateway and stable root-level operator commands `gateway:start`, `gateway:build`, `gateway:typecheck`, and `gateway:test`; the internal package directory remains an implementation choice. The Bun gateway process serves static assets, server routes, and the minimal responsive status page, binds exactly loopback plus configured NetBird addresses, binds exactly one loop-data root at startup, imports the engine-owned typed socket/status contracts, and has no agent-credential or events-stream implementation. Events reading remains #577; lifecycle/control actions remain #578/#579; full first-screen behavior remains #578; PWA/mobile completion remains #584; engine changes are not part of this PR.

`implementation-pr` describes #576's eventual deliverable; it does not authorize work around missing external contracts. While the blockers in `Dependencies` remain, iteration must leave implementation/verification/submission unstarted, record the verified blockers in its handoff, and exit successfully without an item-status write so the preset's declared `completed` edge advances to review. Review then publishes the blocker verdict and selects its declared `blocked` exit. Iteration must not select its conditional `contract_invalid` exit because this marker is current and valid. `blocker-removal` is not the route for #576 because this issue does not deliver either missing engine contract.

## Checks

| ID | Dimension | Kind | Command / cwd / env or browser procedure | Expected exit/output or observation |
|---|---|---|---|---|
| `C1` | gateway focused behavior | `shell` | `bun run gateway:test` from repository root with the test-owned isolated loop-data roots and loopback-only test ports | Exit 0. Tests cover one-root binding, typed status-route success/rejection, daemon-down snapshot availability, typed socket request/response parsing, static-asset traversal rejection, exact host configuration, graceful multi-server shutdown, and responsive minimal-page rendering data. |
| `C2` | gateway type/build integrity | `shell` | `bun run gateway:typecheck && bun run gateway:build` from repository root with Bun 1.3.14 and frozen dependencies | Exit 0. TanStack Start produces client assets plus a Bun-loadable server handler; gateway and frontend compile from engine-derived exact types with no `any`, anonymous domain shape, internal `unknown`, or non-const `as` assertion. |
| `C3` | repository regression | `shell` | `bun run typecheck && bun test` from repository root | Exit 0 with no failed tests. The root typecheck includes the gateway package rather than leaving it outside the project graph; existing tests are not removed, skipped, renamed to evade collection, or weakened. |
| `C4` | real gateway data planes | `shell` | `bun scripts/gateway-e2e.ts` from repository root with Bun 1.3.14; the driver owns an isolated loop-data root, loopback port, real daemon lifecycle, gateway owner PID, and cleanup | Exit 0. The driver creates a real active chain through engine APIs, stops the daemon, starts the production gateway, reads that chain through the HTTP status route while the daemon remains down, proves the DB/schema/WAL files are byte/metadata unchanged by repeated reads, then starts the daemon and sends a typed read RPC through the gateway client. Boundary-invalid responses fail explicitly. The owner PID, socket, listener, and isolated root are cleaned. |
| `C5` | canonical engine E2E | `shell` | `bun scripts/real-e2e.ts` from repository root with configured `gh` and phase-selected runner CLIs | Exit 0; fixture PR is `MERGED`, fixture issue is `CLOSED`, isolated daemon/fixture/mutex teardown completes, and the harness does not start or require the GUI. |
| `C6` | local browser user path | `browser` | Start/readiness: run the Canonical runtime start command below against the C4 seeded root and wait for `curl -fsS 'http://127.0.0.1:3571/api/status?target=%2Fabsolute%2Ffixture%2Fcwd&chain=gateway-e2e'`; action: in a real browser at a mobile-width viewport open `http://127.0.0.1:3571/`; observation: inspect the rendered page and network response | The production page loads its built static assets from the same gateway PID, has no horizontal overflow at mobile width, and visibly renders the seeded chain identity plus snapshot state from an ArkType-parsed HTTP boundary. A shell-generated HTML substitute or screenshot of a fabricated page does not satisfy this row. |
| `C7` | mesh browser user path | `browser` | Start/readiness: same production gateway, with listeners on `127.0.0.1` and `100.85.126.69`; action: from a browser running on a distinct connected NetBird peer open `http://100.85.126.69:3571/`; observation: inspect the rendered page and its status request | The same minimal status page and seeded snapshot are usable from the mesh peer without application login, while the local page remains usable. The request reaches the NetBird listener, not a LAN/public listener or proxy. |
| `C8` | network confinement | `shell` | With the canonical gateway live on operator Mac, run `PORT=3571; lsof -nP -iTCP:$PORT -sTCP:LISTEN; ! curl -fsS --connect-timeout 3 http://192.168.1.220:$PORT/; ssh root@100.85.156.166 "curl -fsS --connect-timeout 5 http://100.85.126.69:$PORT/ >/dev/null"` from repository root; the remote command writes no temporary artifact | Exit 0. `lsof` shows only `127.0.0.1:3571` and `100.85.126.69:3571`, never `*:3571`, `0.0.0.0:3571`, `[::]:3571`, or `192.168.1.220:3571`; LAN access fails and the separate mesh peer succeeds. If current interface addresses differ, re-enrichment must update this literal row rather than silently widening the listener. |
| `C9` | diff and contract audit | `shell` | `git diff --check origin/main...HEAD && git diff --unified=0 origin/main...HEAD -- '*.ts' '*.tsx' '*.json'` from repository root | Exit 0. Review the complete added/modified output against every Pattern row below; no runtime artifact is staged, no engine file is changed, and no test/assertion integrity loss is hidden by the diff. |

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| `P1` | `whole-tree` | `StatusSnapshotBoundary|CoderLoopStatusSnapshot|buildCoderLoopStatusSnapshot` | Canonical engine definitions/exports and gateway imports/calls/tests | One exact engine-owned snapshot schema and builder. Gateway/frontend derive from it and parse at the HTTP boundary; no copied snapshot union, anonymous fallback object, hand-written SQL projection, or second builder remains. |
| `P2` | `whole-tree` | `openSqliteStateStore|new Database|PRAGMA|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE` within gateway production code | No gateway production site; engine-owned strict-read-only snapshot entrypoint is imported instead | Gateway cannot write, migrate, change journal mode, or issue SQL. Repeated gateway reads leave DB, WAL and schema state unchanged, including with daemon down. |
| `P3` | `whole-tree` | `DaemonCommandName|sendDaemonRequest|daemon\.|chain\.|item\.|logs\.|queue\.` within gateway production code | Engine command/auth definitions and a gateway generic typed client importing them; endpoint-specific uses may select an engine-declared member but may not declare a second vocabulary | Command names and request/response variants remain engine-derived closed types. No copied string union, registry, permissive command string, agent credential, or parallel wire parser remains. |
| `P4` | `whole-tree` | `loopDataRoot|loop-data-root|CODER_LOOP_GATEWAY_ROOT` within gateway production code | One startup configuration parser and immutable typed runtime context passed to server routes | Exactly one root is selected at process start. HTTP/browser/RPC requests cannot supply, override, enumerate, or escape to another root; there is no fallback to a request-relative or target-local root. |
| `P5` | `whole-tree` | `Bun\.serve|hostname|0\.0\.0\.0|\[::\]|::` within gateway production code | One gateway server-owner module plus focused tests | The server owner creates one `Bun.serve` per explicitly configured loopback/NetBird hostname over one shared TanStack handler. Wildcard, LAN-derived, public, silent fallback, and independently drifting handlers converge to zero. |
| `P6` | `whole-tree` | static-file path resolution and `dist/client` access within gateway production code | One canonical static-asset layer in the server owner plus focused tests | Built client assets are served by the same PID before TanStack route handling; traversal and non-file paths fail explicitly; no second static server/process exists. |
| `P7` | `changed` | added/modified TypeScript/TSX lines containing `\bany\b|\bunknown\b|\bas\b|"object"|Record<string` | `unknown` only at external catch/parse entry immediately consumed by an exact ArkType parser; `as const` only | No explicit/implicit `any`, true assertion, anonymous domain shape, unchecked map, or internal `unknown`. Socket, HTTP, environment/CLI, and gateway-to-frontend data enter through named exact parsers and flow as discriminated types. |

## Canonical runtime

- Setup: after every blocker in `Dependencies` has landed, create a clean #576 branch from current `origin/main`; run `bun install --frozen-lockfile`; use Bun 1.3.14 and configured `gh`. Current operator interfaces observed during enrichment were loopback `127.0.0.1`, NetBird `100.85.126.69`, LAN `192.168.1.220`, and connected remote peer `vctcn-runner.mouriya.lan` (`100.85.156.166`). `bun scripts/gateway-e2e.ts` creates the isolated root and seeded active chain without touching production `~/.coder-loop`.
- Start: from repository root, `bun run gateway:start -- --loop-data-root "$ROOT" --hostname 127.0.0.1 --hostname 100.85.126.69 --port 3571 >"$EVIDENCE/gateway.stdout" 2>"$EVIDENCE/gateway.stderr" & GATEWAY_PID=$!`. This root-level command is the stable operator surface; internal package layout is not contractual.
- Readiness: require `kill -0 "$GATEWAY_PID"`, both exact listeners in `lsof -nP -iTCP:3571 -sTCP:LISTEN`, and `curl -fsS 'http://127.0.0.1:3571/api/status?target=%2Fabsolute%2Ffixture%2Fcwd&chain=gateway-e2e'` returning an exact parsed snapshot whose `state.kind` is `ok`.
- Behavior: execute C4, then C6-C8 against the production build. Snapshot reads must continue while daemon is down; after daemon start, the typed client must complete an engine-declared read RPC. Browser rows prove actual static asset, route, responsive render, and mesh reachability behavior; C5 separately proves the pre-existing full daemon/runner/GitHub loop remains green without a GUI dependency.
- Logs: preserve source SHA, Bun/dependency versions, exact start command, PID, listener output, status/RPC responses, before/after SQLite/WAL/schema evidence, browser URL/observations, network results, C1-C5 exits, and teardown under `/Users/mouriya/.coder-loop/loop-data/chains/v3-573/evidence/576/`. Do not stage these artifacts.
- Stop ownership: the shell that captured `GATEWAY_PID` sends `kill -INT "$GATEWAY_PID"`, waits for that PID, and proves both listeners are absent. C4 owns and removes only its isolated local root; C5 owns its daemon, fixture, and mutex teardown. Remote mesh checks write no assistant artifact and leave no process.

## Test delta

`required`

Add gateway-focused tests and the real `scripts/gateway-e2e.ts` driver for exact host selection, one-root immutability, static assets/traversal, typed status HTTP parsing, daemon-down read behavior, byte/metadata-stable SQLite reads, typed socket request/response handling, build/start/stop ownership, and responsive render data. Integrity rule: the root typecheck must include gateway code; preserve all existing collected tests and assertion strength; do not mock away SQLite open mode, TanStack production build, `Bun.serve`, socket transport, browser rendering, or network binding merely to obtain green output. Tests may move only when the replacement is a strict behavioral superset and the base/head inventory is reported.

## Dependencies

- #571 is closed `passed`; its evidence proves TanStack Start's Bun handler can be shared by multiple `Bun.serve` instances, static assets need the gateway-owned front layer, and loopback plus NetBird selective binding works: https://github.com/mouriya-s-lab/coder-loop/issues/571#issuecomment-4885479901
- #573 is closed by merged PR #671 and does not remove either current status prerequisite: https://github.com/mouriya-s-lab/coder-loop/pull/671
- #558 remains open with PR #675 open and unmerged. #574 explicitly depends on #558's persisted task-tree/status shape, so #576 implementation remains blocked: https://github.com/mouriya-s-lab/coder-loop/issues/558 and https://github.com/mouriya-s-lab/coder-loop/pull/675
- #574 remains open with no closing PR. Current main still exposes all seven anonymous `"object"` slots, so the gateway cannot legally create the exact frontend boundary required by #576: https://github.com/mouriya-s-lab/coder-loop/issues/574
- A second hard blocker remains exactly as recorded at https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4949048303: current `buildCoderLoopStatusSnapshot` reaches the read-write/migrating `openSqliteStateStore`. No separate issue or PR for an engine-owned strict-read-only snapshot path was found during enrichment. Because #576 forbids engine changes, that prerequisite must receive and land its own issue/PR before this implementation starts; do not copy SQL or add a gateway-local workaround.
- #576 currently has no linked/closing PR and no sub-issues. Marker `4954886360` was superseded because its dependency gate was incorrectly encoded as an implementation Check. Marker `4954951173` is superseded here only to correct its whole-tree checkout identity claim and to make the preset-declared completed-to-review blocked route literal; its Checks, Pattern scope, canonical runtime, test delta, deliverable variant, and underlying dependency facts remain current.
- Current local network fact at enrichment time: NetBird 0.74.2 reported `macmini.mouriya.lan` as `100.85.126.69/16` and `vctcn-runner.mouriya.lan` (`100.85.156.166`) connected; `en0` was `192.168.1.220`. #571 is the durable source for the two-device verification shape; address drift requires explicit contract refresh, never wildcard binding.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/576#issuecomment-4954951173



### comment #5007300452 by `RiriAgent` — 2026-07-17T20:41:20Z

重新拆分后由 #720 承接，并硬依赖严格只读 snapshot #716。旧 issue 无关联 PR，关闭。


---

## Timeline (29)

- 2026-07-02T12:02:09Z `assigned` @RiriAgent
- 2026-07-02T12:02:44Z `cross-referenced` @RiriAgentsrc=571
- 2026-07-02T12:02:52Z `cross-referenced` @RiriAgentsrc=577
- 2026-07-02T12:02:54Z `cross-referenced` @RiriAgentsrc=578
- 2026-07-02T12:02:55Z `cross-referenced` @RiriAgentsrc=579
- 2026-07-02T12:02:56Z `cross-referenced` @RiriAgentsrc=580
- 2026-07-02T12:02:58Z `cross-referenced` @RiriAgentsrc=581
- 2026-07-02T12:02:59Z `cross-referenced` @RiriAgentsrc=582
- 2026-07-02T12:03:01Z `cross-referenced` @RiriAgentsrc=583
- 2026-07-02T12:03:02Z `cross-referenced` @RiriAgentsrc=584
- 2026-07-02T14:01:53Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:22Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T09:10:16Z `commented` @RiriAgent
- 2026-07-11T22:50:47Z `commented` @RiriAgent
- 2026-07-13T06:00:19Z `commented` @RiriAgent
- 2026-07-13T06:11:23Z `commented` @RiriAgent
- 2026-07-13T06:31:29Z `commented` @RiriAgent
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:42Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:36:44Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:36:46Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:36:48Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:36:51Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-17T20:36:53Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:37:00Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:41:20Z `commented` @RiriAgent
- 2026-07-17T20:41:21Z `closed` @RiriAgentcommit=None