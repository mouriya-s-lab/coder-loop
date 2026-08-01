# R7-10 — immutable candidate 与 live merge-base gate 事实

## A. 主 agent 摘要

### 问题

STD-602-9/10 要求把本地 runner 回归与仓库卫生绑定到同一 immutable candidate SHA，并在该 candidate 与 `origin/main` 的 **live merge-base** 上执行可归因的双基线 gate。当前需要查清：现仓真实可执行的 gate、输入、产物和副作用，以及哪些结论在候选冻结前根本不能成立。

### 结论与置信边界

1. **当前没有可验收的 immutable candidate。** 调查固定基线 `HEAD=699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`，它同时等于本地 `main` 与本地 remote-tracking `origin/main`；因此当前 `$BASE..HEAD` 为空，只能证明“此调查基线相对最后一次本地 fetch 无差异”，不能代表 RFC 最终 candidate，也不能证明 fetch 时刻的 live `origin/main`。
2. **live merge-base 必须在候选冻结后、成功 `git fetch origin main` 后重新算。** 本任务明确禁止 fetch；本地 `origin/main` reflog 显示其最后更新为 `2026-07-29T16:40:40+09:00`。故本报告不把它冒充 2026-07-30 的 live ref。可验收输入应记录 `CANDIDATE=$(git rev-parse <frozen-ref>^{commit})`、`ORIGIN_MAIN=$(git rev-parse refs/remotes/origin/main^{commit})`、`BASE=$(git merge-base "$CANDIDATE" "$ORIGIN_MAIN")`，并要求 `git merge-base --is-ancestor "$ORIGIN_MAIN" "$CANDIDATE"` 成功，才能满足“candidate 包含当前 origin/main”。
3. **STD-602-9 的文字命令需要按当前 CLI 的必填输入具体化。** `bun scripts/engine-integration.ts` 当前没有 `--log-file` 会 exit 2；权威可执行形式是前台、显式日志路径：`bun scripts/engine-integration.ts --log-file <candidate-log> --foreground`。它使用隔离 loop-data，但仍会在该 checkout 下创建 `.coder-loop/runtime/engine-integration/<uuid>`；成功默认删除，失败保留诊断目录。
4. **`bun test` 不是完整 local integration gate。** 当前 `package.json` 的 `test:unit` 才是 `bun test`；仓库的完整分层入口是 `bun run test:all -- --log-file <path> --foreground`，包含 unit、integration-cli、integration-scheduler、integration-daemon。可是 STD-602-9/10 的稳定原文只点名 `bun test`，不能由本调查擅自把它扩大成 `test:all`。所以 STD-602-9 的既定 gate是 install + typecheck + `bun test` + engine-integration；STD-602-10 两侧是 install + `bun test` + diff/卫生审计。若 RFC 后续另有明确验证边界要求 `test:all`，应另列，不能悄悄替换标准。
5. **两侧 gate 尚未运行，不能给出回归归因。** 本调查按任务禁止实际运行伞级完整测试和 real-e2e；也没有冻结 candidate、live fetch 或允许的 clean detached worktrees。现阶段静态成立的是命令入口、参数、隔离/清理设计和当前本地 refs；exit 0、runner 行为未回归、无 orphan、两侧同错/异错以及 committed hygiene 全部必须冻结候选后实跑。

### 因果解释

回归归因依赖三个同时固定的量：candidate commit、fetch 后的 `origin/main` commit、由两者计算的 merge-base。仅在当前脏 checkout 跑一次测试，会混入未提交文件；仅在 candidate 跑，会把 baseline 已有失败误判为 candidate 引入；在旧 remote-tracking ref 上算 base，则不能证明 candidate 包含验收时的 main。两侧还必须使用相同 Bun/OS、相同命令和彼此隔离的 clean checkout，否则依赖安装、`.test-runs`、日志或失败保留的 runtime 会污染比较。

### 当前影响、未来影响、纯证明缺口

- **当前影响：** 无法宣称 `S2-D17` / `S2-U05` 已满足，也无法从 focused fake tests 推出 local runners 未回归。
- **未来影响：** candidate 冻结后若 `origin/main` 前进，必须重新 fetch、重新验证祖先关系并重算 base；否则旧 BASE 证据失效。
- **纯证明缺口：** 双侧命令 exit、完整日志、版本/环境、test diff 人工审计、post-run git/process/worktree/runtime 卫生。该缺口不产生新的产品机制需求。

### 可保留资产

- `package.json:8-12` 的 typecheck/unit/分层测试入口。
- `scripts/run-tests.ts:48-53,280-327,351-365,452-519` 的确定性 batch 顺序、fail-fast、状态与 `FINAL exit` 日志。
- `scripts/engine-integration.ts:16-21,31-39,118-141,469-533,568-605` 的显式日志、隔离环境、隔离 loop-data、断言及 teardown。
- `tests/preload.ts:1-32` 对外层 run credential 的测试环境清理。

### 尚未确定与下一步

无需设计裁决；需要在**最终候选冻结后**继续证明。由有权 fetch/创建 clean detached worktrees 的验收执行者按 B.6 运行，不得在当前脏工作区或本 RFC 调查阶段代跑。失败时先按“双侧同错”矩阵归因：candidate-only 才是候选回归证据；两侧同错是环境或既存 baseline 信号；base-only/candidate-pass 是候选修复或环境不一致信号，均不能不看日志直接下结论。

---

## B. 证据附录

### B.1 设计对照

| 标准 | 当前仓库中的可执行解释 | 当前状态 |
|---|---|---|
| STD-602-9 | candidate clean checkout：`bun install --frozen-lockfile`；`bun run typecheck`；`bun test`；`bun scripts/engine-integration.ts --log-file <path> --foreground` | 入口静态存在；结果未运行 |
| STD-602-9 runner 回归 | 除全绿外，需结合 test/engine log 确认 claude/codex/opencode 没进入 external-terminal probe，missing-binary/spawn failure、attempt/resume 既有断言仍通过 | 单靠 exit 0 不足；未运行 |
| STD-602-9 无 orphan | engine harness 内部检查以本轮 loop-data path 匹配进程；外部仍需 post-run process/worktree/runtime 检查 | 内部断言静态存在；结果未运行 |
| STD-602-10 live base | fetch 后冻结 `ORIGIN_MAIN`，计算 `BASE=merge-base(CANDIDATE,ORIGIN_MAIN)`，并验证 `ORIGIN_MAIN` 是 candidate ancestor | 当前仅有旧 local remote-tracking ref |
| STD-602-10 双侧 | candidate/base 两个 clean detached worktree，同环境分别 install + `bun test` | 未运行；本任务禁止创建 worktree |
| STD-602-10 test diff | 对 `$BASE..$CANDIDATE` 全量审计 test 文件 name-status、rename/delete、完整 diff、skip/todo/only 与断言弱化 | 当前基线 diff 为空，不代表最终 candidate |
| STD-602-10 commit hygiene | 审计 candidate tree/diff 中 runtime、evidence、credential 类文件；运行后两个 worktree须 clean | 未运行 |

### B.2 refs 与静态观察

调查时只读命令：

```sh
git rev-parse HEAD
git rev-parse main
git rev-parse origin/main
git reflog -1 --format='%H %gs %cI' refs/remotes/origin/main
git merge-base HEAD origin/main
git merge-base --is-ancestor origin/main HEAD
git status --porcelain=v1 --untracked-files=all
```

观察：

| 名称 | SHA / 结果 |
|---|---|
| `HEAD` | `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` |
| `main` | `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` |
| 本地 `origin/main` | `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` |
| 本地 merge-base | 同一 SHA |
| ancestor check | exit 0 |
| remote-tracking reflog | `fetch origin main: fast-forward`, `2026-07-29T16:40:40+09:00` |
| 工作区 | 非 clean：含 RFC/v3 文档移动与大量未跟踪调查材料 |

这组结果只确认任务给定基线和最后一次本地 fetch 的对应关系。由于未 fetch，不能声称 remote server 的 `main` 仍是该 SHA；由于最终 candidate 未产生，也不能把该 SHA 当最终 immutable candidate。

### B.3 命令入口、输入、产物与副作用

#### 依赖与 typecheck/unit

| 命令 | 输入/依赖 | 主要产物与副作用 | 证据 |
|---|---|---|---|
| `bun install --frozen-lockfile` | `package.json`、`bun.lock`、Bun/network/cache | 安装/校正 checkout 的 `node_modules`; frozen 模式不得更新 lockfile；可能使用/写 Bun cache | `package.json:14-21`; `bun.lock` 存在 |
| `bun run typecheck` | installed TypeScript 与源码 | `tsc --noEmit`，无编译产物；stdout/stderr/exit | `package.json:8-10` |
| `bun test` | Bun 1.3.14 调查环境、`bunfig.toml` preload、默认测试发现 | 测试自身可创建 fixture/runtime；stdout/stderr/exit | `bunfig.toml:1-2`; `tests/preload.ts:1-32` |

`tests/preload.ts` 删除 `LOOP_RUN_CREDENTIAL_ENV`，并代理 Bun spawn/spawnSync 使未显式传 env 的子进程继承清理后的测试环境（`tests/preload.ts:1-32`）。这是可保留的 credential 隔离资产，但不能替代 post-run credential 文件审计。

#### 分层 test runner（仓库真实存在，但非 STD-602-9/10 原文新增要求）

- batch 固定为 unit → integration-cli → integration-scheduler → integration-daemon（`scripts/run-tests.ts:7-9,48-53`）。
- integration 按每个 `*.integration.ts` 文件串行执行，单文件 timeout 30000ms；任一失败 fail-fast（`scripts/run-tests.ts:231-237,280-327,351-365`）。
- 含 integration 的调用必须传 `--log-file`；默认后台，`--foreground` 才使命令 exit 与本次执行同步（`scripts/run-tests.ts:85-91,508-519`）。
- logged run 写 `<repo>/.test-runs/<runId>/state.json`，日志写调用者指定路径，并以 `FINAL exit=N` 收尾（`scripts/run-tests.ts:372-400,452-505`）。

如果另有标准明确点名完整 local suite，可复现形式为：

```sh
bun run test:all -- --log-file "$LOG_ROOT/test-all.log" --foreground
```

不应在 candidate/base 双侧把默认后台启动的 exit 0 当作测试通过；必须前台执行或轮询 `.test-runs` 到终态。

#### engine integration

可执行命令：

```sh
bun scripts/engine-integration.ts \
  --log-file "$LOG_ROOT/engine-integration.log" \
  --foreground
```

- `--log-file` 必填；缺失 exit 2；默认后台，`--foreground` 才同步返回最终 exit（`scripts/engine-integration.ts:16-21,39-91,595-605`）。
- 清除 `CODER_LOOP_RUN_CRED`、`CODER_LOOP_DATA_DIR` 和 harness 后台标记，再派生子进程（`scripts/engine-integration.ts:118-141`）。
- 在 `<checkout>/.coder-loop/runtime/engine-integration/<uuid>` 创建本地 git fixture、CLI shim、隔离 daemon/SQLite/loop-data 和 closure worktrees（`scripts/engine-integration.ts:31-39,146-202,469-477`）。
- 真实启动当前 checkout 的 daemon，但 runner 是确定性 `claude` stub；无 GitHub、LLM、网络，因此它证明进程级引擎路径，不证明 HAPI 真实业务 E2E（`scripts/engine-integration.ts:3-21,167-183`）。
- 断言 phases、status admission、fixture commit、closure consumption/worktree recycle、无匹配本轮 loop-data 的 orphan（`scripts/engine-integration.ts:368-452,503-519`）。
- exit 0 且未 `--keep-work-dir` 时删除 workDir；失败保留诊断目录；无论成功失败尝试停止 daemon/kill orphan（`scripts/engine-integration.ts:221-257,521-533`）。
- 日志由调用者保留，正常以 `FINAL exit=N` 收尾（`scripts/engine-integration.ts:568-592`）。

### B.4 测试同错与环境限制

1. **focused fake 同错：** R7-10 的输入账目已明确 focused fake tests 不等于 candidate/base gate。engine-integration 也使用 stub runner，不能证明真实 external-terminal；只能用于 STD-602-9 的本地引擎回归补充。
2. **双侧同错：** candidate 与 BASE 同样失败时，只有命令、Bun/git/OS、环境变量、依赖获取条件一致，才可归为 baseline/environment signal；不能因此宣布 candidate 合格。两侧都通过才满足 STD-602-10 的测试部分。
3. **当前工作区污染：** 根工作区非 clean，不适合成为任一 gate checkout；其中未跟踪 RFC 材料也会使“post-run clean”不可判定。
4. **remote 时效：** 本地 remote-tracking ref 比调查日旧；禁止 fetch 使 live merge-base 静态不可判定。
5. **平台依赖：** engine harness 使用 `pgrep`、Unix signals/process groups、git worktree 与 Unix shell shim。调查环境为 Darwin arm64、Bun `1.3.14`、Git `2.55.0`；正式日志必须记录实际执行环境，不可假设跨平台等价。
6. **install 网络/cache：** 双侧必须在同一宿主与相同 cache/network policy 下执行；一侧依赖获取失败不能归为代码回归。

### B.5 diff 与卫生审计边界

冻结后必须保存以下完整输出，而不是只保存 grep 命中：

```sh
git diff --name-status --find-renames "$BASE..$CANDIDATE" -- tests scripts package.json bun.lock bunfig.toml
git diff --find-renames "$BASE..$CANDIDATE" -- tests scripts package.json bun.lock bunfig.toml
git diff --check "$BASE..$CANDIDATE"
git ls-tree -r --name-only "$CANDIDATE"
```

人工逐项核对：

- test 删除、重命名是否丢失覆盖；
- 新增 `.skip` / `.todo` / `.only`，或既有 assertion、失败路径、timeout、fixture 被弱化；
- runner regression tests 是否仍实际被 `bun test` 或点名 gate发现，不能仅因文件存在就算覆盖；
- candidate diff/tree 是否提交 `.coder-loop/`、`.test-runs/`、日志、SQLite/socket/pid、evidence dump、credential/token/env 文件；
- candidate/base 运行结束后各自 `git status --porcelain=v1 --untracked-files=all` 为空；若工具必然生成 ignored runtime，还要显式检查并清理，不能只靠 status。

文件名模式或 secret scanner 只能作线索；“无 credential 进入 commit”仍需对新增/修改文件的实际内容和用途审计。不得把真实 secret 输出进报告或日志。

### B.6 候选冻结后的可复现实验

以下是实验要求，不是在本调查中已执行的命令：

1. **冻结 refs（先 fetch，后记录，不得漂移）：**

   ```sh
   git fetch origin main
   CANDIDATE=$(git rev-parse '<frozen-candidate-ref>^{commit}')
   ORIGIN_MAIN=$(git rev-parse 'refs/remotes/origin/main^{commit}')
   BASE=$(git merge-base "$CANDIDATE" "$ORIGIN_MAIN")
   git merge-base --is-ancestor "$ORIGIN_MAIN" "$CANDIDATE"
   printf 'candidate=%s\norigin_main=%s\nbase=%s\n' "$CANDIDATE" "$ORIGIN_MAIN" "$BASE"
   ```

   ancestor check 非 0 时停止：candidate 不包含 live `origin/main`，不能继续用旧 base 粉饰。

2. **创建两个 clean detached worktrees**（路径由执行环境选择；本调查不创建），分别 checkout 精确 `$CANDIDATE` 与 `$BASE`。创建后保存 `git rev-parse HEAD` 和空的 porcelain status。
3. **记录共同环境：** `uname -a`、`bun --version`、`git --version`，以及不会泄露值的相关 env 名称清单。两侧使用同宿主、同 shell、同命令、相同依赖/cache/network policy。
4. **BASE gate：**

   ```sh
   bun install --frozen-lockfile
   bun test
   ```

   保存完整 stdout/stderr/exit 与 post-run hygiene。
5. **candidate STD-602-10 gate：** 同样运行 install + `bun test`，保存相同证据。
6. **candidate STD-602-9 补充：**

   ```sh
   bun run typecheck
   bun scripts/engine-integration.ts --log-file "$LOG_ROOT/candidate-engine-integration.log" --foreground
   ```

   `bun test` 可复用第 5 步同一 candidate 结果；必须核对日志尾部 `FINAL exit=0`、内部 evidence 和失败诊断目录。
7. **审计 `$BASE..$CANDIDATE` 完整 test/config/script diff**，按 B.5 逐项签出结果；不得只跑自动 grep。
8. **teardown 与残留检查：** 停止本实验所有子进程，检查两个 checkout 的 git status、git worktree 注册、`.coder-loop/runtime/engine-integration`、`.test-runs`、指定日志目录和按 loop-data path 匹配的进程。日志/evidence 放在 checkout 外；确认无 credential/runtime/evidence 文件进入 candidate tree。
9. **归因矩阵：**

   | BASE | candidate | 允许结论 |
   |---|---|---|
   | pass | pass | 该 gate 无 candidate 回归；仍需 diff/卫生通过 |
   | pass | fail | candidate regression 信号，回到拥有该契约的实现单元 |
   | fail | fail（同症状） | baseline/environment signal；RFC gate 未通过，不修饰为 candidate pass |
   | fail | pass | candidate 可能修复 baseline；核对环境一致与 diff 后记录，不能反推所有 runner 语义已证明 |
   | 任一环境失败 | 任意 | 结果不可归因；修复实验环境后双侧重跑 |

不运行 `scripts/real-e2e.ts`：STD-602-9/10 是本地 runner regression / 完整性卫生，且 RFC 验证边界明确本地 gates 不替代真实 HAPI E2E；同样也不应用 GitHub real E2E替代这里的双基线。

### B.7 证据索引

| 证据 | 位置 |
|---|---|
| R7-10 问题、必须事实、实验边界 | `investigation-index.md:127-137` |
| STD-602-9/10 原文 | `AGG-548.md:274-275` |
| RFC 验证边界 | `AGG-548.md:245-250` |
| package scripts/dependencies | `package.json:8-21` |
| Bun preload | `bunfig.toml:1-2`; `tests/preload.ts:1-32` |
| test batch 定义与发现 | `scripts/run-tests.ts:5-9,48-53,231-237` |
| test 执行、fail-fast、输出 | `scripts/run-tests.ts:264-327,351-365` |
| test run logs/state/foreground | `scripts/run-tests.ts:372-400,452-519` |
| engine CLI contract | `scripts/engine-integration.ts:16-21,31-39,50-91,595-605` |
| engine 隔离与 fixture | `scripts/engine-integration.ts:118-202,469-477` |
| engine assertions/cleanup | `scripts/engine-integration.ts:221-257,368-452,503-533` |
| engine final log | `scripts/engine-integration.ts:568-592` |

