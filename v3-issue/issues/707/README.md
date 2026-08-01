# #707 feat(presets): bundled preset 闭包 Git 契约迁移

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:35Z  | updated: 2026-07-27T01:20:10Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/707
- comments: 1  | timeline events: 12

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

在 closure、chain tree、phase tree 均可达后迁移 bundled preset；PR headRef 只在本 child 验收，不能反向成为 C02 的前置。

把 bundled preset（`gh-issue-pr-iteration`、`real-e2e-minimal`）的 git 契约迁移到闭包模型：agent 不再自建工作分支，在引擎递出的闭包分支上工作；retry/打回重入 prompt 按闭包重开形态改写（现场由引擎保证，不再靠 agent 侦查残留）；preset 内制度性指示的 agent 结构性 git 操作（standing worktree、spike 分支、scratch worktree）逐处裁决 v3 兼容形态。

## 预期结果

- 两个 bundled preset 中 agent 自建**工作**分支的指示为零；agent 契约全部表述为「在引擎递出的闭包分支上 commit/解决冲突/push/开 PR」。
- retry/打回重入 prompt 按闭包重开形态改写：消费「环境原地保留、从未被动过」保证，不再指示按残留侦查重建认知。
- 上下文清单 4-8 的结论已在本 body 固定：spike 用闭包分支；e2e 用自己的闭包 worktree；基线测量用 base SHA archive 到闭包私有 scratch；远端 merge 可删远端闭包分支，本地回收只归引擎；submit retry 在同一闭包分支/PR 上继续。
- `item.branch` 的 agent 写回义务退役；`ISSUE_BRANCH` 直接绑定 #699 暴露的 engine-owned closure branch runtime fact。preset 不再把分支名列入 agent `writableFields`。
- preset 内依赖稳定输入的 Git 比较只使用保存的 base SHA/par pin；依赖当前远端状态的判断显式消费带新鲜度的 `origin/*`。repo config/hooks、他闭包 refs/pin 与 repo-wide GC/prune/worktree 管理零制度性指示。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| assumption | 自建工作分支指示为零 | `grep -rn "switch -c" presets/` | local | 工作分支创建零命中；无临时 ref 例外 |
| function | retry 重开形态 | e2e 触发 changes_requested 打回，观察第二轮 run 的 cwd/分支/PR | local | 同 worktree 路径、同分支、同 PR 第二轮 comment；prompt 无考古指示残留 |
| function | 结构性 Git 操作退役 | `rg -n "git (switch -c|worktree add|worktree remove|worktree prune|worktree repair)" presets/`，并检查 `ISSUE_BRANCH`/`writableFields` | local | agent 工作分支与 worktree 结构操作零制度性指示；spike/e2e/verify 分别采用 body 固定形态；branch 由 engine runtime fact 提供且不可由 agent 写回 |
| integration | 共享 Git 协调协议 | `rg -n "git (fetch|rebase|merge|worktree|config|gc|repack|prune)|origin/" presets/`，逐命中对照 #546/#699 合同；在全保真 e2e 的 retry/review 路径记录所用 base SHA/pin 与 origin 新鲜度 | local | 稳定比较只读保存 SHA/pin；当前远端判断有新鲜度；无 repo config/hooks、他闭包 refs/pin、破坏性 GC/prune/worktree 管理指示 |

## 依赖关系

- Depends on: #699、#705、#706；外部 #739。
- Blocks: #708、#709。



---

## Comments (1)

### comment #5055604263 by `RiriAgent` — 2026-07-23T07:23:42Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#707 承接 #604 bundled preset 闭包契约迁移）相对 baseline 的进度

- **已落地（部分底座）**: `presets/engine-integration/preset.toml` (+4/-) 与 `presets/engine-integration/review-entry.md` (+2/-) 已适配闭包生命周期语义（`engine-integration` preset 是引擎集成验收 preset，本 issue 主目标之外的边角）。
- **半成品**: 无。
- **未开始**（本 issue 主目标）:
  - `gh-issue-pr-iteration` 与 `real-e2e-minimal` preset 里 agent 自建工作分支的指示清零（`rg -n "switch -c" presets/` 应为零命中）
  - retry / 打回重入 prompt 按闭包重开形态改写（消费"环境原地保留、从未被动过"保证，不再让 agent 侦查残留重建认知）
  - `item.branch` 的 agent 写回义务退役
  - `ISSUE_BRANCH` 绑定 engine-owned closure branch runtime fact（来源于 #699 暴露的 closure branch）
  - preset `writableFields` 里 branch 移除
  - 结构性 Git 操作（`worktree add / remove / prune / repair`、`git switch -c`）零制度性指示

### 依赖

本 issue depends on **#699**（承接已在 baseline）+ **#705**（chain metadata 顶层 join、`ISSUE_BRANCH` 绑定源）+ **#706**（phase tree 展开）+ 外部 #554。

### iteration agent

从 baseline checkout，主要工作在 `presets/gh-issue-pr-iteration/` 与 `presets/real-e2e-minimal/`。PR base = `coder-loop/v3-546-baseline`。



---

## Timeline (12)

- 2026-07-17T20:13:36Z `assigned` @RiriAgent
- 2026-07-17T20:14:01Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:14:08Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:14:09Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:12Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-17T20:14:33Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:15:10Z `cross-referenced` @RiriAgentsrc=604
- 2026-07-23T07:23:42Z `commented` @RiriAgent
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-26T16:15:07Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-26T23:49:42Z `cross-referenced` @RiriAgentsrc=739