# RFC #544 R10 / D14 — 文档、运行手册与红线收尾原子需求

> 输入边界：只读 AGG D14、关闭验证十行、D5 运行手册契约、代码红线、伞级验收边界与 `expected-foundation-544.md`。本报告不读取源码、旧 issue 或实现，不替产品交付物修代码，不拆 implementation issue。

## A. 主 agent 摘要

D14 是冻结合流 SHA 上的**文档与综合证据 owner**，不是产品修复 owner。它逐条复核关闭验证十行、把实际命令/环境/观察结果写入正式证据；任一条件失败时退回拥有该契约的 D1–D13 交付物修复，D14 不在收尾 diff 中顺手实现功能。

运行手册必须给出可复制的 gateway 启动、就绪、访问与停止闭环：

- 启动：从仓库 root 执行真实 `gateway:start`，显式给出唯一 `--loop-data-root`、localhost hostname、netbird hostname 与 port，后台启动并捕获 gateway PID；
- 就绪：捕获 PID 存活，`lsof` 只显示配置的 localhost/netbird listeners，production HTTP status route 返回经 boundary parse 的成功 snapshot；
- 访问：本机与 mesh peer 使用实际 listener 地址；LAN/public/wildcard 不可达；
- 停止：向捕获的 gateway PID 发 `SIGINT`、`wait` 收尸并证明全部 listeners 消失。

daemon lifecycle 必须单独成文：dead-state start 是 gateway spawn `coder-loop daemon up`，不是 RPC；stop/restart 走既定 socket 机制；spawn daemon 与 gateway 生命周期解耦；restart 后 pid/process、socket connect、`daemon.status` 三证翻绿。运行手册不能把 gateway 写成通用 supervisor。

文档必须替换式写清 runtime 文件禁令：非 GUI 消费者继续禁止刮 runtime 文件；唯一 gateway 豁免只枚举 events JSONL、D2 run-directory prompt/bindings artifacts、daemon.pid/daemon.sock probes，且条件是同仓同版本演进。豁免不延伸到 SQLite 直写或其他 runtime 文件。gateway status 只能消费 engine strict-read API，production HTTP route 在 daemon-down 下重复读取必须证明 DB/schema/WAL/journal byte/metadata 中立。

全链路类型红线必须有可复跑审计：无 `any`/匿名 shape；`unknown` 只在 catch/外部 parse 边界并立即收窄；除 `as const` 外无真断言；status、RPC、events、artifact、compile、context、mutation 与 CAP-4 的类型均从 owner boundary 派生。引擎 `src/` 不 import gateway、不含 GUI 概念反向依赖；gateway 不复制 schema、command registry、framing/parser 或状态推断。

D14 记录每项验收的**精确命令、运行环境、冻结 SHA、输入 fixture/root、观察结果与证据位置**。不能只写“测试通过”，不能用 mock 替代 production SQLite mode、Bun server/socket、browser 或 network binding。

本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。跨 child 的 v3 新语义整链路证明归 #684；D14 只引用其冻结 SHA 证据并完成十行对账，不把 compatibility 或整链路 owner 迁入自身。

### A1. 结论计数

| 分类 | 数量 | 结论 |
|---|---:|---|
| D14 必须自建的原子保证 | 12 | 冻结 SHA 总账、十行核对、启动/就绪/访问/停止、single-root/listener、daemon lifecycle、runtime 豁免、SQLite 审计、类型单源、反向依赖、命令环境记录、回退归属 |
| 预期地基已供的保证 | 30 | F01–F30 均是 D14 只验证/引用、不重新定义的产品保证 |
| 真正地基未闭合 | 0 | 若冻结 SHA 未满足 F 保证，退回 owner 修复，不由 D14 补机制 |
| 非阻塞运行未知 | 15 | U01–U15 决定证据样本/环境，不生成新合同 |
| D14 禁止承接的验证 owner | 2 | #684 v3 integration、#685 compatibility real E2E |
| 明确排除的范围增长 | 10 | 与 R9 禁止升级清单一致 |

## B. 原子需求矩阵

### B1. D14 自建保证

| ID | 原子保证 | D14 必须产出的文档/证据 | 地基映射 | 可证伪条件 |
|---|---|---|---|---|
| **D14-R01** | 冻结 SHA 验收总账 | 标明唯一冻结合流 SHA、十行状态、证据链接/路径、执行者环境与失败回退 owner | F01–F30 | 证据来自不同未标明 SHA、只列结论无输入/环境，均不通过 |
| **D14-R02** | 关闭验证十行逐项核对 | 十行各有 command/path、fixture/root、环境、actual、expect 与判定；无遗漏、无合并成泛化 smoke | F01–F30 | 任一行没有实际观察或用另一行替代即失败 |
| **D14-R03** | gateway 启动手册 | 记录真实 root command、显式 loop-data root/hostnames/port、后台启动与 PID 捕获；命令逐字可跑 | F01–F09 | 文档命令不可执行、默认 wildcard 或未捕获 PID |
| **D14-R04** | readiness / access 手册 | readiness 同时要求 PID、精确 listeners、production HTTP status boundary success；本机/mesh 地址明确，LAN/public 不可达 | F01–F09 | 只做 health curl、只看 PID 或接受 wildcard listener |
| **D14-R05** | gateway 停止手册 | 对捕获 PID 发 `SIGINT`、`wait`，随后证明 PID 与全部 listeners 消失 | F07–F09 | 仅删 pidfile、未 wait 或遗留 listener |
| **D14-R06** | single-root / listener 证据 | 启动参数和观察证明一个实例只绑定一个 root；`lsof` 仅 localhost+netbird 字面地址，无 `*`/`0.0.0.0`/`::`/LAN | F01–F05 | request 可换 root、listener 静默 fallback 或 LAN 可达 |
| **D14-R07** | daemon lifecycle 手册 | start= gateway spawn `daemon up`；stop/restart=socket；spawn daemon 与 gateway 解耦；restart 后三证翻绿 | F06–F10 | 把 start 写成 RPC、gateway 退出带死 daemon 或只展示单 boolean |
| **D14-R08** | runtime scrape 禁令终态 | 替换式文档保留非 GUI 消费者禁令；唯一 gateway 豁免穷尽列出 events、attempt artifacts、pid/socket probes及同仓同版本条件 | F06、F11–F19 | 留新旧矛盾段、豁免扩到脚本/agent/supervisor/其他 runtime 文件 |
| **D14-R09** | SQLite strict-read 证据 | 审计 gateway 无 SQLite open/write/PRAGMA/DDL/migration；daemon-down 经 production HTTP status route 重读后 DB/schema/WAL/journal byte/metadata 中立 | F01–F05 | 只 grep 无运行证明、只测内部 builder、或 sidecar/metadata 改变 |
| **D14-R10** | typed single-source 红线审计 | 记录可复跑检查：无类型退化；外部输入立即 owner-boundary parse；无 gateway 平行 status/RPC/events/artifact/compile/context/mutation/CAP-4 shape | F04–F05、F07–F09、F11、F18、F20–F30 | 任一复制 schema/registry/parser、匿名 shape 或未 parse wire |
| **D14-R11** | engine/gateway 方向审计 | 具体检查证明 `src/` 不 import gateway、无 GUI 概念字面量/反向依赖；gateway 静态资产与 routes 同 PID | F01–F30 | engine 依赖 gateway 或 GUI 专属字面量进入 L1 |
| **D14-R12** | 证据归属与失败回退 | 每个失败指向 D1–D13 owner；#684/#685 证据只引用，不在 D14 重跑或替代；文档不写产品修复 | F01–F30 | D14 通过降低 expect、增加可选机制或现场修产品来“收口” |

### B2. 预期地基供给映射

| 地基区间 | D14 验证对象 | D14 只做什么 | 不得新增 |
|---|---|---|---|
| **F01–F05** | strict SQLite、snapshot、exact status wire | HTTP daemon-down 中立证明、single-source 审计 | gateway SQL、跨介质 snapshot |
| **F06–F10** | 三证、typed transport、daemon lifecycle | 运行手册与真实 lifecycle/browser 证据 | server caps、通用 supervisor、start RPC |
| **F11–F15** | events history/rotation/SSE/visibility | 终态行 1–3 证据与 runtime 豁免核对 | replay、schema framework、全局次序 |
| **F16–F21** | attempt artifacts、pinned definition、current compile、typed seam | 终态行 4/9 与豁免/类型审计 | historical D11、TTL/GC、CAP-3 shape |
| **F22–F24** | context typed read | 页面/route 证据引用 owner boundary | write recovery、CAP-6 shape 猜测 |
| **F25–F27** | exact F façade 与四 verb | 终态行 7、accepted/rejected/failed 核验 | 认证重构、全面封 store、durable operation |
| **F28–F30** | CAP-4 decision chain | capability-gated decision 与 status/event/audit 对账 | 第二授权/日志、exactly-once |

### B3. 运行手册最小记录

| 阶段 | 必须记录 | 最小判定 |
|---|---|---|
| start | 冻结 SHA、cwd、root command、`--loop-data-root`、两个 hostname、port、gateway PID、stdout/stderr 位置 | PID 为本次命令产生的 gateway |
| ready | `ps`/PID 证据、完整 `lsof` listener 输出、production HTTP status response 的 boundary 判定 | PID 活；仅 localhost+netbird；snapshot `ok` |
| local access | 本机 URL、浏览器环境、静态 asset 与 route 的同 PID 证据 | production page 与真实 snapshot 可用 |
| mesh access | peer/环境标识、netbird URL、listener 命中、页面/控制面证据 | mesh peer 可达 |
| negative network | LAN address 与 wildcard 检查 | LAN/public 不可达，未监听 wildcard |
| daemon lifecycle | dead-state、start spawn、stop/restart、三证前后值、gateway/daemon PID 解耦 | restart 后三证绿；互不附生 |
| stop | signal、`wait` 结果、停止后 PID/`lsof` | gateway 与所有 listeners 消失 |

具体地址、PID、端口和路径必须来自当次环境，不能在文档中伪造固定值。

### B4. runtime 文件边界

| 消费者/路径 | 允许 | 条件 | 禁止 |
|---|---|---|---|
| gateway / events JSONL | 是 | 同仓同版本；按 F11–F15 contract | 推广给 agent/supervisor/脚本 |
| gateway / D2 attempt artifacts | 是 | 经独立 typed artifact route；D10 逐字消费 | 读取其他 run files 后推断状态 |
| gateway / daemon.pid + daemon.sock | 是 | 仅 D7 三证 probe/lifecycle | 折叠为单 boolean 或作为通用 process manager |
| gateway / SQLite | 仅 engine strict-read API | F01–F05；HTTP 重读中立 | 直接 open、SQL、PRAGMA、DDL、migration、write |
| 非 GUI consumer / runtime files | 否 | 原禁令力度保持 | 以 gateway 豁免为先例扩大 |

### B5. 类型与依赖红线

| 红线 | 可复跑审计必须证明 |
|---|---|
| ADT 全链路 | 有限状态/结果穷尽；无 flag soup、catch-all success |
| 无类型退化 | 无 `any`、匿名 shape；`unknown` 只在 catch/parse 边界并立即收窄；除 `as const` 外无真断言 |
| owner boundary | status/RPC/events/artifact/compile/context/mutation/CAP-4 均从 owner schema 派生 |
| no parallel facts | GUI 不推断 closure、daemon、decision 或 compile；不复制 builder/parser/registry |
| dependency direction | engine L1 不 import gateway，不含 GUI 字面量或反向依赖 |
| SQLite ownership | gateway 不直接打开或修改 SQLite |

D14 必须在正式 evidence 中记录仓库实际适用的逐字命令及完整输出位置；本需求不根据尚未读取的实现猜 grep pattern。

### B6. 关闭验证十行与 owner

| 行 | D14 核对证据 | 产品 owner |
|---:|---|---|
| 1 | daemon 活/死首屏、最后事件、三证、断网区分 | D7 + status/events |
| 2 | daemon-down 历史/队列与 lifecycle 恢复 | D6/D7 |
| 3 | 真实 run 的 live events | D6 |
| 4 | attempt prompt/bindings 与 argv 同源 | D2/D10 |
| 5 | daemon→attempt 钻取与 event 双向跳转 | D9 |
| 6 | mesh 手机 + PWA + 控制面 | D13 |
| 7 | exact F 写入口，无创建类 | D8 |
| 8 | localhost+netbird only | D5 |
| 9 | current compile 三视图与 CLI 一致 | D11 |
| 10 | SQLite、依赖方向、runtime scrape 禁令 | D14 审计；失败回对应底层 owner |

### B7. 验收命令与环境归属

| 验证层 | D14 是否执行/记录 | 约束 |
|---|---|---|
| 文档新增命令 | 执行并记录 | operator Mac；逐字命令必须真实可跑 |
| `gateway:typecheck` / `gateway:build` / `gateway:test` | 执行并记录 | 不得 mock 掉 production boundary |
| `bun run typecheck && bun test` | 执行并记录 | 仓级回归 |
| gateway production HTTP/browser/network/lifecycle 专项路径 | 按关闭十行执行或引用专用 owner 在同一冻结 SHA 的完整证据 | 环境、root、port、PID、URL、输出必须可追 |
| #684 v3 integration | 只引用专用验收证据 | 不由 D14 改写或替代 |
| `bun scripts/real-e2e.ts` compatibility | **不执行** | 只由 #685 在冻结发布候选 SHA 执行 |

本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

### B8. 非阻塞运行未知

U01–U15 全部只用于选择实际 fixture、环境与观察项。D14 必须把适用未知转成证据输入或明确引用 owner 的已完成证据；不得因未知而削弱 F01–F30，也不得把风险强化写进运行手册成为新合同。

### B9. 明确排除

1. 不建立跨 SQLite/events/process 的同一时点或共同事务。
2. 不加入 response/server caps、server idle/handler deadline或connection cap。
3. 不把 daemon start 改成 RPC，不引入通用 supervisor。
4. 不加入 events schema framework、crash journal、replay、`Last-Event-ID`或restart cursor。
5. 不把 fallback 文件宣称为统一全序历史。
6. 不增加 historical/current 双 compile 视图。
7. 不猜 CAP-3/CAP-6 shape、TTL、cursor或 error 字面量。
8. 不增加 context write recovery、operator认证重构或全面封 store。
9. 不增加 durable operation、outbox/saga/log、known-outcome或exactly-once。
10. 不以其他 mutation 替代 CAP-4 decision，不建第二日志/授权系统。

