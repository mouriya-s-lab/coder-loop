# #729 docs(v3): GUI 网关冻结 SHA 收尾验收

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:59Z  | updated: 2026-07-27T01:00:37Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/729
- comments: 0  | timeline events: 16

---

## Body

## 必须先读的关联 issue

继承 [#544](https://github.com/mouriya-s-lab/coder-loop/issues/544) 的共享契约与关闭验证。

## 目标

唯一 GUI 综合验收 owner；必须通过生产 HTTP status route 证明 daemon-down 重复读取不改变 DB/WAL/journal/schema。

GUI 网关落地后的文档与红线终态对齐：豁免边界成文、运维路径成文、row 10 三项审计以可复跑形态通过。

## 问题

结构性 children 各自交付代码与局部验证，但三类全局终态没有 owner：(a) row 10 的跨代码库红线审计是全局性质，不属任何单一功能 child；(b) B 裁决豁免只存在于 issue body，CLAUDE.md 禁令原文未更新则每个未来读者都会把网关判为违例（或反向：把豁免误读为普遍放开）；(c) 网关运维路径无文档，`daemon-restart-after-app-update` 的 GUI 履约路径无人知晓。

## 预期结果

性质表述：

1. **row 10 审计通过且可复跑**：三项检查（网关无 SQLite 写路径；引擎无 GUI 字面量/反向依赖——`src/` 不 import 网关代码、无网关概念字面量；#411 禁令措辞对非网关消费者力度不变）各有具体 grep/检查命令记录于 PR body，任何人可逐字重跑。
2. **豁免边界成文且枚举完整**：CLAUDE.md 禁令处更新为「禁令 + 网关唯一豁免及其条件（同仓同版本演进）」，并枚举网关实际存在的全部文件直读面——events JSONL 直读（B 裁决本体）、run 目录 prompt 快照产物（#717 为 GUI 消费而生的产物，#725 读取）、daemon.pid/daemon.sock 三证探针（#722，#544 架构节明文）；豁免不延伸到 SQLite 直写与其他 runtime 文件。替换式改写（no-legacy），不留新旧并存。
3. **运维成文**：网关启动/停止/访问在 CLAUDE.md Commands 节登记；`daemon-restart-after-app-update` 规则补 GUI 履约路径。
4. **文档无 drift**：文档所述命令逐条真实可跑；计数从代码派生或不写。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 网关零 SQLite 写 | PR body 记录的 grep 命令（写 API 调用面盘点） | 本机 | 零命中；命令可复跑 |
| function | 引擎无反向依赖 | `grep` `src/` 对网关目录的 import 与网关概念字面量 | 本机 | 零命中 |
| function | 禁令措辞终态 | 阅读 CLAUDE.md 两处禁令 + `grep` 全仓禁令相关表述 | 本机 | 豁免边界成文、仅网关一家、其余消费者力度不变、无叠层批注 |
| assumption | 文档命令真实 | 逐条执行文档新增的网关命令 | operator Mac | 全部按文档行为工作 |
| environment | 不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 伞 #544 的关闭终态条件（本 issue 复核对象）

以下是伞 #544 的关闭终态条件。本 issue 负责在冻结 SHA 上逐条复核并留证据；任一行不成立时回到拥有该契约的实现 issue 修复，不在本 issue 内写产品修复。

| # | 终态条件 | 验证 | Expect |
|---|---|---|---|
| 1 | 「跑没跑」一眼可见且判据可靠 | daemon 活/死两种状态下打开 GUI 首屏 | 活：呈现活 run 与最近事件；死：明确显示死了、死于何时、最后事件与三证细节；与断网可区分（网关仍应答） |
| 2 | daemon-down 可观测且可恢复 | 杀掉 daemon 后从浏览器/手机操作 | events 历史与队列终态照常可读；GUI 一键拉起 daemon 成功且状态翻绿 |
| 3 | 实时推送 | 起一轮真实 run（可用 real-e2e fixture chain），开着 GUI 观察 | 无手动刷新，agent.spawn → phase 推进 → agent.exit 全链路事件实时到达 |
| 4 | prompt 展示 | 打开任一已完成 attempt | 渲染全文 + 变量→值对照 + fresh/resume 标记；全文与实际 argv 所发一致 |
| 5 | 全链路层级展示 | 从 daemon 首屏钻取到 chain → item → run → phase/attempt | 各层可达；从任一事件可跳到其 run/item |
| 6 | 移动端可用 | 手机经 netbird mesh 打开 + PWA 安装 | 首屏与控制面动作在移动端可完成；PWA 可加主屏 |
| 7 | 控制面范围恰为 F 档 | 遍历 GUI 全部写入口 | 仅 daemon 生命周期 + unblock + chain stop/resume + item reorder + capability-gated per-epoch operator decision；无任何创建类入口 |
| 8 | mesh-only 暴露 | 从非 mesh 网络访问网关端口；mesh 内访问 | 前者不可达，后者可达；监听面仅 localhost + netbird 接口 |
| 9 | 元信息预览 | 在 GUI 选任一 preset 查看结构 | 状态机图/phase 任务树/变量类型流渲染自 #547 `preset compile --json` 编译产物（stateGraph 与 phases+任务树块），与 CLI 导出一致 |
| 10 | 引擎红线不破 | grep 引擎与网关代码 | 网关无 SQLite 写路径；引擎无 GUI 字面量/反向依赖；#411 禁令措辞对非网关消费者保持 |

## 架构切片

1. **系统定位**：收尾对齐件——文档域与代码终态的一致性审计；不产生运行行为。
2. **全局坐标**：代码实态域 → 文档域（CLAUDE.md / rules）；豁免边界成文是把 issue 裁决投影到文档域。
3. **类型↔值不漂移**：防值漂移——文档手写计数/命令与代码 drift；从代码派生或可复跑封死。
4. **消除的错误类别**：「未来读者把网关文件直读判为违例，或把豁免误读为普遍放开」不可表达（豁免面枚举成文）。

## log/观测义务

无运行期义务；审计命令记录于 PR body。

## 依赖关系

- Depends on: #716、#717、#718、#719、#720、#721、#722、#723、#724、#725、#726、#727、#728。
- Blocks: #544 closure。


---

## Comments (0)

---

## Timeline (16)

- 2026-07-17T20:37:00Z `assigned` @RiriAgent
- 2026-07-17T20:38:35Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:38:36Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-17T20:38:37Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:38:38Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-17T20:38:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:41Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-17T20:38:42Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-17T20:38:43Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-17T20:38:45Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-17T20:38:46Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-17T20:38:48Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-17T20:38:49Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:38:50Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-17T20:40:02Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:42Z `cross-referenced` @RiriAgentsrc=585