# #577 feat(gui): events 直读与实时推送——fs.watch 增量读 + WS/SSE 到前端

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:10Z  | updated: 2026-07-17T20:41:23Z
- closed: 2026-07-17T20:41:23Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/577
- comments: 3  | timeline events: 22

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "推送通道｜**网关直读 events JSONL**（`fs.watch` + offset 增量），否决 socket 订阅 verb｜daemon 死时通道依然活；零引擎改动。**豁免声明**：#411「消费者从此不刮 runtime 文件」禁令对网关一家豁免（同仓同版本演进的特许消费者），对 supervisor/agent/脚本等其他消费者禁令不变" — #544 裁决记录 B

> "**推送**：网关把 events 增量经 WS/SSE 推给前端；前端快照类数据走 server routes 查询 + 事件驱动失效。" — #544 架构

> "实时推送｜起一轮真实 run（可用 real-e2e fixture chain），开着 GUI 观察｜无手动刷新，agent.spawn → phase 推进 → agent.exit 全链路事件实时到达" — #544 关闭验证行 3

## 目标

网关按 #573 契约直读 events JSONL（active 段 fs.watch + offset 增量、历史段全序读取），经 WS/SSE 推给前端；事件历史可查询。

## 使用场景

- GUI 打开期间事件实时到达，无手动刷新（关闭验证行 3）。
- daemon 死后事件历史与死前最后事件照常可读（#578 daemon-down 呈现的数据源）。
- #580 的事件↔run/item 关联跳转以本 child 的事件查询面为数据源。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（实施前自行 grep 行号）。

- 消费契约：#573 导出的信封 schema、事件 union、段发现/全序/翻段一致性 API——本 child 是其唯一预期消费者，零字面量拷贝。
- 信封关联键 `chain?`/`item?`/`runId?`/`phase?`（`src/observability.ts:234-241`）——查询过滤维度即这组键。
- 推送机制（SSE vs WS）依 #571 spike 证据实现自选；钉死的是性质（无手动刷新实时到达），不是通道种类。
- 现状反例：`logs --follow` 1s 轮询全量重查（`src/loop.ts:1836-1844`）——"每秒重读全部 events 段文件，事件量增长后线性退化"（#544 现状问题 1）；本 child 不复制该形态。

## 问题

> "无长连接、无订阅推送……`coder-loop logs --follow` 是 CLI 侧 1s 轮询全量重查再 slice……GUI 没有现成网络协议可用。" — #544 现状问题 1

## 预期结果

性质表述：

1. **增量而非重扫**：稳态推送路径对每个新事件的成本与历史总量无关（offset 增量读 active 段；翻段按 #573 契约无丢不重）。
2. **daemon-down 通道存活**：daemon 进程死亡不影响事件历史读取与已建立的推送连接的存活（新事件自然停止，通道与历史查询照常）。
3. **过滤查询**：历史查询支持按信封关联键（chain/item/runId/phase）与时间范围过滤。
4. **类型不塌**：事件从文件到前端全程精确类型（#573 契约 parse → 推送 → 前端边界 parse），无 `any` 透传。

### 显式决策项（RFC 开放问题分配，落地时裁，裁决留本 thread）

- "events 长历史的查询性能：JSONL 顺扫在多大历史量下不够、网关侧要不要加索引/缓存层——实现期以真实事件量实测后定，不预设索引层。" — #544 开放问题（唯一一条，分配给本 child）。裁决义务：以真实 loop-data root 的事件量实测查询延迟，把「顺扫够用到什么量级、超过后的方案方向」写进本 thread。

## 不应残留

- 本 child 范围内：轮询全量重扫形态；段名正则/命名模板字面量拷贝（必须 import #573 导出）；未过边界 parse 的事件透传进前端。
- 范围之外不动：引擎 events 写入与滚动机制（#573 已钉，本 child 零引擎改动）；`logs --follow` CLI 行为；快照类数据面（归 #576/#580）。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。前端同样适用（边界 parse 进精确类型）。"
- "#411 的「消费者不刮 runtime 文件」禁令对网关之外的一切消费者继续有效；events 直读豁免仅限同仓网关。"（#544 约束节逐字）

## 本 issue 的验证边界

- **验证层级**：真实 daemon/gateway + 浏览器用户路径；本 issue 只覆盖正文列出的页面、流或控制动作。
- **本 issue 必须证明**：从公开 socket/status/events boundary 得到真实数据，在浏览器中完成对应观察或 mutation，并核对 daemon/事件审计副作用；仅组件测试、截图静态页面或 GitHub PR closure 不算通过。
- **不在本 issue 内执行**：不运行 bundled preset compatibility real E2E。跨 GUI 页面与其他 v3 子系统的完整操作员场景归 #684；现有 GitHub preset 兼容性归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 翻段一致性 | `bun test`（网关 reader 用例：跨 rotation 读取断言无丢无重，复用 #573 测试基建） | 本机 | 断言通过 |
| function | daemon-down 存活 | 杀 daemon 后查询事件历史 + 保持已开 GUI 页面 | operator Mac | 历史照常返回；页面不崩、显示最后事件 |
| function | 过滤查询 | 对含多 chain/item 的 root 按关联键查询 | 本机 | 结果与 JSONL 实际内容一致 |
| assumption | 长历史性能实测（决策项） | 对真实事件量跑查询延迟测量，结论落本 thread | operator Mac（生产 root 副本） | thread 有实测数据 + 裁决记录 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #571（推送机制证据）、#573（消费契约）、#576（网关宿主）。
- Blocks: #578（首屏最近事件/死因线索）、#580（事件关联跳转）。


---

## Comments (3)

### comment #4866584195 by `RiriAgent` — 2026-07-02T14:02:23Z

## 架构切片

1. **系统定位**：三数据面中第三面（events 直读）+ 推送级——网关内「文件 → 契约 parse → 推送 → 前端」流水线。
2. **全局坐标**：引擎 events 文件域 → 网关（#573 契约 parse 点）→ 前端（边界 parse）；B 裁决豁免边界即此面。
3. **类型↔值不漂移**：防类型泄露——段名/信封 shape 零拷贝（import #573 导出）；防值漂移——翻段丢/重 = 消费值偏离写入值，契约测试封死。
4. **消除的错误类别**：「事件量增长后观测线性退化」（`logs --follow` 形态）在推送路径不可表达（增量成本与历史总量无关）。

## log/观测义务

长历史性能实测结论落本 thread（显式决策项义务）；无引擎事件义务。


### comment #4885492919 by `RiriAgent` — 2026-07-05T09:10:17Z

## #571 spike 结论：SSE 推送通道 assumption 已验证

Spike #571（TanStack Start (Bun) 网关宿主可行性）已 passed，evidence comment https://github.com/mouriya-s-lab/coder-loop/issues/571#issuecomment-4885479901。本 child body「推送机制（SSE vs WS）依 #571 spike 证据实现自选」现落定：**采用 SSE**。

## SSE 实测证据（#571 spike，从远端 mesh peer curl 到本机 netbird IP）

- 连接持续 **65s 无中断**（超本 child「实时到达」性质门槛；`elapsed=65s`）
- 每秒 1 条，共 **65 条事件（`n=0..64`）无丢无断**
- 客户端断开后**服务器进程存活**（前提是 handler 用 `request.signal` 干净跟随断开——见下节硬门）

## 本 child 落地硬门：SSE handler 必须绑 `request.signal.addEventListener('abort', ...)`

**这是硬门，非建议**——#571 spike 首次实现未接 `request.signal`，客户端断开后：`controller.close()` 已跑 → 下一次 `setInterval` `push` → `controller.enqueue` 抛 `TypeError: Invalid state: Controller is already closed` → uncaught 异常 → **Bun 进程整个退出**。日志证据（#571 spike 期实测）：

```
TypeError: Invalid state: Controller is already closed
      at push (/.../dist/server/assets/router-Dc0KoRjR.js:268:16)
Bun v1.3.14 (macOS arm64)
```

**含义**：如果本 child 的 SSE handler 不接 `request.signal`，**单个恶意或意外断开的 GUI 客户端可打死 daemon 侧网关进程**——与 #544 G 裁决的「一个进程承载全部」的可靠性前提直接冲突。

### 标准写法（本 child 落地照抄）

```ts
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/events')({
  server: { handlers: {
    GET: async ({ request }) => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          let closed = false
          const close = () => {
            if (closed) return
            closed = true
            // 清理所有旁路资源：fs.watch handle、setInterval、订阅等
            try { controller.close() } catch {}
          }
          const push = (chunk: unknown) => {
            if (closed) return
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            } catch { close() }
          }
          // 本 child 真实数据源：#573 契约驱动的 fs.watch active 段 + offset 增量
          // ...
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

关键点：`closed` 单 latch 保护 `push`；`push` 加 try/catch 兜后手一次（race window）；`request.signal.abort` 回收所有旁路资源（本 child 里包括 fs.watch handle、offset 状态、订阅句柄）。

### 验收补一行

建议本 child「验收标准」表补一行 `assumption` 维度：

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| assumption | SSE 断开不打死 daemon 网关进程 | GUI 建立 SSE 连接后强断（`kill -9 curl`），随后本机 `curl http://127.0.0.1:PORT/api/health` | local | 网关进程存活，新 API 立刻响应，`request.signal.abort` 事件已回收全部旁路资源 |

## 通道决策

- **SSE 定案**：#571 已实测，长连接 + 断开语义 + 增量推送全部满足本 child「性质」要求
- WS 未在 spike 内测试，若本 child 落地实测发现 SSE 有独有短板（如二进制帧需求、双向控制），可回本 thread 追加设计修正 comment



### comment #5007300691 by `RiriAgent` — 2026-07-17T20:41:22Z

重新拆分后由 #721 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (22)

- 2026-07-02T12:02:11Z `assigned` @RiriAgent
- 2026-07-02T12:02:44Z `cross-referenced` @RiriAgentsrc=571
- 2026-07-02T12:02:47Z `cross-referenced` @RiriAgentsrc=573
- 2026-07-02T12:02:50Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:54Z `cross-referenced` @RiriAgentsrc=578
- 2026-07-02T12:02:56Z `cross-referenced` @RiriAgentsrc=580
- 2026-07-02T14:01:54Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:23Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-05T09:10:17Z `commented` @RiriAgent
- 2026-07-11T23:30:14Z `cross-referenced` @RiriAgentsrc=654
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:36Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:36:42Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:36:44Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:36:46Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:36:48Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:37:00Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:41:22Z `commented` @RiriAgent
- 2026-07-17T20:41:24Z `closed` @RiriAgentcommit=None