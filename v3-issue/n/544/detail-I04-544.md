# RFC #544 R7 / I04：daemon 三证独立性与活性语义

> 固定事实面：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点：AGG D7（三证独立、分裂态如实）；上游观察：R5 L07/L10、R6 I04。本文只调查证据语义；transport 修补仍属 I05 未知，不在本文替代。

## A. 主 agent 摘要（最多一页）

### 结论与置信

**高置信：当前 `status` 不能稳定解释 D7 的“进程活 / 可连接 / 可应答”。** 三条原始证据本来彼此独立：

1. `daemon.pid` 只能证明文件内容；结合 `kill(pid, 0)` 才能得到该数字当前是否可 signal，但仍不能证明进程身份未复用。
2. Unix socket pathname + `connect()` 只能证明在该时点有 endpoint 接受连接，不能证明它是 coder-loop 或会完成 RPC。
3. 完整、合法、成功的 `daemon.status` response 才证明应用层可应答；其自报 pid/running 仍须与前两证交叉显示，不能替代它们。

现状只输出 `processes.live[]/scanError`：完全不读 pid file；socket connect 和 RPC response 合在一次 `sendDaemonRequest`；connect/parse/提前 close/权限等 rejection 先统一成为 `missing`，caller 又丢弃 `missing`；只有合法的 RPC error response 成为 `scanError`；成功 response 被压成六字段 process row，丢弃 daemon snapshot 其余字段；再按 pid 与 `ps` row 去重，重复时丢掉 socket 来源。接受连接但不应答时没有内部 timeout，整个 status 不完成。

### 因果、影响与多因

- **原始失败不等于 daemon 死。** ENOENT、陈尸文件、EACCES、非 socket、accept 后 close、非法 JSON、合法 error response、accept 后不响应分别是不同观测；当前除合法 error response 外，多数最终都投影成“没有 socket row、没有错误”。实验中 absent、dead pid+陈尸普通文件、malformed pid、invalid JSON、close、socket mode `000` 的最终 `processes` 相同。
- **原始成功不等于三证一致。** 成功 RPC 可自报任意活 pid；pid file 可缺失/陈尸/指向别的活进程；`ps` 的 command substring 匹配可产生无关 row。实验 harness 所在 shell 因命令文本含 `coder-loop` 与目标路径，被错误收为 `source:"ps"`。
- **多因可同时存在。** 例如 SIGKILL 留下 pid 文件，同时 socket pathname可能由内核移除或留陈尸；PID 后续复用；另一个 listener占用同路径；权限变化。只补一个 boolean 或只保留最终 RPC row，仍无法区分这些组合。
- **消费者影响。** 当前 CLI/既有 supervisor只能把 `live[]` 当宽松线索；若 GUI直接消费，会把未知画成 daemon 死、把 `ps` 假阳性画成活、在半开 endpoint 上整页挂起，并看不到“pid 活/socket 死”“socket 通/RPC 死”等 D7 核心分裂态。

### 可保留资产、未知、下一步事实输入

可保留资产：daemon 启动后写 pid、正常 stop 删除自有 pid/socket；真实 `daemon.status` snapshot；socket pathname monitor/rebind；现有真实 daemon status、missing pathname、rebind integration fixtures。测试盲区是三证组合和 projection：已有测试分别证明 server/RPC或现有折叠输出，未证明独立证据。

未知保持隔离：I05 应确定 transport 的有界失败与 response 身份；本文仅实证当前 silent listener 在外部 1 秒界限内不完成，并安全终止 client。未跨用户运行 socket/`ps` 实验；macOS 同一 owner 的 mode `000` 已稳定得到 EACCES，PID 1 的 `kill -0` 得到 EPERM，而现 `isPidAlive` 把任何异常都映射 false。下一步由主 agent 将下列矩阵与压缩链纳入正式问题树；不得从本文推出 UI 或修补方案。

## B. 证据附录

### B1. 探针代码链与全部压缩点

| 阶段 | 当前代码 | 原始值 | 压缩/丢弃 |
|---|---|---|---|
| pid file lifecycle | `src/daemon.ts:1245-1265,1649-1657` | pathname、raw text、read error | status builder不调用；`readDaemonPid`仅给连接失败诊断，malformed与absent均为 `null`（`:6031-6041`） |
| process scan | `src/loop.ts:3677-3706` | `ps -axo pid,ppid,command` exit/stdout/stderr | 只留 command命中启发式的row；cwd固定null；无法证明进程身份；scan全局失败才留字符串 |
| pid alive | `src/loop.ts:3709-3715` | `kill(pid,0)` success / ESRCH / EPERM等 | 任意异常均 `false`，EPERM与不存在合并 |
| socket + RPC | `src/loop.ts:3648-3659` → `src/daemon.ts:4652-4689` | connect、write、data、newline、parse、error、close | 没有独立 connect结果；任何 thrown error统一为 `kind:"missing"` |
| missing丢弃 | `src/loop.ts:3631-3645` | `ok / missing / invalid` | caller仅追加 `invalid.message`；`missing.message`静默消失 |
| daemon projection | `src/loop.ts:3662-3674` | `daemon.status` 的 pid/path/pidFile/running/shuttingDown/scheduler/activeRuns/rateLimit/两类 persistence failure | 只留 process六字段；`running !== false && kill0(pid)`生成alive，其余字段丢失 |
| 来源去重 | `src/loop.ts:3636-3639` | ps row + daemon-socket row | 同 pid 时不追加 socket row，来源与成功RPC证据消失 |
| 最终消费 | `src/loop.ts:3113-3177` | DB/events/processes独立读取 | `processes:{live,scanError}` 是唯一 status 投影，无 pid/socket/RPC槽 |

调用方：生产中 `buildCoderLoopStatusSnapshot` 经 CLI `status`/带 target 的 `daemon status`消费该投影；直接 daemon CLI 命令另走 `sendDaemonRequestForDaemonCommand` 与 `daemonConnectionFailure`（`src/loop.ts:2572-2637`），其“socket missing + 活 pid”诊断不是 status 三证供给。daemon server 是 `sendDaemonRequest` 的生产 peer；其余直接调用主要是 integration tests。

### B2. 原始证据—最终 status 受控矩阵

实验环境：macOS Darwin 24.6.0 arm64；隔离 root `/tmp/coder-loop-544-I04-matrix`；自建 Unix listener；每个 status client由 Python `subprocess.run(timeout=...)` 外部约束。表中无关 `ps` row 是 harness command substring 假阳性，所有 case 均相同。

| case | pid原始证据 | socket原始证据 | RPC原始证据 | 当前最终 `processes` |
|---|---|---|---|---|
| pathname absent | pid file absent | ENOENT | 未到达 | 只有无关ps row；`scanError:null` |
| stale普通文件 + dead pid | `999999`, kill0 false | ENOTSOCK | 未到达 | 同上 |
| malformed pid + absent socket | `garbage` | ENOENT | 未到达 | 同上 |
| listener + valid success | 活pid | connect ok | 合法success，含完整daemon对象 | 追加一条 `daemon-socket` row；完整对象只余六字段 |
| listener + invalid JSON | 活pid | connect ok | `not-json\n` | 只有无关ps row；`scanError:null` |
| listener + valid error | 活pid | connect ok | `{ok:false, code:"boom"}` | 只有无关ps row；`scanError:"boom: nope"` |
| listener accept then close | 活pid | connect ok | EOF | 只有无关ps row；`scanError:null` |
| listener accept, no response | 活pid | connect ok | 400ms raw probe timeout | status 在外部1s期限内未产生任何JSON；client被安全终止 |
| socket mode `000`, same owner | pid file未写（故意分裂） | EACCES | 未到达 | 只有无关ps row；`scanError:null` |

这组结果可证伪“`live=[]`即进程死”和“socket row缺失即connect失败”：相同投影覆盖至少六种不同原始状态；silent case甚至没有投影。

### B3. 可稳定解释的组合（证据语义，不是实现设计）

| pid file + process | connect | `daemon.status` | 可稳定陈述 | 不可稳定陈述 |
|---|---|---|---|---|
| raw pid合法，kill0成功 | 成功 | 完整success且自报同pid | 该数字当前可signal；endpoint可连；应用层在探测时应答；三证一致 | 不能仅凭kill0排除PID复用；不能保证下一时刻仍活 |
| 合法pid，kill0成功 | 失败 | 无 | 分裂：某进程可signal，但该pathname不可连接 | 不能称daemon健康，也不能仅凭连接失败否定该进程 |
| 合法pid，kill0成功 | 成功 | timeout/EOF/invalid/error | 分裂：进程证据和连接证据存在，应用层未成功应答 | 不能压成“running”或“dead” |
| absent/malformed/dead/reused | 成功 | success | pid-file/process证据与可应答endpoint分裂 | RPC不能回填“pid文件正确” |
| absent/dead | 失败 | 无 | 没有本次探测的活性正证 | 失败类型仍须保留；不能把权限/陈尸/ENOENT一律称正常死态 |
| 任意 | 未完成 | 未完成 | 观测本身未完成 | 不能输出负面活性结论 |

### B4. 权限、macOS process scan 与历史陈尸

- 本机 `ps -axo pid=,ppid=,command=` exit 0，能看到系统与同用户命令；当前 parser依赖完整 command substring（`src/loop.ts:3691-3704`），没有 executable/cwd/uid identity。权限政策或命令截断变化只能成为全局 `scanError` 或漏检。
- 本机 `kill -0 1` 对 root-owned launchd返回 `operation not permitted`；`isPidAlive` catch-all返回 false（`src/loop.ts:3709-3715`）。daemon内部另一个 `isPidOrGroupAlive` 正确把非ESRCH视为alive（`src/daemon.ts:4921-4935`），同仓已有语义分叉。
- 同owner socket `chmod 000` 实测 connect为 EACCES；status丢弃该错误。跨用户 ACL/sandbox 情形未运行，不能外推具体 errno。
- 正常 `stop()`先记录 `daemon.stop`，关闭server/store，再删除owned socket/pid（`src/daemon.ts:1512-1562`）；start failure也清理（`:1578-1589`）。SIGKILL/断电无法执行这些路径，因此 pid file可陈尸；Unix pathname的具体残留还取决于进程/OS。下一次 start先检测“socket缺失+pid/group活”，再探测并删除不可连接的 stale socket（`:1245-1250,6003-6016`）。运行中 pathname被unlink时，monitor会重建并发出 `daemon.socket.rebind`（`:1592-1634`）。这些不同形成路径进一步要求保留原始三证。

### B5. 根因集合、只修投影的残留

1. **采集缺口：** pid file没有进入 status。
2. **阶段合并：** connect与request/response共享一个promise，没有阶段结果。
3. **错误分类压缩：** thrown transport/parse/close错误→`missing`，随后被caller丢弃。
4. **成功投影压缩：** daemon snapshot→process row。
5. **身份压缩：** 仅按pid去重，来源丢失；kill0不证明身份。
6. **process启发式：** command substring能假阳性/漏检。
7. **完成性缺口：** 无内部timeout使结果可能不存在。

因此只增加一个 `running` boolean、只保留错误字符串、只展示 pid file，或只给当前 request 加边界时间，均仍留下其他独立根因；I05 的 transport结论也不能自行补齐 pid/process身份与 status projection。

### B6. 测试：已有资产、同错与盲区

- 资产：`tests/integration/cli/central-cli.integration.ts:934-981`覆盖 daemon不存在的 CLI error 与“活pid/socket pathname缺失”；`:999-1017`覆盖真实daemon经socket进入现有process row。
- 资产：`tests/integration/daemon/connection.integration.ts:1-83`覆盖server连接内顺序、跨连接并发、请求失败后继续；`:146-167`覆盖pathname rebind；真实 `daemon.status` 字段另在 rate-limit/shutdown等tests消费。
- 同错：`:1006-1013`只断言折叠后的 `source:"daemon-socket", alive:true`，没有独立断言 pid file/connect/RPC三槽；因此绿测会固化当前投影。
- 盲区：无 stale/malformed/permission/PID reuse/同pid双来源组合；无 invalid JSON/EOF/silent listener 的 status-level断言；无 timeout完成性；无 `ps` substring假阳性；无 EPERM与ESRCH分离；无证明完整daemon snapshot字段进入 status。

### B7. 实验证据索引与清理

```text
git rev-parse HEAD
nl -ba src/loop.ts | sed -n '3113,3177p;3631,3715p;2572,2637p'
nl -ba src/daemon.ts | sed -n '1240,1306p;1512,1657p;4652,4689p;4921,4935p;6003,6041p'
nl -ba tests/integration/cli/central-cli.integration.ts | sed -n '934,1020p'
nl -ba tests/integration/daemon/connection.integration.ts | sed -n '1,83p;146,180p'
python3 /tmp/coder-loop-544-I04-harness.py
python3 -c '...extract case/raw/processes summary from /tmp/coder-loop-544-I04-results.json...'
uname -a
ps -p 1 -o pid=,user=,command=
kill -0 1
ps -axo pid=,ppid=,command=
```

实验 listener与client均已退出；silent status client由外部 timeout 杀死。报告落盘后删除 `/tmp/coder-loop-544-I04-*`，不保留隔离 runtime。
