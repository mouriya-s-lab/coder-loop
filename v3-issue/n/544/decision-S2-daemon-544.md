# RFC #544 R8 / S2：daemon 活性与 socket transport 决策档案

> 事实边界：仅压缩 `AGG-544-gui-observability-gateway.md` 的 D5/D7/D8、`detail-I04-544.md`、`detail-I05-544.md` 与 `detail-investigation-audit-544.md`。固定事实面为 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本文没有重读源码、运行实验或提出实现。S2 没有契约裁决；以下只把已确定偏离转成可比较的工程形态。

## A. 主 agent 摘要（≤一页）

### 问题来源与不能退回讨论的要求

D7 已固定首屏必须独立呈现三证：① pid 文件内容与该 pid 当前是否可 signal；② Unix socket 本次能否 connect；③一次完整、合法、成功且身份匹配的 `daemon.status` 应答。三证允许任意分裂，不能折成 `running`、`alive` 或一个 process row。D5 又固定网关使用从引擎闭集派生的 typed socket client；D8 的全部动作必须经单一 typed mutation client，失败明确呈现。R7 已判定 S2 **无契约裁决**：三证缺失、client调用可能永久不完成且不销毁socket、response身份未绑定都是已确定偏离，不得再询问“是否修”。

当前因果链是：pid file 根本未进入 status；connect 与 RPC 合在一个 promise；transport/parse/close 失败先压为 `missing` 后再被丢弃；成功 daemon snapshot 压成六字段 process row，又按 pid 与 `ps` 启发式 row 去重。与此同时，共享 `sendDaemonRequest` 没有 deadline、取消、`end` 收敛、response byte 上限或 `response.id === request.id` 校验，command 与 result 也没有类型关联。故 absent、陈尸、权限、非法响应和提前关闭可得到相同投影；静默/half-close peer 令整份 status 永不完成；错 id 或多行首条可冒充成功；32 MiB 响应被接受并产生显著内存放大。D7 的 probe、D8 的 mutation、全部 CLI read/mutation、daemon down/status 与 context 三段写共享这些后果。

### 已证约束与工程形态

任何成立形态都必须同时保留：三证的独立槽与原始分类；主动销毁底层 socket 的 client 有界完成；严格 request/response identity；command→result 精确 parse；connect/protocol/remote-reject/未完成等 typed failure；D8 失败的显式传播。response byte 上限可直接关闭已证内存放大风险，但不替代上述契约性质。

事实支持 **4 种完整放置形态**：

1. **共享 transport 原位收紧 + 引擎拥有三证 snapshot**：改造唯一 `sendDaemonRequest`，由 status builder 采集并输出三证。确定后果是现有全部高层调用共同得到同一有界/身份/错误语义，现有 generic 消费面一次性迁移。
2. **共享有界 framing core + command typed facades + 引擎拥有三证 snapshot**：socket 生命周期、上限、identity、failure ADT 在共享 core；read/mutation/probe 分别以精确 codec/facade 收窄。确定后果是所有调用共享资源边界，但各命令结果与动作错误可保持领域类型；会存在多个 facade，但不能出现第二套 framing/parser。
3. **共享有界 framing core + 网关拥有三证组合与 typed facades**：引擎只导出有界 transport/primitives 和类型，网关 server 组合 pid/process、connect、RPC 三槽，并承载 D5/D7/D8 typed client。确定后果是 GUI 合同可成立，既有 CLI 只有在切换到该 core 的范围内才获得新语义；若旧 `requestDaemonResult` 留在旧 transport，其挂起/错 id/宽结果仍然存在且必须在档案中明示，不能声称全局 transport 已收口。
4. **独立 connect 探针 + typed RPC transport，网关拥有组合**：connect-only 探针与真正 `daemon.status` 使用独立连接/阶段结果，pid/process为第三路；动作使用另一 typed RPC facade。确定后果是“connect 成功但 RPC timeout/EOF/invalid/error”天然保持两条证据，不依赖一个 promise 暴露中间状态；代价事实不是规模，而是每次完整探测至少两次 socket 生命周期，且两次观测不是同一瞬间，UI只能陈述各自探测时间。

形态 1–4 都须在 client transport 内选择具体 deadline/cancel机制并在到期时销毁 socket；response byte 上限是同层资源强化。server idle timeout、handler deadline/cancel和connection/concurrency cap属于防慢连接或恶意并发的风险强化，不是D5/D7/D8共同必需保证，也不能因缺少这些强化否定形态成立。没有需要操作员或能力 owner裁决的事项。

## B. 完整决策档案

### B1. 稳定语义：三证是什么、不是什么

| 槽 | 最低原始输入 | 能稳定陈述 | 不能据此陈述 |
|---|---|---|---|
| pid/process | pid pathname、raw text/read error、parse 结果、`kill(pid,0)` 的 success/ESRCH/EPERM 等分类、采样时间 | 文件写了什么；该数字在采样时是否可 signal/不存在/因权限未知 | 不能仅凭 kill0 证明进程就是当前 coder-loop；不能排除 PID 复用 |
| socket connect | pathname、connect success 或精确 errno、采样时间 | 该时点某 endpoint 是否接受连接 | 不能证明 endpoint 是 coder-loop，不能证明会完成 RPC |
| RPC response | deadline 内得到的完整 line、严格 envelope、相同 id、`daemon.status` 精确 result 或 failure 分类、采样时间 | endpoint 在该次请求上完成了身份匹配的应用层应答 | 不能回填 pid file 正确；不能保证下一时刻仍健康 |

固定分裂态包括但不限于：pid 可 signal/socket 失败；pid 可 signal/connect 成功/RPC timeout、EOF、invalid 或 remote error；pid absent/dead 而 connect+RPC 成功；三路都无正证但各自失败原因不同。`ps` command substring 只能继续作为宽松旁证；已有实验出现 harness 假阳性，因此它不能替代 pid/process 槽或参与“同 pid 去重后只留一条来源”。

### B2. 当前压缩链及确定的消费者后果

| 当前环节 | 已证机制 | 直接压缩/无界 | 高层影响 |
|---|---|---|---|
| `readDaemonPid` / pid lifecycle | status builder 不调用；malformed 与 absent 可同为 `null` | pid 原始证据消失 | D7 看不到陈尸、畸形、权限和 pid/socket 分裂 |
| `readCentralDaemonProcessInfo` | connect、write、response、parse 共用 `sendDaemonRequest` | thrown failure→`missing`，caller 丢弃；silent 不完成 | status/首屏可假死、无错误或永久挂起 |
| daemon projection | 完整 `daemon.status`→六字段 process row | scheduler、activeRuns、rateLimit、persistence failure 等丢失 | D7 首屏不能从该投影取得固定信息 |
| `ps` scan + pid 去重 | command substring；同 pid 不追加 socket row | 假阳性/漏检；成功 RPC 来源消失 | “活”可能是假阳性，三证一致性不可审计 |
| `sendDaemonRequest` receive | 无限 string 累积，首个 newline 即完成 | 无 response cap；首行优先 | 大响应放大内存；多余/错序行可冒充本请求 |
| response parser | 只要非空 string id；result 是宽 `JsonObject` | 不核对 request id；command/result 不关联 | 所有 read/mutation 可能错误归属且需各自手工 parse |
| client lifecycle | 首行、error、完整 close 才收敛 | 无 timer/abort/end；half-close/silent pending | D7、D8、logs、context、所有 CLI 命令均可卡住 |
| server lifecycle | 每连接串行、连接间并行、socket 到 close 才移除 | 无 idle/handler/connection 界限 | 单慢请求阻塞该连接；多连接可独立累积 |

`requestDaemonResult` 覆盖 logs、chain、item、context、daemon.status 与 queue.unblock；`sendDaemonRequestForDaemonCommand` 覆盖 daemon down/status；`readCentralDaemonProcessInfo` 覆盖 status probe。三者是当前全部生产直接消费者。对 mutation 而言，“本地 deadline/断线”只能证明客户端没有收到确定响应，不能证明动作未提交；该不确定结果必须区别于 daemon 明确拒绝，不能重包为普通“daemon down”。

### B3. 每个完整形态的实现触点与确定后果

#### F1. 共享 transport 原位收紧 + 引擎三证 snapshot

| 类别 | 触点 |
|---|---|
| transport | `src/daemon.ts:4652-4689` 的 `sendDaemonRequest`；`:4986-5003` response parser；request/response types `:289-297` |
| server bounds | `src/daemon.ts:1660-1722` 的 buffer、socket set、per-connection sequence；request cap `:410,1680-1685,4946-4975` |
| liveness | `src/loop.ts:3631-3715` 的 probe/process scan/kill0；最终 snapshot `:3113-3177`；pid lifecycle/read `src/daemon.ts:1245-1265,1649-1657,6031-6041` |
| callers | `src/loop.ts:2487-2504,2572-2601` 及 status probe |

确定后果：21 个 daemon commands 的现有高层入口一起经历 typed/result 或适配迁移；deadline/abort 会改变过去可永久 pending 的 observable behavior；strict id 会把此前 success 的错 id 变成 protocol failure；response cap 会把此前迟缓成功的大响应变成资源边界失败；三证成为 status 的命名 domain 数据而非 `processes.live[]` 推断。若 server 端也设 idle/handler/connection 界限，慢/静默连接可释放；若只改 client，gateway/CLI 有界但 daemon 仍可积累未受限 peer。

#### F2. 共享有界 framing core + typed facades + 引擎三证 snapshot

触点与 F1 相同，另在 daemon command registry（`src/daemon.ts:161-184,1732-1766,5731-5753`）建立 command→args→success/error 的单源映射；`requestDaemonResult`、daemon command wrapper 和 liveness probe分别消费 facade。

确定后果：framing、deadline/cancel、byte cap、id 与 failure ADT 只有一处；probe 可保留 connect 与 RPC 两阶段结果，read/mutation 可拥有不同领域 result/error，但命令词表仍从 `DaemonCommandName`/registry 派生。若 facade 自己重新读行或 parse envelope，就会形成 D5 P3 禁止的平行 wire parser，因此不属于此形态。

#### F3. 共享有界 framing core + 网关三证/typed facades

| 引擎侧 | 网关侧 |
|---|---|
| 导出 command 闭集、精确 codecs、有界 socket core、pid/socket 路径或命名探针 primitive | 启动期单 root context 下采集 pid/process；调用 connect/RPC primitive；为 HTTP 边界 parse；D8 动作只经 typed mutation client |

确定后果：D5/D7/D8 可不依赖现有 `processes.live[]`；daemon-down 时 SQLite status/events 仍独立可读。旧 CLI wrapper若不迁移，只得到原有行为，故测试与文档不能把“gateway transport 已有界”表述为“`sendDaemonRequest` 全消费者已有界”。若网关直接自行 `createConnection` 并复制 framing/registry，它违反 D5 的单源 typed client，不属于此形态。

#### F4. 独立 connect 探针 + typed RPC transport，网关组合

触点为 engine 导出的 connect-only primitive、有界 typed RPC primitive、pid/process primitive，以及 gateway liveness assembler；动作仍走 typed RPC，不复用 connect-only socket。

确定后果：connect success 可在 RPC timeout/EOF/invalid/error 时保持为正证；每槽可独立显示时间与 failure ADT。两次连接之间 endpoint 可能变化，因此不能声称同一原子时点，只能陈述“在各自采样时间”的分裂证据。把 connect-only success直接解释成 daemon health，或以第二次 RPC 失败覆盖第一次 connect success，会退回 I04 已证压缩，不属于此形态。

### B4. 所有形态共同的 transport 边界

| 边界 | 事实支持的实现族 | 无法由证据确定的参数 | 缺失时的确定后果 |
|---|---|---|---|
| 有界完成 | absolute deadline；或 connect/read 分阶段 deadline；两者均须在到期/abort时 destroy socket | 时长、不同 command 是否不同 | silent/half-close 继续令调用永久 pending；仅外层 `race` 会遗留底层资源 |
| response资源强化（可选） | 收chunk时按bytes计数，越界前停止累积；或bounded byte buffer后decode | 是否采用、上限数值、是否按command分级 | 不采用时32 MiB类响应仍可产生内存放大；不影响client完成deadline、identity与typed error是否成立 |
| response identity | 解析 envelope 后严格相等 request id；多行不得 first-line-wins 冒充 | id 生成格式 | 错 peer/错序/额外 response 可错误归属 |
| typed command/result | registry mapped type + codec；或各 command codec 由同一 registry 生成 | 具体导出 API shape | `JsonObject` 向每个 caller泄漏，边界错误位置不一致 |
| failure ADT | connect errno、deadline/abort、EOF/incomplete、invalid JSON/envelope、id mismatch、too large、remote rejection、indeterminate mutation | HTTP/UI 映射字面值 | D7 无法分证，D8 失败继续被压成字符串或“daemon down” |
| server 资源强化（可选） | idle connection timeout、handler deadline/cancel、connection/concurrency cap，可组合 | 是否采用、数值及公平策略 | 不采用时保留慢连接/handler集合累积风险；不影响client有界完成、三证或typed RPC合同是否成立 |

server 已有的1 MiB request cap、坏行结构化error后继续、同连接有序和连接间并行应保留；request cap不提供client deadline，也不消除大response风险。是否增加response cap或server idle/handler/connection界限由风险与实测决定。

### B5. 具体测试触点与必须新增的证明

| 现有资产/同错 | 可复用范围 | 仍须直接证明 |
|---|---|---|
| `tests/integration/daemon/connection.integration.ts:5-83` | 同连接顺序、跨连接并行、坏行后继续 | 必需：silent、half-close、deadline销毁、wrong id、多 response；若采用资源强化，再证明response cap或server idle/handler/connection界限 |
| 同文件 `:146-167` | socket pathname rebind | rebind期间三证分裂仍独立 |
| `tests/integration/cli/central-cli.integration.ts:934-1017` | daemon missing、活 pid/socket missing、真实 daemon status | stale/malformed/EACCES、EPERM/ESRCH、ps 假阳性、同 pid双来源、connect成功/RPC失败、完整三槽 projection |
| `chain-crud.integration.ts:389+` | request-too-large | request cap不能冒充 response cap |
| `central-cli.integration.ts:1396-1400`、`tests/unit/runtime/context-entry.test.ts:66-69` | 一种完整 close rejection | Bun half-close与 silent peer必须单测 |
| ordered helper / `expectOk(sendDaemonRequest)` | happy path | 每个 response id 与请求逐一绑定；typed command success/error exhaustive |

未来 gateway 还必须按 D5 C1/C4 与 D7 验收直接证明：typed socket parse；非法 response 显式失败；daemon-down snapshot仍可读；活态/死态/分裂态首屏；start/stop/restart后三证变化；D8 daemon死态动作明确报错。引擎单测不能替代浏览器/HTTP/mesh 的未来专项 E2E。

### B6. 未知、已确定偏离与工程分叉

**未知边界：** 跨用户 socket/`ps` 权限的具体 errno；PID 复用生产实况；恶意多连接的具体资源极限；生产 mutation“已提交但响应丢失”的频率；client deadline、byte cap及可选server cap的数值；两次独立探测间的实际漂移频率。这些未知不推翻三证独立、client bounded completion、identity与typing要求，也不能支持某个具体参数或把server强化升级为共同保证。

**已确定偏离：** pid证据缺席；connect/RPC阶段合并；failure与成功数据压缩；`ps`启发式假阳性；client无内部完成上界且超时不能主动销毁socket；response id未绑定；command/result不关联；failure未形成typed ADT。response无上限与server连接/handler无界是已证风险，不自动成为R9交付保证。

**工程分叉：** F1–F4 的所有权/放置；单transport原位收紧或core+facade；同一RPC连接暴露connect阶段或独立connect探针；absolute或分阶段deadline；codec/registry的具体类型组织；是否采用response cap及server资源强化。本文不推荐、不估规模、不拆 issue。

### B7. 不成立或超范围的形态

1. **单一 `running/alive`、只显示 pid file、只保留一个错误字符串：** 无法表达已证分裂态。
2. **只给 D7 caller 做 `Promise.race`：** 底层 socket未销毁，D8及其他高层仍无界，身份/大小/类型均未解决。
3. **只加 response cap、只核 id、只加 command parser中的任一项：** 分别留下其他独立根因。
4. **把所有 transport/protocol failure映射为 daemon down：** 权限、陈尸、connect、RPC、remote reject与未知提交重新被压缩。
5. **让 daemon 自报值取代 pid/connect槽：** RPC success不能证明 pid file正确，且无法表达 socket通/RPC死。
6. **网关复制 command字符串表或另写 framing/parser：** 违反 D5 typed client、P3 单源闭集。
7. **以 server 1 MiB request cap声称 transport有界：** 不约束 response、client等待、handler或连接集合。
8. **要求原子化三次活性观测：** 当前证据只要求独立如实与采样时间；跨 pid/process、connect、RPC 建立原子快照依赖更强且未被 D7 要求的系统假设。
9. **把未来 HTTP 状态码、UI 文案、deadline/上限数值升格为本簇契约裁决：** 证据未规定这些字面 shape；属于实现与未来消费映射。

### B8. 档案结论

- 完整工程形态：**4**
- 共同不可省略边界：**4**（三证独立另见B1；client有界完成、response identity、typed command/result、failure ADT）
- 操作员/能力 owner 契约裁决：**0**
- 事实续查：**0**（若要主张具体参数、跨用户行为、生产频率或原子采样，才需另行定向调查）
