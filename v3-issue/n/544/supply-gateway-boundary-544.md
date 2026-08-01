# RFC #544 R4 供给侧调查：gateway 消费边界与进程隔离

基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点：AGG §1.2/1.3、§3.1、D1/D3/D5 与操作员裁决 A/B/D/E/G。本报告只核实现有引擎是否已提供同仓独立 gateway 可消费边界；不设计或实现 gateway，不裁决拆分与规模。

## A. 主报告（≤一页）

### 问题与结论

**问题**：GUI 尚不存在时，main 是否已经提供独立 gateway 所需的可导入、无副作用、单源且进程隔离的数据面？

**结论：整体不符合；现状是“三类可保留原料 + 三个关键供给缺失”。**

1. **D1 严格只读 SQLite 供给缺失。** `buildCoderLoopStatusSnapshot` 可导入，但它反复调用唯一的 read-write store opener；该 opener会切 WAL并执行迁移。daemon down 只让 socket 探测失败，不会把 DB 打开变成只读。快照还读取 preset/git/process/socket 等外部面，且多个独立 DB 连接之间没有同一 read transaction。
2. **D3 边界供给缺失。** status builder 与返回 TS type 可导出，但真正的 `StatusSnapshotBoundary` 未导出，且七个顶层槽仍是匿名 `object`。未来 gateway 无法从引擎 import 精确 HTTP boundary；若现在实现只能复制 shape/parser 或接受宽类型。
3. **D5 socket 只部分具备单源。** `DaemonCommandName`、`daemonRequest`、`sendDaemonRequest`、宽 `DaemonRequest/DaemonResponse` 已导出，operator 语义也确实是“请求不带 `agentCredential`”。但 command runtime narrowing tuple、请求/响应 parser、各 command 的 args/result boundary 均未导出；wire response 只是 `JsonObject`，transport 不核对 response id，且没有 timeout。陈尸/缺失 socket会 reject，半开或不应答 peer 会永久 pending。
4. **events 是最接近目标的特许供给。** event ADT/parser、路径 helper、发现/排序/全量 query均导出且导入无写副作用；路径可由同一 `resolveLoopDataPaths(root)` 得到。它仍只提供“段契约/全量 reader”，没有 gateway 所需的 offset/watch/torn-tail 恢复。另有两个 failure JSONL；daemon `logs.query` 会三流合并，而仅直读主 `events.jsonl` 会漏诊断事件。
5. **独立进程与单 root 仍主要是未来消费端责任。** path resolver接受 startup option/env并返回绝对 root，是可靠原料；但没有不可变 gateway runtime context，也没有机制阻止 route/request另传 root。模块 import 本身无文件副作用（隔离实验已证）。daemon 可由 CLI detached spawn，但该 executor未导出；公开 `startCoderLoopDaemon`是在调用进程内启动。gateway 生命周期、多个 listener 的统一关闭、daemon 与 gateway互不带死、单 root request 隔离，都只能由未来 gateway 建立和 E2E 证明。

**置信边界**：上述结论对固定 SHA 的静态调用图、导出面及两个 `/tmp` 隔离实验为高置信。未对生产 DB、生产 daemon 或 loop-data 做任何读取/写入实验；SQLite WAL/迁移的实际 byte/metadata 影响已由代码路径确定，但仍需 D1 专项隔离盘实验与生产 HTTP route 才能完成运行证明。

### 简明因果与影响

- 根因不是“gateway 尚未写”本身，而是引擎现有读面仍由 CLI/daemon内部需求塑形：status 复用可写 store；socket只在 envelope 层类型化；精确 parsers留在模块私有；生命周期 executor留在 CLI私有。
- **当前影响**：不能在不复制契约/不引入写风险的前提下实现 AGG D5；daemon-down HTTP status 的核心承诺当前不可成立。
- **未来消费端责任（不是供给缺陷）**：启动期只解析一次 root并封进不可变 context；route不得接受root；建立 HTTP boundary parse、socket超时/取消/错误映射、SSE/watch/offset、Bun listeners统一 shutdown、gateway退出不杀daemon。
- **纯证明缺口**：导入无副作用已有最小实验；尚缺只读 DB byte/metadata中立、并发 writer+reader一致性、半开socket timeout、gateway/daemon双进程kill矩阵。它们不能由现有绿测替代。

### 可保留资产、未知、下一步

- **资产**：`resolveLoopDataPaths`；events精确 ADT/parser/segment helpers；`DaemonCommandName`与现有 transport；status builder的业务聚合逻辑；`buildDaemonStartPlan`所表达的 detached CLI启动方式；daemon自己的root固定字段。
- **未知**：D1 schema mismatch ADT与schema版本公开方式；gateway是否必须合并两个failure streams；socket每个command的最终 args/result boundary；status读取的一致性级别。确定方法是由对应供给交付物按AGG目标钉住并用隔离集成测试证明，不能从当前私有 helper反推。
- **下一步**：R4/R5 将 D1、D3、typed RPC boundary标为阻塞供给；events标为“契约资产已供给、增量消费仍属未来gateway”；单root与双进程生命周期标为gateway责任，但依赖引擎先补足只读/status/RPC边界。不得把当前 `openSqliteStateStore`、私有 `StatusSnapshotBoundary` 或裸 `JsonObject` response列成可直接消费API。

---

## B. 证据报告

### B1. 逐条设计三态

| 设计要求 | 三态 | 现存资产 | 缺口/归属 |
|---|---|---|---|
| A：独立 gateway，daemon down 仍服务 | **未来消费端责任；引擎原料部分成立** | 引擎模块可安全 import；daemon socket/DB/events路径可独立解析 | 无 gateway host/process owner；公开 daemon starter是在当前进程内启动；双进程隔离未证明 |
| B/E：同仓 gateway 独家直读 events | **供给部分成立** | 精确 event ADT/parser、segment发现/排序、path helper导出 | 无增量offset/watch/torn-tail reader；主流不含两个failure流 |
| D1：SQLite严格只读 | **供给缺失** | status builder与store typed read methods存在 | 唯一 opener `readwrite:true`、WAL、migration；无schema mismatch result |
| D3：status精确 boundary单源 | **供给缺失** | builder与TS snapshot types导出 | boundary私有，七槽匿名；HTTP消费端无可import parser |
| D5：typed socket client，词表单源 | **部分成立/偏离** | command union、request constructor、transport导出 | runtime tuple/parser私有；args/result宽 `JsonObject`；无response-id校验/timeout |
| D5：零凭证=operator | **现状成立但语义依赖daemon** | 无 `agentCredential` 时 caller resolver走operator；gateway进程通常无runner credential | gateway必须禁止HTTP客户端伪造/透传 `agentCredential`；这是未来消费端责任 |
| D5/P4：一个实例单root且request不可覆盖 | **未来消费端责任** | root precedence与绝对路径验证单源 | resolver每次都可接option/env；无startup-only immutable context或route约束 |
| 进程start/stop解耦 | **部分成立/偏离** | detached spawn逻辑存在；socket `daemon.down`存在 | detached executor私有且嵌于queue-unblock；`daemon start/restart` CLI本身只检查全局daemon；无gateway lifecycle API |

### B2. status / SQLite 消费边界

1. `buildCoderLoopStatusSnapshot` 是导出函数（`src/loop.ts:3113-3177`），但 `StatusSnapshotBoundary` 是文件私有常量（`:520-529`）；七槽为 `"object"`，只有 `taskTree`精确。builder返回前只用这个宽boundary assert（`:3176`）。
2. snapshot首先经 `resolveDbChainForTarget` 打开store（`:4176-4217`），随后 items/current/runs/taskTree各自再次打开和关闭store（`:4230-4272`）。因此一次snapshot不是一个SQLite read transaction；daemon并发写时，各槽可能来自不同commit时刻。
3. 唯一 `openSqliteStateStore`（`src/sqlite-state.ts:822-857`）：
   - `Database(... { readwrite: true })`（`:831`）；
   - 查询并在需要时执行 `PRAGMA journal_mode = WAL`（`:841-849`）；
   - 无条件调用 `migrateStateSchema`（`:850`）。
4. migration不是抽象风险：它含 `CREATE/ALTER/UPDATE/table rebuild/PRAGMA user_version`并用immediate transaction（`:948-1089`）；旧runtime迁移还能spawn preset materializer（`:1080`与`src/sqlite-state.ts:1183-1192`）。崩溃由SQLite transaction保证原子性不等于“读取无写副作用”；WAL/journal/schema/metadata均可能变化。
5. `createIfMissing:false`只防止缺盘新建（`:825-827`），不改变open mode/WAL/migration。daemon down时builder仍走同一路径；socket失败只在process snapshot中转为missing（`src/loop.ts:3648-3659`）。
6. builder还加载target runtime/preset、infer git repository、扫描进程、查询socket（`:3116-3155,4176-4204,3631-3659`）。故它不是“仅SQLite函数”；D1未来供给需明确哪些外部错误进入类型化结果。

**锁/崩溃接缝**：`busy_timeout=5000`（`src/sqlite-state.ts:839-840`）意味着未来gateway若复用此opener，可能与daemon writer等待/竞争；migration使用`.immediate()`会主动取得写锁。当前多opener snapshot也没有一致性边界。未在生产盘实验；确定方式是在隔离root用真实daemon writer并发D1 reader，断言snapshot语义及DB/WAL/journal byte/metadata。

### B3. socket 类型、主体与失败语义

#### 可import面与单源程度

- 导出：`DaemonCommandName`（`src/daemon.ts:161-205`）、宽 `DaemonRequest/DaemonResponse`（`:283-297`）、`daemonRequest`（`:4692-4694`）、`sendDaemonRequest`（`:4652-4690`）。
- runtime命令闭集 `DAEMON_COMMAND_NAMES`及`narrowDaemonCommandName`不导出（`:5731-5767`）。它与union有编译期双向检查，但未来gateway只能在编译期引用union，不能import runtime command parser。
- request/response parser不导出（`:4978-5003`），且只校验envelope；各command `args`、成功`result`均是 `JsonObject`。server handler内部再按command私有解析；client只得到宽对象。
- transport不检查response `id`是否等于request `id`（`:4671-4674`）。异常JSON/shape会reject，连接在完整newline前关闭会报`incomplete_response`（`:4684-4688`）。

#### daemon down、陈尸、异常与timeout

- 缺失/拒绝连接socket会由Node error reject；CLI层再调用`detectDaemonSocketPathIssue`区分陈尸/路径分裂（`src/loop.ts:2572-2631`）。该高层错误ADT/helper未导出。
- `sendDaemonRequest`没有timer、AbortSignal、response byte上限或 EOF之外的deadline（`src/daemon.ts:4652-4690`）。隔离fake Unix server接受连接但不回复，300ms后Promise仍未settle（证据命令E2）。因此半开peer可永久占住gateway request。
- server限制request为1MiB（`:410,1680-1685,4964-4971`），client对response无相应上限。

#### operator主体

- daemon分类表把生命周期/解卡写命令设为`hard-deny-for-agent`（`:1732-1765`）。
- CLI仅在进程env存在`CODER_LOOP_RUN_CRED`且命令属于列表时自动加`agentCredential`（`src/loop.ts:2487-2556`）。
- daemon caller resolver的既有语义是缺credential即operator；例如context author明确由daemon推导，operator分支见`src/daemon.ts:1769-1774,1848-1850`。因此gateway可以不持有凭据调用operator命令，但必须构造固定args且不接受浏览器传入`agentCredential`。现有通用`daemonRequest(command,args)`不会替它保证这一点。

**全部当前生产消费者**：`src/loop.ts`是唯一生产transport消费者（request helpers、daemon status/process probe）；daemon自己是server。其余调用均为integration tests。没有另一个production socket client可作为精确 gateway facade。

### B4. events 合同、路径与耦合

- `ObservabilityEventBoundary`及infer types、`parseObservabilityEvent`导出（`src/observability.ts:823-829,911-920`）。
- segment boundary/helper、发现、排序、active basename导出（`:875-881,1286-1363`）；`resolveLoopDataPaths(root).eventsFile`给出同一root下路径（`src/runtime-paths.ts:117-138`）。
- `queryObservabilityEvents`按全序逐文件全量读取，每行`JSON.parse`后精确parse（`src/observability.ts:953-965`）。它没有offset、watch、active tail半行容错：并发writer刚写半行时JSON parse可直接失败。未来D6 reader属于gateway消费实现，不应伪称当前已供给。
- writer和reader共享segment命名/排序helper，这是可保留单源；但append函数也从同一模块导出（`:923-950`），类型系统并不禁止gateway误import写API，需gateway依赖面/审计保证“只读”。
- path里除主流还有`lifecycle-event-persistence-failures.jsonl`与`runner-persistence-failures.jsonl`（`src/runtime-paths.ts:130-132`）。daemon `logs.query`合并三流（`src/daemon.ts:2712-2724`）；AGG §3.1/D6若只消费主流，最后失败诊断的可见性需明确裁决，当前不能猜。

**全部当前生产消费者**：daemon的failure恢复和`logs.query`、loop的status recent-events读取；其他均为tests/scripts。没有production增量tailer。

### B5. root固定、模块副作用与进程生命周期

1. root解析优先级是explicit option → `CODER_LOOP_DATA_DIR` → `~/.coder-loop/loop-data`，拒绝空值/相对路径（`src/runtime-paths.ts:98-115`）。所有DB/socket/events helper可由同一resolved paths对象取得。
2. daemon constructor把paths存入private readonly字段（`src/daemon.ts:1156-1208`），所以daemon自身实例内root固定。gateway不存在，因而没有startup parser/context或request级防覆盖机制；这是未来gateway自己的责任。
3. 公开 `startCoderLoopDaemon` 直接`new CoderLoopDaemon(...).start()`（`:4648-4650`），会把server/store/timers装入调用者进程，不满足A的独立进程语义。CLI `daemon up`也是前台持有直至closed（`src/loop.ts:3770-3833`）。
4. detached spawn实现存在于私有`executeDaemonStart`（`:3874-3913`），使用`detached:true`+`unref()`，其plan builder导出（`:3718-3767`）；但executor只被`queue unblock --start-daemon`内部调用（`:4040-4073`）。`daemon start/restart`命令当前只验证全局daemon已在（`:3852-3871,3936-3956`），并非通用独立lifecycle API。
5. daemon与未来gateway会共享root中的DB/events/socket/pid；daemon拥有socket/pid清理标志（`src/daemon.ts:1184-1185`）且gateway不应触碰。当前没有gateway lock/pid文件，故也没有已实现的单实例或双进程lock接缝；需未来process owner定义。

### B6. 模块加载实验、测试盲区与同错风险

**E1 import副作用实验**

```sh
ROOT=$(mktemp -d /tmp/coder-loop-544-import.XXXXXX)
rmdir "$ROOT"
CODER_LOOP_DATA_DIR="$ROOT" bun -e \
  'await import("./src/loop.ts"); await import("./src/daemon.ts");
   await import("./src/sqlite-state.ts"); await import("./src/observability.ts");
   await import("./src/runtime-paths.ts"); console.log("imports-ok")'
test ! -e "$ROOT"
```

观察：`imports-ok`、`root-not-created`。`src/loop.ts`只在`import.meta.main`时运行CLI（文件尾）；固定SHA下导入上述模块不创建root、socket、DB或events。

**E2 transport无timeout实验**

```sh
ROOT=$(mktemp -d /tmp/coder-loop-544-socket.XXXXXX)
SOCK="$ROOT/fake.sock"
SOCK="$SOCK" bun -e \
  'import {createServer} from "node:net";
   import {sendDaemonRequest,daemonRequest} from "./src/daemon.ts";
   const s=createServer(()=>{}); await new Promise(r=>s.listen(process.env.SOCK,r));
   let settled=false;
   sendDaemonRequest(process.env.SOCK,daemonRequest("daemon.status")).finally(()=>{settled=true});
   await Bun.sleep(300); console.log(JSON.stringify({settledAfter300ms:settled}));
   s.close(); process.exit(0)'
```

观察：`{"settledAfter300ms":false}`。实验仅在`/tmp`创建并清理fake socket。

**测试盲区/同错**

- status integration自己在harness定义一个只含`events.recent`的局部 `StatusSnapshotBoundary`，不是生产boundary（`tests/integration/daemon/harness.ts:117`）；CLI roundtrip测试因此不能证明D3单源。
- SQLite测试普遍调用同一`openSqliteStateStore`作为seed、reader与verifier；这会把“reader迁移/WAL写入”当作正常初始化，无法发现D1要求的零写违规。
- socket integration大量直接复用`daemonRequest/sendDaemonRequest`，能证明现transport互操作，却无法发现两端共享同一宽parser、无command-specific result boundary或无timeout的问题。
- events tests证明段排序/rotation与全量query，不覆盖真实gateway active-tail半行、fs.watch丢通知、offset持久/翻段竞态或failure streams合并。
- 没有gateway进程，因此不存在daemon kill后HTTP仍应答、gateway kill不带死daemon、重复start/stop、root逃逸等E2E。

### B7. 证据索引

| 主题 | 主要证据 |
|---|---|
| AGG目标 | `AGG-544-gui-observability-gateway.md:20-38,83-119,177-186,250-286` |
| status boundary/builder | `src/loop.ts:520-529,3113-3177` |
| 多DB opener | `src/loop.ts:4176-4217,4230-4272` |
| SQLite写风险 | `src/sqlite-state.ts:822-857,948-1090,1183-1192` |
| socket类型/transport/parser | `src/daemon.ts:161-205,283-297,4652-4694,4978-5003,5731-5767` |
| auth/operator | `src/daemon.ts:1732-1765,1769-1774`; `src/loop.ts:2487-2556` |
| events契约与三流 | `src/observability.ts:823-965,1286-1363`; `src/runtime-paths.ts:117-138`; `src/daemon.ts:2712-2724` |
| root/lifecycle | `src/runtime-paths.ts:98-138`; `src/daemon.ts:1156-1208,4648-4650`; `src/loop.ts:3718-3770,3770-3833,3874-3913,4040-4073` |
| 隔离实验 | 本报告B6，固定SHA本机执行，产物位于并已清理`/tmp/coder-loop-544-*` |

