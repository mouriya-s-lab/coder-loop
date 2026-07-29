# CLAUDE.md

面向在本仓库工作的 agent。项目形态、机制、CLI 细节的详细说明分散在 `docs/`，本页只钉住"改代码前必须知道的东西"。

## Project

coder-loop 是项目无关的 N-phase 字符串调度引擎。给定一个 preset（phase 列表、状态词表、prompt 与变量绑定），中央 daemon 按 preset 描述的顺序在 chain × item 上 spawn agent，捕获 trace，按 agent 写回的 item.status 推进队列，直到所有 item 落 terminal 状态。引擎不知道 phase 数量、phase 名字、status 字面量、item id 字段、GitHub。判断（issue 是否完成、PR 是否正确、证据是否充分）全部在 preset 的 agent prompt 里。

内置 preset：

- `gh-issue-pr-iteration` — 生产使用的 GitHub issue/PR 迭代 preset，四个 phase（`iteration` / `review` / `blocked-responder` / `umbrella-finalizer`）。设计思路在 `presets/gh-issue-pr-iteration/DESIGN.md`，fragment 跳转在 `docs/gh-issue-pr-iteration-fragments.md`。
- `engine-integration` — 两 phase 的本地引擎集成验收 preset，`scripts/engine-integration.ts` 专用（确定性 stub runner，无 GitHub / LLM）。
- `real-e2e-minimal` — 两 phase 的最小真实 GitHub loop，`scripts/real-e2e.ts` 默认走这个。
- `single-phase-example` — 一 phase / 字符串 id / 双状态的最小示例。
- `business-key-example` — 演示 `[runtime].businessKeys` 声明位。

## Architecture

代码实然形态见 `docs/architecture-v2.md`（daemon + chain + scheduler + SQLite），历史演变主线（机制归引擎、参数归 preset）见 `docs/architecture-v1.md` 第四节。三层职责边界：

| 层 | 知道 | 不知道 |
|---|---|---|
| L1 引擎 (`src/loop.ts`、`src/daemon.ts`、`src/scheduler.ts`、`src/sqlite-state.ts`) | 怎么加载 preset、按 phase 顺序 spawn / resume、写 SQLite、跨 chain 调度、孤儿回收 | phase 数量与名字、status 字面量、item id 字段、已知变量 KEY、GitHub |
| L2 preset (`presets/<name>/`) | phase 顺序、状态词表与转移、角色 prompt、chain-action exits、post-review trigger DAG | target 项目命令、CI 配置、PR 模板细节 |
| target | 项目命令、CI-parity 规则、PR/evidence/review 具体形式 | 引擎调度、其他 preset |

engine-owned `runtime.*` fact 清单、preset-declared runtime business key、`[[phases]]` / `[[fragments]]` / `[item.fields]` 全部字段语义见 `docs/preset-authoring.md`。Engine runtime fact key count: 26.（`tests/unit/loop/runtime-bindings.test.ts` 用此计数守护 CLAUDE.md / `docs/preset-authoring.md` 与 `ENGINE_RUNTIME_BINDING_KEYS` 三处对齐；新增 engine runtime fact 时同步改本计数与 `docs/preset-authoring.md` 内嵌列表。）

## Commands

Root usage（源：`src/loop.ts:2684 rootUsage`）：

```
coder-loop status  <target> --json
coder-loop logs    <target> --json [--kind K] [--type T] [--chain C] [--item ID] [--run RUN_ID] [--phase P] [--since TS] [--follow]
coder-loop daemon  <up|down|status|start|stop|restart>
coder-loop chain   <create|list|status|stop|resume|delete|set-runner-model>
coder-loop item    <add|batch-add|list|update|reorder|exits|exit-action>
coder-loop queue   unblock <target> --issue <issue>
coder-loop doctor  <target>
```

`item exits` / `item exit-action` 是 agent 面（`--agent-run-id` / `--agent-phase` 必填），不是 operator 面。operator 常用运维流程见 `docs/operations.md`。

开发工作面：

- **Type check**: `bun run typecheck`
- **Unit / component tests**: `bun test` / `bun run test:unit`（统一位于 `tests/unit/**`；不得启动 coder-loop daemon、runner workflow 或 worktree 生命周期）
- **Local integration suites**: `bun run test:integration -- --log-file <path>`（依次运行 `tests/integration/cli/`、`scheduler/`、`daemon/`，每个目录内的 `*.integration.ts` 逐文件串行；`--log-file` 必填，默认 detached 后台运行，追加 `--foreground` 可阻塞前台运行）
- **All local test layers**: `bun run test:all -- --log-file <path>`（按 unit → integration-cli → integration-scheduler → integration-daemon fail-fast；`--log-file` 必填，默认 detached 后台运行，追加 `--foreground` 可阻塞前台运行）
- **Single batch / status**: `bun scripts/run-tests.ts --batch <name> --log-file <path>` 默认后台运行；integration 批必须传日志路径，纯 `--batch unit` 可省略日志并保持前台透传。用 `bun scripts/run-tests.ts --status [runId]` 查看 `.test-runs/` 中的进度。目录准入规则见 `docs/test-boundaries.md`。
- **Shared Bun test preload**: `tests/preload.ts`（由 `bunfig.toml` 加载）
- **Engine integration（进程级引擎集成验收）**: `bun scripts/engine-integration.ts --log-file <path> [flags]` — `--log-file` 必填，默认 detached 后台运行，追加 `--foreground` 可阻塞前台运行。本地 git fixture + 隔离 daemon（`--loop-data-root`，绝不碰生产 `~/.coder-loop`）→ chain create + item add → 引擎按 preset phase 顺序真实 spawn 确定性 stub runner（PATH shim 把 `claude` 解析到 `scripts/engine-integration-stub-runner.ts`）→ iteration 在 slot worktree 真实 commit → review 经 daemon socket 凭据准入写终态 → 断言 SQLite runs / `item.status.write_admission` 审计 / worktree 回收 / 无孤儿 → teardown。无 GitHub、无 LLM、无网络，单次 60 秒内，多实例可并发（issue #681）。**这不是 e2e**：runner 被确定性 stub 替换、业务负载是合成的，它只证明引擎的真实进程面（daemon/socket/spawn/准入/worktree/SQLite），不证明真实 agent 在真实 target 上的业务结果。runbook 见 `docs/engine-integration.md`。
- **Real e2e（真实 runner + GitHub 终态）**: `bun scripts/real-e2e.ts --log-file <path> [flags]` — `--log-file` 必填，默认 detached 后台运行，追加 `--foreground` 可阻塞前台运行。在私有 fixture repo seed 真实 issue，跑真实 runner 完成 branch / PR / review / merge / issue closure，再断言 GitHub 与 default branch 终态。默认 `real-e2e-minimal`；`--preset gh-issue-pr-iteration` 跑全保真。每轮以 UUID 隔离 fixture / checkout / chain / loop-data，不持有完整生命周期并发锁。runbook 见 `docs/real-e2e-fixture.md`。

### Issue 验证边界、整链路 integration 与 real E2E

每个 implementation issue 必须在正文的“本 issue 的验证边界”中明确本 issue 负责证明到哪一层：静态/单元、进程级 integration、真实服务或浏览器、跨系统。实现与 review 只执行该边界内的验证；不得因为改动触及 scheduler、daemon、runner、worktree、preset 或 terminal semantics，就自行把单 issue 验收升级为整个 v3 的整链路 integration 或现有 GitHub preset 的 real E2E。

每个 v3 issue 的该节还必须有一条命令级结论，禁止只写“由下游负责”或“不是 compatibility gate”等间接措辞：除专用 compatibility issue #685 外，逐字写明“本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行”；#685 则逐字写明“本 issue 必须运行 `bun scripts/real-e2e.ts --preset real-e2e-minimal` 与 `bun scripts/real-e2e.ts --preset gh-issue-pr-iteration`”。某 issue 即使需要 GUI、router 或 HAPI 的专用 E2E，也仍须先写清不运行 coder-loop 的这条 GitHub real E2E，再另列自己的专用路径。

默认单 issue gate 是 `bun run typecheck` + `bun test`，再加 issue 正文点名的最小专用 runtime/integration 场景。`bun scripts/engine-integration.ts` 只在该 issue 的改动实际经过其两阶段 stub-runner 路径、且正文把它列为验证项时运行；它不能替代未被该 fixture 覆盖的 v3 专用场景。单 issue 的验证必须直接触发并观察该 issue 新增的行为，不能以旧线性 preset 未回归冒充新行为已成立。

跨 issue 接缝、一个完整 v3 场景和现有 bundled preset 兼容性分别由专用验收 issue 承担：

- **整链路 integration issue**：在冻结的合流 SHA 上运行 v3 专用 preset/fixture，连接 compile、task tree、scheduler、gate、context、ingress、status/events 与 GUI 等已经进入该 checkpoint 的生产者/消费者；失败回到具体 implementation issue 修复。
- **Compatibility real E2E issue**：在发布候选 SHA 上运行 `bun scripts/real-e2e.ts`；默认 `real-e2e-minimal`，直接改动 `gh-issue-pr-iteration` 或进行 v3 最终收尾时再跑 `--preset gh-issue-pr-iteration`。它证明真实 runner + GitHub PR / merge / issue closure 这条现有生产 preset 路径仍成立，不证明 v3 新语义本身。

只有 issue 正文明确把某条真实外部路径定义为本 issue 的交付物时，该 issue 才运行自己的专用 E2E，例如 GUI 浏览器路径、GitHub router→消费 daemon→coder-loop、HAPI remote session；这些专用 E2E 不得被 `scripts/real-e2e.ts` 代替。实现 issue 的中间 commit/retry 不重复跑整链路验收；专用验收 issue 在依赖的 implementation issues 合流后运行一次。

## Runner selection

Runner 与 model 声明在 preset per-phase，item 可选择性覆盖。

```toml
[[phases]]
name  = "review"
runner = "claude"       # "claude" | "codex" | "opencode"
model  = "claude-opus-4-7"
```

- Phase runner 未声明时走 engine-builtin fallback（当前 `codex`）。
- Item 上的 `--runner` 只覆盖非 trigger phase（`gh-issue-pr-iteration` 中是 `iteration` 与 `review`；`blocked-responder` / `umbrella-finalizer` 是 trigger phase，不受 item override 影响）。
- Runner binary 是 PATH 上的 `claude` / `codex` / `opencode`；模型来自 phase 的 `model`。
- Chain 级 model 覆盖走 `coder-loop chain set-runner-model <chain> --kind <k> --model <m>`（patch `chain.metadata.<kind>.model`）。
- `coder-loop status <target> --json` 暴露 `target.runner.phases.<phase>`、`queue.selected.phaseRunners.<phase>`、`current.runner`、`current.phaseStatus.value.runner/model` — 这是 runner/model 的唯一稳定读面。agent 每个 phase 的 `status.json` 位于 `<logDir>/<runId>/<phase>/status.json`，只作 fallback debug。

## Preset 与 target starter

preset 层配套的 target-side starter 在 `presets/<name>/templates/`。跨 preset 通用的 supervisor starter（cron 驱动跨 patrol orchestration）在 `templates/supervisor/`。项目命令 / PR 约定由 target 自有的 `CLAUDE.md` / `AGENTS.md` 承载，preset prompt 显式读取这两份文件。写新 preset 的最小流程见 `docs/preset-authoring.md`。

## Tech stack

Bun + TypeScript (strict, ESM)。runtime 依赖是 PATH 上的 CLI：`gh` + 每个 phase 声明的 runner CLI（`claude` / `codex` / `opencode`）。

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`。
- 跨 repo commit body 引用：`Closes owner/repo#N`。
- 引擎层禁止任何 preset 字面量（status 字符串、phase 名、`{{REPO}}` 等已知 KEY、GitHub-specific 字段名）。新增引擎代码触碰这些时一律改成读 preset。
