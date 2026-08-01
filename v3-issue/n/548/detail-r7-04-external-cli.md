# R7-04 — external-terminal 真实 CLI 与 probe/invocation 合约

## A. 主 agent 摘要（≤1页）

### 问题与结论

本调查固定在 coder-loop `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`，只回答稳定 T7 / §2.4 所需的外部 terminal CLI 当前事实，不进入 remote lifecycle/loss（R7-06/07）。

**高置信结论：稳定设计和历史候选默认的 `hapi-remote-session` 当前不在 `PATH`，本机也没有发现同名 binary/repo。** 真实已安装且有本地源码的通用 HAPI session CLI 是 `hapi-open-session` 0.1.0；它不是历史候选假设的 runner 合约：没有字面 `probe` 子命令、没有 `--version`、没有 headless runner/status-file 参数、没有 resume/session-id 输入、没有等待远端 turn 终态、不会生成或更新 `status.json`。它的正常路径只负责认证、选择 machine、创建新 session、等待 `active=true`、发送一次 prompt，然后立即以 0 返回。因此“可创建 session”和“runner invocation 完成”在当前真实 CLI 中是不同事件。

**因果：** 历史候选从未消费真实 CLI schema，而是内置了 `hapi-remote-session probe`、0/69/other/signal/deadline 分类和默认 binary 名，并把 invocation 截为 pending。当前安装 CLI 的任意位置参数（包括字面 `probe`）都会被解释为目标路径并进入认证/创建路径；本次无副作用试探实际在认证阶段以 HTTP 502/exit 1 停止，证明它不是 probe。故不能用该命令安全地判断 endpoint availability，也不能把 exit 0 当 agent 终态。

### 影响、资产与未知

- **当前影响：** 历史 `probe` argv、exit 69、headless `status.json`、resume/session parser、`hapi-remote-session` binary identity 均无真实外部合约支持。把 `hapi-open-session` 直接代入会把 availability probe 变成可能创建 session 的 invocation，并把“消息已发送”误报为 run 完成。
- **确定可保留资产（不等于接入建议）：** external-terminal 领域分类、probe/invocation 分离的抽象需要；历史 fake 对 deadline/signal/process-group 的引擎机制测试思路。当前 CLI 可提供明确 path→session directory、prompt 透传、machine/model/session-type 参数和 session id stdout，作为后续实验输入。
- **未知：** 是否另有未安装/未 checkout 的 `mouriya-s-lab/hapi-remote-session` 实现；期望的 probe wire、headless status schema、terminal wait、resume/reuse、signal/取消行为全部未知。正常创建路径因会产生真实 remote session，按边界未执行。
- **进入后续阶段：** **不足以直接进入 R7-06 的真实 invocation/lifecycle 实验，也不足以供 R8 固化接入形态。** 它足以关闭“历史候选已匹配当前 CLI”这一假设（答案为否），并为 R7-06 前置一个明确实验要求：必须先提供/定位实际 runner binary，或在真实通用 CLI 上确认一套无副作用 probe 与 headless terminal/status 合约。R7-07 仍完全未调查。

置信边界：binary/PATH、安装包、源码与无副作用 CLI 行为为高置信；远端成功路径和服务端 schema仅由当前客户端生产源码证明请求形状，未以真实 session 验证。

---

## B. 证据附录

### B1. 调查基线与资产身份

| 对象 | 当前事实 | 证据 |
|---|---|---|
| coder-loop | `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` | 固定任务基线 |
| 历史候选 | `8e9642c` | 本地 git object；未 checkout/worktree |
| `hapi-remote-session` | `command -v`/`which -a` 均未找到；HOME 范围同名文件/目录未找到 | 2026-07-30 本机命令探测 |
| 已安装 CLI | `/opt/homebrew/bin/hapi-open-session` → `/opt/homebrew/opt/hapi-open-session/bin/hapi-open-session` | `ls -l` |
| 安装包版本 | `0.1.0` | venv `importlib.metadata.version("hapi-open-session")` |
| 对应源码 | `/Users/mouriya/Ext/code/hapi-open-session`, `main@bb772451174547605c89e50f372ce886ee0df203`，clean | `git status`, `git rev-parse` |
| 安装/checkout 一致性 | installed `cli.py` 与 checkout SHA-256 同为 `38493f...a8fe` | `shasum -a 256` |

源码版本也由 `hapi-open-session/pyproject.toml:1-10` 和 `src/hapi_open_session/__init__.py:1-2` 固定为 0.1.0。CLI wrapper 安装链见 `install.sh:4-30`。

### B2. 当前真实命令面与输出

#### Help / version

真实执行 `/opt/homebrew/bin/hapi-open-session --help`：exit 0。唯一位置参数是 `path`；options 为 `--settings`、`--machine-id`、`--agent`、`--model`、`--reasoning-effort`、`--[no-]yolo`、`--prompt`、`--prompt-template`、`--session-type {worktree,simple}`、`--wait-active-timeout`、`--dry-run`。parser 定义见 `hapi-open-session/src/hapi_open_session/cli.py:248-277`。

真实执行 `hapi-open-session --version`：exit 2，stderr 为 argparse usage + `the following arguments are required: path`。当前 CLI 没有 version flag。

#### Dry-run（确认无网络调用）

从 RFC cwd 与 `/tmp` 分别执行：

```text
hapi-open-session /Users/mouriya/Ext/code/coder-loop/v3-issue/n/548 \
  --dry-run --prompt RFC548-contract-probe
exit=0
```

两次均输出相同解析结果：inputPath/sessionDirectory 为显式绝对路径、mode=`prompt`、agent=`codex`、model/effort null、yolo=true、sessionType=`worktree`、prompt 原样；结果不依赖进程 cwd。`run()` 在读取 settings 后、构造 client 前返回，故 dry-run 无网络副作用（`cli.py:280-306`）。

缺失 settings 实验：`--settings /tmp/rfc548-r7-04-missing.json --dry-run` 返回 exit 1，stderr `error: settings file not found: ...`（`cli.py:51-70,338-340`）。

#### 字面 `probe` 不是 probe

真实执行 `hapi-open-session probe`：exit 1，stderr `error: POST /api/auth failed with HTTP 502: error code: 502`。没有创建 session（认证未成功），但已经发生认证 HTTP 请求。机制上 argparse 把 `probe` 当 path；随后非 dry-run 路径认证并准备 spawn（`cli.py:252,280-308`）。因此该调用不是无副作用 availability probe；服务恢复时它可能继续创建 session。

### B3. Invocation 合约矩阵

| 维度 | 当前 `hapi-open-session` 0.1.0 | 稳定 T7 所需事实的状态 |
|---|---|---|
| binary identity | `hapi-open-session`;设计名 `hapi-remote-session` 缺失 | 不匹配 |
| probe argv | 无子命令；任意位置字符串是 path | 未提供，历史 `probe` 假设被证伪 |
| invocation argv | `PATH [options]` | 已确认创建入口 |
| prompt transport | `--prompt` 原样；未给时模板格式化绝对 path | 已确认（`cli.py:73-88,272-273`） |
| cwd | process cwd 不决定 session cwd；PATH resolve 后目录自身或文件 parent | 已确认（`cli.py:73-87`） |
| machine identity | settings `machineId` 或 `--machine-id`；只选择 active 且 workspace root 覆盖 session directory 的 machine | 静态确认（`cli.py:195-245,286-311`） |
| auth resolution | `HAPI_API_URL` 优先于 settings `apiUrl/serverUrl`; `CLI_API_TOKEN` 优先于 `cliApiToken`; settings default `~/.hapi/settings.json` | 已确认（`cli.py:16,51-70`） |
| credentials | 本机 settings 存在且三项所需字段 present；报告不含值。文件 mode 当前为 0644 | 可用路径存在；未把 secret 写入实验/报告 |
| create request | authenticate → list machines → POST `/api/machines/{id}/spawn`, body directory/agent/yolo/sessionType + optional model/effort | 客户端生产源码确认（`cli.py:98-167,306-331`） |
| session identity output | spawn response `sessionId`；stdout `session: <id>` | 创建后可读，但非结构化 JSON/文件（`cli.py:164-167,332`） |
| active wait | poll `/api/sessions/{id}` 直到 `active is True`, default 90s | 只代表 session active（`cli.py:169-185,275,333-334`） |
| completion wait | 无；send_message 成功即打印 `sent` 并 exit 0 | 不满足 runner terminal completion（`cli.py:335-337`） |
| resume/reuse input | 无 `--resume` / `--session-id`;每次正常调用走 spawn | 未提供 |
| status/headless output | 无 status path/schema/JSONL/headless option；不写 `status.json` | 未提供 |
| exit code | argparse error=2；捕获的 `HapiError`=1；dry-run/发送成功=0 | 只有粗粒度三类，不支持 69 typed availability |
| signal/deadline | 仅 active polling timeout变 HapiError/1；无已声明 signal/取消 wire | 未验证；不可安全外推 |

### B4. Probe、invocation 与错误分类边界

当前 CLI 的错误面集中为文本 `HapiError` 并统一 exit 1：settings 缺失/非法、URL/token 缩缺、HTTP/URL error、auth token 缺失、machines response、machine availability/root mismatch、spawn response、session response、active timeout均如此（`cli.py:51-70,98-188,224-245,338-340`）。argparse 自身错误为 2。它没有稳定机器可读 error code。尤其：

- binary missing 是父进程 spawn 的 OS error，不由 CLI 编码；
- endpoint unavailable、auth failure、machine unavailable、spawn failure、active timeout都可能收敛为 exit 1；
- exit 0 只证明 initial message POST 已返回，不证明 agent 完成或 `status.json` admission；
- `--dry-run` 验证本地参数/config解析，不探测 endpoint，因此不能作为 availability probe。

### B5. 历史候选假设逐项对照

| 历史 `8e9642c` 假设 | 位置 | 当前真实证据 |
|---|---|---|
| 默认 binary `hapi-remote-session` | `src/loop.ts:5354-5358` at `8e9642c` | binary 缺失；现有 binary 名不同 |
| probe argv 固定 `['probe']` | `src/runner-execution.ts:4-17` | 当前 CLI 无子命令，`probe` 是 path且会认证/可能创建 |
| probe 0=available | `runner-execution.ts:52-60` | 当前 dry-run 0不探 endpoint；正常 0只表示消息发送 |
| probe 69=endpoint unavailable | 同上 | 当前 CLI无 69 分类，HapiError统一 1 |
| other/signal/deadline typed | `runner-execution.ts:32-60` | 当前 CLI未定义对应 wire；active timeout统一 1 |
| child `error`=binary missing | `runner-execution.ts:79-106` | 已知历史自身误分类所有 spawn error；外部 CLI无补充编码 |
| invocation pending/throw | `src/loop.ts:6962-7015` | 准确描述候选未实现，不是外部 CLI 合约 |
| generic cwd/prompt/status 可沿本地 spawn | `src/loop.ts:6962-6999` | 当前 CLI能收 path/prompt，但没有 status/headless terminal completion |
| HAPI session parser永远 null | `src/loop.ts:7262-7268` | 当前 CLI stdout有 `session: ID`，但候选未解析；没有 resume输入 |
| fake integration `zero-hapi-spawn` 为 PASS | `scripts/external-terminal-integration.ts:197-239,403-449,526` | 只证明 shim模型；与真实 CLI命令面冲突 |

历史测试覆盖 probe decode、hold/gate、公平、restoration/latch/race/status/startup/migration等引擎机制（总账 `S2-T01`），但真实 CLI 盲区包括 binary identity、真实 argv、auth、machine selection、session id、terminal wait/status admission、resume和实际 error mapping；其 pending/zero-spawn expectations反而固化错误终点（`S2-T02..T06`）。

### B6. 当前合约可支持的确定形态（不作推荐）

1. **session-launcher 形态：** 以 PATH/agent/model/sessionType/prompt 创建新 HAPI session，输出 session id，并在 initial message 接受后退出。确定后果是调用进程生命周期短于远端 agent turn，不能直接承担 coder-loop runner completion。
2. **local-plan 形态：** `--dry-run` 可解析 config/path/model并输出 JSON。确定后果是完全不证明 endpoint/machine可用。
3. **稳定 T7 runner 形态：** 当前 binary不具备所需 probe + terminal wait + headless status/resume输入，因此该形态在现有可见资产上不存在；是否有另一个未安装资产未知。

### B7. 无法安全执行的实验与后续最小要求

本调查禁止创建真实 remote session，因此未运行成功 invocation。要补足 R7-06 前置合约，实验必须在隔离 cwd 且明确允许创建/清理 session后执行，并记录（不得把 secret写入日志）：

1. 定位将被生产调用的**确切 binary及版本**，先验证无副作用 probe；若无 probe，不能用创建命令代替。
2. 正常 invocation 必须记录 argv、stdin/stdout/stderr、cwd、env名称（不含值）、同步 exit时点、session id、远端 turn terminal时点和 status artifact每次变更。
3. 证明 prompt完整性、既有 cwd绑定，以及同一 invocation的 terminal success/failure如何机器可读地区分。
4. 单独验证 resume/retry是否接受既有 session identity；当前 CLI无此入口。
5. 对 missing executable、endpoint unavailable、auth/config error、spawn rejection、active timeout、signal逐项观察真实 exit/output；禁止从历史 0/69表反推。
6. 若最终仍使用 `hapi-open-session`，需先确认其服务端 side effects清理路径；本报告不裁决应扩展它还是另建 binary。

### B8. 可保留资产与修补边界

- 可保留：external-terminal ADT及 probe/invocation概念分离；process-group deadline/signal测试；hold/status/event词表；当前 CLI的 path解析、settings优先级、machine root筛选、prompt/model传输和 session-id读取逻辑，均须以最终生产 binary复核。
- 不可当作合约：`hapi-remote-session` 名、`probe` argv、exit 69、pending variant、zero-spawn验收、fake status写回。
- 只修 coder-loop 的 child-error分类或 invocation builder不会补上外部 binary缺失的 probe/headless/status/resume契约；只扩当前 launcher输出也不会自动证明远端 terminal lifecycle。这里是外部契约缺口，不是单个 parser缺陷。

### B9. 证据索引与核对

| 证据 | 支持结论 |
|---|---|
| `AGG-548.md:72-78,151-231` | 唯一设计锚点 T7/§2.4/STD-602-1/2/8 |
| `investigation-index.md:55-67` | R7-04边界与必须事实 |
| `supply-findings-ledger.md:79,84,93-94,111` | S2-D04/D09/R01/R02/U01回指 |
| `supply-hapi-reconcile-audit.md:45-140` | 历史候选调用链与未知来源 |
| `hapi-open-session/src/hapi_open_session/cli.py:51-188,224-344` | 当前生产 CLI parser、auth、create、wait-active、send、exit |
| `hapi-open-session/tests/test_cli.py:15-133` | 仅 path/machine/request/model fake coverage；无真实 runner终态 |
| 2026-07-30真实 help/version/dry-run/literal-probe probes | 当前 binary行为与 exit/output |
| `8e9642c:src/runner-execution.ts:4-128`; `src/loop.ts:5354-5358,6962-7015,7262-7268` | 历史假设对照 |

核对：A摘要在分隔线前；报告只写本文件；未修改产品/测试/config/DB/WORKFLOW，未创建worktree/issue/PR/session；所有 `/tmp/rfc548-r7-04-*` 已清理；未调查R7-06/07 lifecycle/loss；未作实现推荐、issue重拆或规模估算。
