# #721 feat(gui): events 增量读取与实时推送

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:41Z  | updated: 2026-07-27T01:00:27Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/721
- comments: 0  | timeline events: 8

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

消费已落地 events contract，经 gateway 推送。

网关按 #573 契约直读 events JSONL（active 段 fs.watch + offset 增量、历史段全序读取），经 WS/SSE 推给前端；事件历史可查询。

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

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 翻段一致性 | `bun test`（网关 reader 用例：跨 rotation 读取断言无丢无重，复用 #573 测试基建） | 本机 | 断言通过 |
| function | daemon-down 存活 | 杀 daemon 后查询事件历史 + 保持已开 GUI 页面 | operator Mac | 历史照常返回；页面不崩、显示最后事件 |
| function | 过滤查询 | 对含多 chain/item 的 root 按关联键查询 | 本机 | 结果与 JSONL 实际内容一致 |
| assumption | 长历史性能实测（决策项） | 对真实事件量跑查询延迟测量，结论落本 thread | operator Mac（生产 root 副本） | thread 有实测数据 + 裁决记录 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: #573、#720。
- Blocks: #722、#724、#729。


---

## Comments (0)

---

## Timeline (8)

- 2026-07-17T20:36:42Z `assigned` @RiriAgent
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:42Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:38:45Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:38:51Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-17T20:39:52Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:23Z `cross-referenced` @RiriAgentsrc=577
- 2026-07-26T23:49:19Z `cross-referenced` @RiriAgentsrc=719