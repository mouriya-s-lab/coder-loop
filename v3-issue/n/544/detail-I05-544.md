# RFC #544 R7 / I05：socket transport 有界失败与响应身份

> 固定事实面：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点：AGG D5（typed socket client）、D7/D8（RPC 消费边界）；上游观察：R5 L08/L33、R6 I05。本文只调查现状与因果，不提出修法。

## A. 主 agent 摘要（最多一页）

### 结论与置信

**高置信：现有共享 transport 不能供给 D5/D7/D8 所需的“有界、typed、响应身份可靠”边界。** `sendDaemonRequest` 是生产代码唯一 RPC client；status、全部 CLI read/mutation、daemon down/status 及 context 三段写均经它。它以一连接一请求写一行，收到第一条换行行就完成，但没有 deadline、取消、response byte 上限或 response `id === request.id` 校验。32 MiB success response 实测被接受，约 4.95 s、RSS 增量约 1.26 GiB；错 id 与多行首条均被当作本请求成功。接受连接后静默不答和“peer 发 partial 后只 half-close”均在外部 1–2 s 界限内不完成，必须杀 client 实验进程。

server 是每连接多请求的换行 JSON framing：partial chunk 正常拼接，同连接按序、不同连接并行；1 MiB **request** 上限、坏行结构化 error、继续处理下一行是可保留资产。但 server 无连接/请求 deadline、并发连接上限或 pending handler 取消；未换行输入只在超过 1 MiB 时拒绝，未完成而 EOF 则无 response。request 上限不提供 response 上限，也不令 client 有界。

### 因果、影响与分类

- **身份根因：** wire 有 request/response `id`，server happy/error 路径会回显已解析 id，但 client parser只验证“非空 string”，不与发送 id 相等。错 peer、错序/多余 response 能冒充成功；这不是仅缺测试。
- **有界性根因：** client生命周期只在首个完整行、`error` 或 `close` 收敛；没有 timer/abort/`end` handler。静默 peer 永久 pending；Bun 实测 peer `end(partial)`产生的半关闭也未进入现有 `close` rejection。所有高层调用会继承挂起，包括 D7 probe 与 D8 mutation；mutation 超时后是否已经生效也无 transport 结果可区分。
- **资源根因：** client先无限累积 string，再找换行，再 `JSON.parse`；response无字节上限。server把每个 socket保存在集合到 close，并为每连接建立 promise序列；慢 handler阻塞该连接后续请求但不阻塞其他连接，故大量慢/静默连接可独立积累。
- **类型/错误根因：** `DaemonResponse` 仅把 `result/error.details` 收为宽 `JsonObject`；parser忽略多余字段、success缺 `result` 默认为 `{}`。malformed JSON/错误 envelope虽拒绝为 `DaemonError(invalid_json|invalid_request)`，但消息仍写“request”；connect失败则透传 Node errno；提前完整 close才是 `incomplete_response`；高层通常再压成 CLI字符串或 status `missing`。不存在导出的 transport failure ADT，也不存在 command→result 类型关联。

这些是**当前供给缺陷**。未来 gateway 的 HTTP 映射、UI错误展示/取消以及 mutation专属 client仍是消费端责任，不能反记为当前代码缺陷；当前尚不存在 gateway，故其专项 E2E 是纯证明缺口。现有 ordered/malformed/request-too-large/partial-close测试是资产，但错 id、静默/half-close、response上限、错误分类与所有高层传播没有覆盖；partial-close 绿测只覆盖会触发 `close` 的一种 peer 行为，未覆盖本次实测 half-close。

### 根因集合与交接

根因集合为 **R1 无 deadline/cancel/end 收敛；R2 response无限缓冲；R3 response身份未绑定；R4 envelope宽且 command/result不关联；R5 transport错误未经统一分类；R6 server连接/handler无界**。只给 D7 外包 timeout会留下 D8、资源、身份和类型问题；只核 id会留下永久挂起与内存放大；只加 response parse schema会留下 wrong-id 与 mutation未知结果。禁选项、推荐形态、成本与拆 issue 留给 R8 决策，不在本报告越权。

## B. 证据附录

### B1. transport、parser 与连接生命周期

| 面 | 实现位置 | 实际机制 | 收敛/边界 |
|---|---|---|---|
| client connect/write | `src/daemon.ts:4652-4665` | `createConnection`；connect 后 stringify request + `\n` | 无 connect/request deadline，无 abort signal |
| client receive | `:4666-4679` | string累积；遇第一换行只取第一行；parse后 destroy | 无 response大小上限；同 chunk后续行丢弃 |
| client failure | `:4680-4688` | `error`透传；`close`且未settled → `incomplete_response` | 不监听 `end`；静默/半开可不收敛 |
| response parser | `:4986-5003` | `id:string`,`ok:boolean`；result/error为对象 | 不对请求 id；success无result→`{}`；额外字段忽略 |
| server framing | `:1660-1686` | 每socket string buffer；逐换行拆行；空行略过 | residual未换行 buffer >1 MiB 才立即拒绝 |
| server execution | `:1673-1677,1695-1722` | 同连接 Promise chain串行；不同连接独立 | handler无deadline；慢首请求阻塞同连接后续 |
| server lifecycle | `:1661,1687-1692` | socket集合在close/error删除 | 无连接上限/idle timeout；EOF残行不处理 |
| request parser | `:4978-4983,5005-5013` | JSON object + nonempty id/command + object args | bad request结构化 error；未知id在parse前为`unknown` |
| request大小 | `:410,1680-1685,4946-4975` | 1,048,576 UTF-8 bytes；oversize响应后end | 只约束request，不约束response |

历史来源：基础 server/client/framing 由 `0c5f92e8`（2026-05-23）引入；client cleanup由 `6a0332b0`补；request上限由 `a2069633`补；同连接串行由 `b87d7a4d`补；`close → incomplete_response`由 `d381d06c`（context entry）补。后续补丁逐项增强，但没有形成统一 deadline/identity/resource/error contract。

### B2. 受控 client→假 peer 实验矩阵

实验均在本机 Bun、独立 `/tmp/coder-loop-544-I05-<pid>.sock`，调用生产 `sendDaemonRequest`；pending case由外部进程边界杀死，未触生产 root。

| peer行为 | 观察 | 当前分类/后果 |
|---|---|---|
| pathname不存在 | 立即 reject，Node `ENOENT` | raw平台error；高层另行字符串化 |
| accept后静默 | 1,000 ms仍pending，外部kill | 无内部上界 |
| partial JSON 后 `end()` | 2,000 ms进程仍pending，外部kill | half-close未被现有`close`分支收敛 |
| partial分两chunk，最后换行 | 37 ms成功 | partial framing资产成立 |
| malformed `not-json\n` | reject `DaemonError invalid_json` | 有code，但message称 invalid JSON request |
| success的`result:7` | reject `invalid_request` | envelope shape拒绝 |
| error的`code:7` | reject `invalid_request` | error envelope shape拒绝 |
| response id=`other` | 2 ms成功并返回`other` | 请求身份不可靠 |
| 两条完整response | 首条2 ms成功，第二条被销毁丢弃 | first-line-wins，不按id选择 |
| 32 MiB success result | 成功；payload 33,554,480 B；4,949 ms；RSS +1,263,271,936 B | 无response上限，string+parse显著放大 |

RSS是单次受控观测，受Bun allocator影响，不外推固定倍率；它足以证伪“响应有界”。32 MiB case初始2 s观察仍运行，延长到10 s后完成，故分类是迟缓成功而非永久挂起。

### B3. 假 client→真实 server framing 矩阵

| 输入 | 真实server观察 | 机制 |
|---|---|---|
| partial无换行后client end | 300 ms无response，连接已关闭 | residual buffer在EOF被丢弃；无完成line |
| `bad\n` + 合法status行 | 先`id:unknown/invalid_json`，再合法status success；连接保持 | request序列捕获每行error且继续 |
| 1,048,577字节无换行 | `request_too_large`，details含limit/actual，server关闭连接 | residual buffer即时上限资产 |
| 同连接slow后next | 既有 integration 证明 next等待slow且响应顺序一致 | `requestSequence`串行 |
| 独立连接遇slow | 既有 integration 证明另一连接可先完成 | 连接间并行；也意味着慢连接可累积 |

### B4. 全部生产高层消费者

生产代码只有三处直接 `sendDaemonRequest` 调用：

1. `requestDaemonResult`（`src/loop.ts:2487-2504`）承载 `logs.query`、chain create/list/status/stop/resume/updateBindings/delete、item add/batchAdd/list/reorder/exits/exitAction/update、context append begin/chunk/commit、daemon.status、queue.unblock；transport reject转 `daemonConnectionFailure` 后CLI `fail`，daemon `ok:false`压为 `code: message`。
2. `sendDaemonRequestForDaemonCommand`（`:2572-2601`）承载 daemon down/status 命令；JSON模式把连接失败重包为CLI error envelope，文本模式fail。
3. `readCentralDaemonProcessInfo`（`:3648-3659`）承载 status中的daemon probe；所有transport reject都变`kind:"missing"`，caller又不展示missing；合法RPC error才是invalid。

`DaemonCommandName`/server registry共21项（`src/daemon.ts:161-184,1732-1766,5731-5753`），全部共享同一 generic transport；没有 read/mutation 或 D7 probe 专属 deadline/error/result契约。context虽把大body切256 KiB（`src/loop.ts:1977-1985`），只约束request使用方式，不限制response或等待。

### B5. error/envelope 传播矩阵

| 原始故障 | `sendDaemonRequest` | 普通CLI | status daemon probe |
|---|---|---|---|
| ENOENT/EACCES/ECONNREFUSED | raw Node error reject | `daemonConnectionFailure`字符串/CLI envelope | `missing`且最终丢弃 |
| 完整connection close，无完整行 | `DaemonError(incomplete_response)` | 同上字符串化 | `missing`且丢弃 |
| half-close或不应答 | pending | 整条命令pending | 整份status pending |
| malformed/错误envelope | `invalid_json`或`invalid_request` | 作为connection failure处理，而非peer protocol ADT | `missing`且丢弃 |
| 合法 `ok:false` | resolve error variant | `code: message`，details多处丢失 | `invalid` + message |
| 合法success、错id | resolve success | 当成本请求result | 当成daemon.status结果，随后依result内容投影 |

`DaemonResponse`虽是 success/error discriminated union（`:289-297`），`code`仍为裸string、`result`仍为宽`JsonObject`；command名字是闭集而 request.command type本身仍string，只有server dispatch时收窄。故“有一个TS union”不等于 D5 的 command/result typed client。

### B6. 观察→机制→放大→消费者→根因

| 观察 | 机制 | 放大/消费者 | 根因 |
|---|---|---|---|
| silent/half-close不完成 | 无timer/abort/end收敛 | D7整页/status、D8动作、logs follow、context事务阶段均可卡住 | R1 |
| 32 MiB接受且RSS大增 | newline前无限string + JSON parse | 任一unauth本地peer或异常daemon可压垮gateway/CLI | R2 |
| wrong id成功 | parser不绑定request.id | response身份与mutation结果错误归属 | R3 |
| generic JsonObject | command与result无类型映射 | 每个caller手写/缺失parser，错误落点不一致 | R4 |
| errno/protocol/RPC压缩不同 | 无transport failure ADT | UI无法稳定区分connect/protocol/remote拒绝/未知结果 | R5 |
| 慢连接集合可累积 | 无server idle/handler/connection界限 | 一连接卡自身；多连接并行形成资源累积 | R6 |

只修症状的残留：D7 caller外层race不会自动销毁底层socket，且D8仍无界；response byte cap不解决silent/id；id校验不解决资源/error typing；高层parser不解决transport生命周期；server request cap不约束response；把所有失败统一“daemon down”会继续破坏D7分证与D8明确错误。

### B7. 测试资产、同错与盲区

- **资产：** `tests/integration/daemon/connection.integration.ts:5-83`覆盖同连接有序、连接间并行、坏行后继续；`chain-crud.integration.ts:389+`覆盖request太大；`central-cli.integration.ts:1396-1400`及`tests/unit/runtime/context-entry.test.ts:66-69`覆盖一种partial后完整close rejection。
- **同错：** ordered helper按“收够与请求数相同的任意response”完成，只解析id为string，不把每个响应绑定请求；因此无法发现错id。绝大多数测试直接 `expectOk(await sendDaemonRequest(...))`，继承generic envelope并只验证happy path。
- **盲区：** 无静默peer、Bun half-close、client deadline/取消、wrong id、多response选择、response byte cap/内存、connect errno分类、malformed envelope跨高层投影、慢handler/连接资源上限，以及D7/D8各动作在上述fault下的runtime矩阵。L33所谓socket fault盲区成立。
- **纯证明缺口：** gateway尚不存在，故 gateway HTTP/浏览器/mesh上的错误展示与取消没有现存对象；不能用新增engine测试冒充未来gateway E2E。

### B8. 实验证据、限制与清理

- 探针：`/tmp/coder-loop-544-I05-probe.ts`、`/tmp/coder-loop-544-I05-server-probe.ts`；逐case输出曾落`/tmp/coder-loop-544-I05-*.out`。
- 未触生产 daemon/root；真实server使用独立 `/tmp/coder-loop-544-I05-server-<pid>` 并在每次退出删除；silent/half-close client由外层发现存活后kill。
- 未做跨用户socket权限、恶意持续多连接压力或真实mutation“已提交但response丢失”实验；这些不影响已证伪的deadline/id/size结论，但具体资源极限与mutation歧义频率仍未知。
- 报告完成后删除上述 `/tmp/coder-loop-544-I05-*`，只保留本文汇总证据。
