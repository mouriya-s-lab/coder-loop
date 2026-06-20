# Real e2e fixture & harness

真实 e2e 用一个真实的私有 GitHub repo 验证 coder-loop 的完整路径：真实 runner
（claude / codex CLI）跑 iteration → review，产出真实 branch / PR / review /
merge / issue closure。它故意不是单元测试：要抓的是 runner sandbox 行为、
session resume、`gh` 交互、跨 phase 状态推进这类只在真实运行中暴露的集成失败
（实证：#94 sandbox 阻断、#309 八项缺陷链，全部是 fake/unit 全绿时真实跑出来的）。

不用任何 mock / stub / fake 替代真实 GitHub issue/PR 路径（#90 约束）。

## Fixture

- Repository: `mouriya-s-lab/coder-loop-e2e-fixture`（PRIVATE）
- 本地 checkout: `/Users/mouriya/Ext/code/coder-loop-e2e-fixture`
- 可达性检查:

```bash
gh repo view mouriya-s-lab/coder-loop-e2e-fixture --json nameWithOwner,visibility
```

fixture repo 只保留极小的提交资产：

- `message.txt` — 单行任务目标文件（pristine 态为 `status: pending`）；
- `scripts/check-message.mjs` — 真实 check（`bun run check`），PR 证据用它；
- `CLAUDE.md` / `AGENTS.md` — target bootstrap 契约（自 #434 起 `.coder-loop/workflow.md` 退役；fixture 通过这两份 agent 指令文件提供项目命令）；
- 运行态（`.coder-loop/runtime/`）不入库。

## Harness：单命令全流程

入口是本 repo 的 `scripts/real-e2e.ts`：

```bash
bun scripts/real-e2e.ts
```

默认 preset 是 `real-e2e-minimal`（`presets/real-e2e-minimal/`）：两 phase 的最小
GitHub loop——iteration 单发 codex 直接改文件开 PR，review 验证 + merge + 写
`done`。e2e 的目的是验证引擎全链路（spawn、phase 推进、summary 捕获、真实
PR/merge、终态写入），不是 agent 编排质量，所以不默认走 `gh-issue-pr-iteration`
的 orchestrator（其单次 iteration 实测 ~16 分钟，最小 preset 每 phase 约 1-3 分
钟）。要做 bundled preset 的全保真验证时显式选它：

```bash
bun scripts/real-e2e.ts --preset gh-issue-pr-iteration
```

它按序做完一轮完整真实 e2e：

1. **preflight** — gh auth、`codex` / `claude` 在 PATH、fixture repo 可达、本地 checkout origin 一致。
2. **reset** — fixture checkout 硬回 `origin/main`；关掉所有残留 open PR（fixture 专用于 e2e，open PR 一律视为上轮残留）；关掉残留的 `e2e-seed` label open issue；`message.txt` 不是 `status: pending` 时翻回并直接 push main。
3. **seed** — 脚本用 `gh issue create` 建一个契约合规的 trivial issue（`kind:code` + `e2e-seed` label）：把 `message.txt` 改为 `status: complete`。
4. **run** — 在隔离 `--loop-data-root`（`.coder-loop/runtime/real-e2e/<stamp>/loop-data`）起中央 daemon（`daemon up`），`install` bootstrap target + chain，`item add` 入队。生产 daemon（`~/.coder-loop`）完全不被触碰。
5. **watch + tripwire** — 轮询 `status <target> --json`，越界即自动 `daemon down` + 落诊断 + 非零退出：
   - `--max-wall-seconds`（默认 2700）
   - `--max-attempts`（默认 5）
   - `--max-runs`（默认 20，#309 式 1Hz spin 的信号）
6. **assert** — item 到 `done` 后验证 GitHub 终态：seed issue CLOSED、closing PR MERGED、fixture `origin/main` 上 `message.txt == status: complete`、真实 `bun run check` 通过。
7. **teardown + evidence** — `daemon down`，stdout 输出 evidence 摘要（issue URL、PR URL、merge commit、耗时、loop-data 路径）。

失败路径（终态 `blocked` / `moot` / `exhausted`、tripwire、install 失败）都会打印
loop-data root、daemon stdout/stderr log 路径和最后一次 status snapshot，然后
exit 1。

### Flags

| Flag | 默认 | 含义 |
|---|---|---|
| `--fixture-cwd` | `../coder-loop-e2e-fixture` | fixture 本地 checkout |
| `--fixture-repo` | `mouriya-s-lab/coder-loop-e2e-fixture` | fixture GitHub repo |
| `--preset` | `real-e2e-minimal` | 跑哪个 preset（全保真用 `gh-issue-pr-iteration`） |
| `--max-wall-seconds` | 2700 | 全程 wall-time 上界 |
| `--max-attempts` | 5 | item attempts 上界 |
| `--max-runs` | 20 | runs 表行数上界（spin 检测） |
| `--poll-seconds` | 15 | status 轮询间隔 |

## 何时跑

真实 e2e 不进每 commit 的 gate（`bun test` 是日常 gate）。在这些时机跑：

- 动 scheduler / daemon / runner spawn / preset prompt 的 PR 验收（#309 共享契约：
  「真 chain + 真 item 的 e2e fixture 跑通才构成 acceptance」）；
- 发版 / 同步到 app 之前；
- 排查只在真实运行中复现的问题。

## Runner 覆盖

phase runner/model 默认值来自 `preset.toml`：bundled `gh-issue-pr-iteration` 的
iteration 与 review 都声明 `codex`（review 另声明 `model = "gpt-5.5"`）。Codex
fresh 执行默认 `--sandbox danger-full-access`（#94：read-only / workspace-write
会阻断 workspace 写入与 `gh` 网络访问）；要覆盖用 target config 的
`codex.extraArgs`。

要用 Claude runner 覆盖某次运行：在 seed item 上设 `"runner": "claude"`（目前
harness 不暴露该 flag，需要手动 `item add --runner claude`），或改 target config。

## Known pitfalls

- target repo 必须有 `CLAUDE.md`：preset 的 read-context / review fragments 把它当项目参照。
- `codex exec resume` 不接受 `--sandbox`，sandbox 默认值只作用于 fresh `codex exec`。
- 中央 daemon 的活性判据是 socket 上有进程监听；`daemon.sock` / `daemon.pid`
  文件存在 ≠ daemon 在跑（陈尸文件），见 `.claude/rules/daemon-restart-after-app-update.rule.md`。
- harness 的 reset 会关掉 fixture repo 里**所有** open PR；不要在 fixture repo 上
  留任何想保住的 open PR。
