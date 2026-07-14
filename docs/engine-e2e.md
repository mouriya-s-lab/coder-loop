# engine-e2e runbook

引擎全链路验收 harness（issue #681）。单命令、完全本地、确定性、秒级完成、可并发。

```
bun scripts/engine-e2e.ts [--max-wall-seconds N] [--max-runs N] [--poll-seconds N] [--keep-work-dir]
```

退出码：0 = 全链路成功且断言通过；1 = 失败 / tripwire / 断言失败（诊断材料保留在 work dir）。

## 它验证什么

引擎（L1）的真实出程路径——每一步都走生产同款机制，没有 mock：

| 环节 | 真实面 |
|---|---|
| daemon 生命周期 | `bun src/loop.ts daemon up/down --loop-data-root <隔离目录>`，真实 socket |
| chain / item 引导 | `chain create` + `item add` 走 CLI → daemon socket |
| phase 调度 | 引擎按 `presets/engine-e2e` 的 phase 数组顺序真实 `spawn` 子进程 runner |
| runner 解析 | PATH shim：`claude` → `scripts/engine-e2e-stub-runner.ts`（引擎既有的 PATH 解析面，无引擎特判） |
| worktree 生命周期 | iteration 在引擎创建的 slot worktree 里真实 `git commit`；chain 完成后断言回收 |
| status 准入 | review 用 `coder-loop item update --status` 经 daemon socket 凭据准入（#397 gate），断言 `item.status.write_admission` 审计事件 |
| session 捕获 | stub stdout 首行输出 stream-json `session_id`，走 `parseSessionIdFromStream` |
| SQLite 落盘 | 断言 runs 表含 iteration / review 两 phase 记录 |
| teardown | daemon down 有界收尾 + `pgrep -f <loopDataRoot>` 断言无孤儿 |

## 它不验证什么

preset 编排质量（agent 是否会正确解 issue、PR 是否合理）不是 e2e 的职责。
`gh-issue-pr-iteration` 的行为由其生产 dogfood loop 持续检验；引擎与 preset 的职责边界见
`CLAUDE.md` 三层表。

## 并发

harness 不持有任何跨运行共享资源：每轮生成 UUID work dir（`.coder-loop/runtime/engine-e2e/<uuid>`），
fixture 是本地新建 git repo，loop-data / daemon socket / chain 名全部 run 独占，无全局锁、
无 GitHub 资源域。任意多个实例可以同时运行（issue #681 并发前提）。

## tripwire

- `--max-wall-seconds`（默认 60）：超时判失败并保留诊断。
- `--max-runs`（默认 6）：runs 表行数超界 = spin 信号（如 review 反复打回 `changes_requested`）。

## 失败诊断

失败时 work dir 保留，evidence 区打印 loop-data root、daemon stdout/stderr 路径与
`status --json` 快照。stub runner 的 per-phase stdout/stderr 在
`<loopDataRoot>/chains/<chain>/runs/<runId>/<phase>/`。
