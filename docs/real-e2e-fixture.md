# Real e2e fixture & harness

真实 e2e 用一个真实的私有 GitHub repo 验证 coder-loop 的完整路径：已完整接线的真实
runner（`claude` / `codex` / `opencode` CLI）跑 iteration → review，产出真实 branch / PR /
review / merge / issue closure。`hapi` 当前只进入通用 runner 词表、availability probe 与 generic
spawn seam；真实 prompt / worktree / status / session 接线归 #603，在其落地前不属于本 harness
声明的完整 runner 路径。它故意不是单元测试：要抓的是 runner sandbox 行为、
session resume、`gh` 交互、跨 phase 状态推进这类只在真实运行中暴露的集成失败。

mock / stub / fake 不能证明真实 GitHub issue/PR 路径；但 real E2E 是阶段性收尾门，
不是每次修改的日常 gate。普通 bug 修复与迭代中途先走完整 integration gate，只有下文
“何时跑”列出的时机才要求 real E2E。

## Fixture

- Repository: `mouriya-s-lab/coder-loop-e2e-fixture`（PRIVATE）
- 本地 source checkout: `/Users/mouriya/Ext/code/coder-loop-e2e-fixture`（只用于校验 origin；harness 不修改它）
- 可达性检查:

```bash
gh repo view mouriya-s-lab/coder-loop-e2e-fixture --json nameWithOwner,visibility
```

fixture repo 只保留极小的提交资产。各 run 在 default branch 上只拥有自己的
`runs/<uuid>.txt`，不会共用或 reset 同一个目标文件：

- `message.txt` — 单行任务目标文件（pristine 态为 `status: pending`）；
- `scripts/check-message.mjs` — 真实 check（`bun run check`），PR 证据用它；
- `CLAUDE.md` / `AGENTS.md` — target bootstrap 契约（agent 指令文件承载项目命令 / PR 约定）；
- 运行态（`.coder-loop/`）不入库。

## Harness：单命令全流程

入口是本 repo 的 `scripts/real-e2e.ts`：

```bash
bun scripts/real-e2e.ts --log-file /tmp/coder-loop-real-e2e.log
```

`--log-file` 必填。相对路径按启动命令的 cwd 解析，父目录会自动创建；每次运行都会
truncate 后重写该文件。默认模式 detached 到后台，父进程只打印子进程 pid 和日志绝对
路径后立即成功退出。需要阻塞等待真实结果与真实退出码时使用 foreground：

```bash
bun scripts/real-e2e.ts --foreground --log-file /tmp/coder-loop-real-e2e.log
```

foreground 运行期间，脚本及其 gh、daemon、runner 等子进程输出全部进入日志，终端
stdout 只显示最终一行 `real-e2e exit=<code> log=<path>` 摘要。后台模式的启动行不能代表
测试成功；以子进程结束后日志末行的 `FINAL exit=<code>` 为准。

默认 preset 是 `real-e2e-minimal`（`presets/real-e2e-minimal/`）：两 phase 的最小
GitHub loop——iteration 直接改文件开 PR，review 验证 + merge + 写
`done`。e2e 的目的是验证引擎全链路（spawn、phase 推进、summary 捕获、真实
PR/merge、终态写入），不是 agent 编排质量，所以不默认走 `gh-issue-pr-iteration`
的 orchestrator（其单次 iteration 实测 ~16 分钟，最小 preset 每 phase 约 1-3 分
钟）。要做 bundled preset 的全保真验证时显式选它：

```bash
bun scripts/real-e2e.ts --log-file /tmp/coder-loop-real-e2e-full.log --preset gh-issue-pr-iteration
```

它按序做完一轮完整真实 e2e：

1. **preflight** — gh auth、preset 声明的 runner CLI（`claude` / `codex` / `opencode`）在 PATH、fixture repo 可达、本地 source checkout origin 一致。
2. **allocate** — 每轮生成 UUID，创建自己的 `runs/<uuid>.txt`（`status: pending`）并 clone 到 `.coder-loop/runtime/real-e2e/<uuid>/fixture`。每轮的 fixture path、checkout、chain 与 loop-data 都由 UUID 隔离；harness 不持有跨完整生命周期的并发锁。
3. **seed** — 脚本用 `gh issue create` 建一个契约合规且带 run UUID 的 trivial issue（`kind:code` + `e2e-seed` label）：只要求把本轮 `runs/<uuid>.txt` 改为 `status: complete`。
4. **run** — 在隔离 `--loop-data-root`（`.coder-loop/runtime/real-e2e/<uuid>/loop-data`）起中央 daemon（`daemon up`），以 UUID 唯一 chain name 对 default branch 执行 `chain create`，再 `item add` 入队。每个 PR 仍 merge 到 default branch，因此 GitHub closing keyword 会真实关闭对应 issue；生产 daemon（`~/.coder-loop`）和 source checkout完全不被触碰。
5. **watch + tripwire** — 轮询 `status <target> --json`，越界即自动 `daemon down` + 落诊断 + 非零退出：
   - `--max-wall-seconds`（默认 2700）
   - `--max-attempts`（默认 5）
   - `--max-runs`（默认 20，短周期 spin 的信号）
6. **assert** — item 到 `done` 后验证 GitHub 终态：seed issue CLOSED、closing PR MERGED、default branch 上本轮 `runs/<uuid>.txt == status: complete`，并以真实 Bun 读取执行检查。
7. **teardown + evidence** — `daemon down` 后通过 Contents API 只删除本轮 `runs/<uuid>.txt`；失败时只关闭 body 第一行精确 `Closes #<本轮 issue>` 的本轮 open PR 与本轮 seed，不碰其他 run。日志输出 evidence 摘要（issue URL、PR URL、merge commit、耗时、loop-data 路径），末行固定为 `FINAL exit=<code>`。

失败路径（终态 `blocked` / `moot` / `exhausted`、tripwire、`chain create` 失败）都会向
指定日志写入 loop-data root、统一 daemon log 路径和最后一次 status snapshot，然后以
非零码结束。

### Flags

| Flag | 默认 | 含义 |
|---|---|---|
| `--log-file` | 无（必填） | 统一日志文件；相对 cwd 解析，自动建父目录，每次 truncate |
| `--foreground` | 否（后台） | 阻塞运行，终端只输出最终摘要并返回真实结果 |
| `--fixture-cwd` | `../coder-loop-e2e-fixture` | fixture source checkout（只读 origin 来源与身份校验） |
| `--fixture-repo` | `mouriya-s-lab/coder-loop-e2e-fixture` | fixture GitHub repo |
| `--preset` | `real-e2e-minimal` | 跑哪个 preset（全保真用 `gh-issue-pr-iteration`） |
| `--max-wall-seconds` | 2700 | 全程 wall-time 上界 |
| `--max-attempts` | 5 | item attempts 上界 |
| `--max-runs` | 20 | runs 表行数上界（spin 检测） |
| `--poll-seconds` | 15 | status 轮询间隔 |

## 何时跑

real E2E 不进每 commit 的 gate。日常默认门是 `bun run typecheck` + `bun test` +
`bun scripts/engine-integration.ts`；普通 bug 修复、迭代中途的 commit / retry、没有改变
调度或 preset 语义的局部修改，integration gate 通过即可。

只在这些时机跑 real E2E：

- 大型改动完成、准备收尾或合并；
- 修正 bundled preset 的 phase、prompt、status、transition、runner/model 或加载语义；
- 改动 scheduler / daemon / runner spawn、worktree、status/phase 推进、终止、resume、admission、terminal semantics 等引擎机制；
- 发版 / 同步到 app 前；
- 排查或复验只在真实 runner / GitHub 路径中出现的问题。

默认跑 `real-e2e-minimal`。只有修改 `gh-issue-pr-iteration` 本身或大型编排行为时才显式
使用 `--preset gh-issue-pr-iteration`；迭代中途不为每个修正重复运行，先用 integration
gate 收敛，满足上述收尾条件时跑一次。

## Runner 覆盖

phase runner/model 默认值来自 `preset.toml`。bundled `gh-issue-pr-iteration` 四个 phase 目前都声明 `runner = "codex"`、`model = "gpt-5.6-sol"`；`real-e2e-minimal` iteration/review 都声明 `runner = "codex"` + `model = "gpt-5.6-terra"`。要针对某次 chain 覆盖 model：`coder-loop chain set-runner-model <chain> --kind <k> --model <m>`。要覆盖某个 item 的执行 runner（限非 trigger phase）：`coder-loop item add --runner claude|codex|opencode|hapi`。要改 codex 的 CLI extraArgs（如 sandbox），改 chain metadata 的 `codex.extraArgs` binding；引擎在 spawn 时会补 `--sandbox danger-full-access` 若 extraArgs 没提供任何 `--sandbox`——read-only / workspace-write 会阻断 workspace 写入与 `gh` 网络访问，要覆盖显式在 `codex.extraArgs` 提供。

## Known pitfalls

- target repo 必须有 `CLAUDE.md`：`gh-issue-pr-iteration` iteration / review 调度者的 Step 0 契约读取把它当项目参照。
- `codex exec resume` 不接受 `--sandbox`，sandbox 默认值只作用于 fresh `codex exec`。
- 中央 daemon 的活性判据是 socket 上有进程监听；`daemon.sock` / `daemon.pid`
  文件存在 ≠ daemon 在跑（陈尸文件），见 `.claude/rules/daemon-restart-after-app-update.rule.md`。
- 每轮拥有独立 fixture path、clone、chain、loop-data 与 seed issue。teardown 只能按本轮 issue 的
  closing 契约清理本轮资源；如果看到 harness 关闭了别轮 PR/issue，这是隔离回归。
