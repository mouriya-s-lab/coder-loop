# coder-loop templates

Supervisor 模式跟 preset 正交——它是包在 loop 外面的 cron-driven 跨 patrol orchestrator，跨 preset 通用。这一层现在唯一的 starter 在这里。

具体到「target 跑 coder-loop 需要哪些 starter」，那些已经按 preset 切分到 `presets/<preset-name>/templates/`（如 `presets/gh-issue-pr-iteration/templates/` 下的 `shared.md / pr-body.md`），不在本目录。详见仓库根 README 的「内置 preset：`gh-issue-pr-iteration`」一节。

## What coder-loop actually is

`coder-loop` 是 N 角色字符串调度引擎。它按 preset 描述的 phase 顺序 spawn agent、捕获 trace、推进队列。它不判断 item 是否完成、PR 是否正确、证据是否充分、parent 是否可关闭、queue 优先级、或任何 domain 问题。这些判断来自：

- preset 的 agent prompt（`presets/<preset-name>/`，bundled 默认是 `gh-issue-pr-iteration`）
- target 拷过去的 starter 与项目级 policy（具体形式由 preset 决定）
- live 第三方 state（GitHub issue/PR、CI 状态、SSH 日志等，由 preset 的 agent 决定要不要读）

## Available templates

| Template | Copy to | Purpose |
|---|---|---|
| `templates/supervisor/` | `<TARGET>/.coder-loop/runtime/supervisor/<MISSION>/` + `<TARGET>/.claude/skills/bootstrap/SKILL.md` | optional 外层 supervisor（cron 驱动跨 patrol orchestration），跨 preset 通用 |

preset-specific starter 不在此处：

- `presets/gh-issue-pr-iteration/templates/` — `gh-issue-pr-iteration` preset 的 target-side starter（`shared.md / pr-body.md`）。项目命令 / PR 约定从 #434 起改由 target 自有的 `CLAUDE.md` / `AGENTS.md` 承载，不再有 `workflow.md` starter。
- 其他 preset 各自的 `templates/` 子目录

## Minimum viable target setup

新接入 target 三步（#436 起 install/uninstall 子命令退役，无一键包装；`doctor` 体检 operator 机器与 live runtime，详见 [docs/operator-quickstart.md §1](../docs/operator-quickstart.md#1-把新-target-接入中央-daemon)）：

1. Committed `<TARGET>/CLAUDE.md` 或 `<TARGET>/AGENTS.md`（项目命令、约定、PR 形态；`gh-issue-pr-iteration` preset 的 plan/intake 把这两份 agent 指令文件作为权威源读入）
2. `coder-loop chain create <chain> --repository <owner>/<repo> --preset <name>` 把 chain identity 写进中央 DB；`gh-issue-pr-iteration` 需要的 GitHub label 由该 preset 的 planning path 在首次创建 issue 前幂等确保（color / description 漂移则更新）
3. 本机 `gh` 授权对应 repository（仅当 preset 用 GitHub 时）

shared 与 PR-body starter 在 `gh-issue-pr-iteration` 下高度推荐但不阻塞 loop 启动。Supervisor 仅在长 multi-mission 工作下需要，短跑无需。
