# #700 feat(engine): 共享 decision core 与 validator join

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:13:17Z  | updated: 2026-07-27T04:26:51Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/700
- comments: 1  | timeline events: 23

---

## Body

## 必须先读的关联 issue

继承 [#546](https://github.com/mouriya-s-lab/coder-loop/issues/546) 的任务代数、资源模型、供给条款、机制/参数分离和总关闭验证。

## 目标

交付 drain/validator 的 evaluation、advance/hold admission 与共享 decision journal；reopen 只形成已验证 decision，控制流效果归 C04。

par 容器的 validator 判定通道：汇合时 spawn 验证者 leaf、判定经 CLI 写回准入门；hold 使容器退避重问；失败终态归 join 消化。（drain 的结构性放行已随 #698（树调度）落地——全成员 terminal 即容器 terminal；本 child 建的是「需要判定」的那半边，并保证 validator 机制不破坏 drain 语义。）

## 预期结果

- 性质：join=validator 的 par 容器，全部成员 terminal 时引擎 spawn 验证者 leaf（item+preset 调用声明取自容器 join 字段），容器保持不推进直到判定到达；join=drain 的容器维持 #698（树调度）落地的结构性放行，validator 机制的引入不给它加任何判定等待或失败特殊分支。
- 验证者判定经 CLI 写回：走 default-deny 准入门（判定词表由 preset 声明；无授权主体/词表外值被拒并留审计事件）；引擎零新增 stdout 解析。
- 三词派发：`advance` → 外层 seq 推进；`hold` → 容器不推进不退回、该决策点退避后重新评估（重问时 validator 重新裁决，可改判）、防抖归 #712；同一评估代次内 validator 崩溃重放的 mutation/decision 安全继承 #712（不重复 mutation、不丢或重复消费已持久化 decision）；`reopen(target, correctionItemIds)` → 校验精确 IDs 后转交 reopen 执行（#701）——其落地前引擎对 reopen 判定**显式拒绝**（错误信息点名未支持），不静默吞掉、不留半执行状态。
- join ADT 穷尽处置：本 child 落地时封闭 union 仅含 `drain | validator`、无占位 variant，全部消费点穷尽 switch、无 default 兜底吞掉；本轮 v3 的 #714 随后按 #547 variant 准入纪律把 `script` 连同全部处置点一次加入，`best-of-n` 仍是未来方向。
- 失败归 join：par 成员非 success 终态不自动传播——drain 照常放行；validator 的判定输入可见失败成员。
- **合并真相由 preset 判定器自查（供给条款 3）**：validator prompt / CLI 契约中，合并/发布等 GitHub 面事实的获取由验证者 leaf 自身经声明通道（`gh pr view` 等）读取，引擎不代查、不注入；validator 写回的三词判定即消费结论（`advance` = 合并/发布/满足；`hold` = 未收敛需重问；`reopen` = 需纠正）。
- **operator 一次性判定 override**：operator 对当前 epoch 经同一准入门显式写 decision——生效与消费语义同主体判定、独立审计词条；join 绑定不变、下一 epoch 判定主体照旧。承接「一次性放行/否决」的运维需求（如定义态 validator 坏死解卡），不动程序文本。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | drain 语义不被破坏（回归） | par(2 leaf，一成功一耗尽 attempts 落 exhausted)，join=drain，真跑 | local | 全员 terminal 后容器结构性放行、外层 seq 推进；失败不上溯、无判定等待 |
| function | validator spawn 与 advance | par 声明 validator，成员全 terminal 后观察；validator preset 写 advance | local | 引擎自动 spawn 验证者 leaf；advance 后外层 seq 推进 |
| function | hold（#546 行 11） | validator 对未收敛 par 写 `hold`，之后再次评估时改写 `advance` | local | hold 后容器不推进不退回、事件可见退避重问；下次判定 advance 生效 |
| function | 判定准入门 | validator run 写词表外判定值；无凭证主体写判定 | local | 均被拒；每次判定尝试有审计事件 |
| function | reopen 派发边界 | #701 落地前 validator 写 reopen | local | 显式拒绝且错误点名未支持（非静默）；#701 落地后此行由其验收接管 |
| function | validator 可见失败成员 | par 含 exhausted 成员时 validator 的判定输入 | local | 失败成员及其终态对验证者可见（判定输入/可查询面中呈现） |
| function | validator mutation 崩溃重放 | validator leaf 经 CLI item add 后、decision CLI 前立即退出；观察同 epoch 重问 | local | validator 重新 spawn；重复 mutation 由 #712 幂等确认吸收；items 无重复、epoch 未递增 |
| function | validator decision 崩溃恢复 | 合法 CLI decision 写入 #712 journal 后、消费提交前 kill -9 daemon；重启 | local | 直接消费已持久化 decision；不重新 spawn validator；容器效果仅一次 |
| function | operator override（预期结果 7） | operator 凭证对未收敛 par 的当前 epoch 写 advance；agent 凭证模仿同请求 | local | operator 写经准入门生效 + 独立审计词条，容器推进，join 绑定与下一 epoch 主体不变；agent 凭证被拒 |
| function | epoch 采样冻结 | evaluation 进行中经 #703 通道追加新绑定后同 epoch 崩溃重问 | local | 重问仍按 epoch 记录采样的旧绑定；下一 epoch 才用新绑定（与 #703 侧验收互证） |
| assumption | 引擎零 mergedness 注入（供给条款 3） | `grep -rn "mergedAt\|mergeCommit\|mergedness\|merge_state" src/ --include="*.ts"` 后人工核对：validator prompt 组装、判定 payload 组装、join 评估路径 | local | 引擎侧无向 validator prompt / 判定 payload 注入 GitHub 面字段的路径；合并真相在 preset 判定器 prompt/CLI 命令中经 `gh` 自查获得 |
| assumption | 零 stdout 判定 | `grep -rn "FINALIZER SUMMARY\|stdout" src/ --include="*.ts" -l` 后人工核对判定路径 | local | 本 child 新增判定路径无 stdout 解析（chain-complete 既有解析的退役归 #705（chain 层声明位），不在本行） |
| type | join ADT 穷尽 | `bun run typecheck`；临时向 join union 加一个 variant 观察编译错误面 | local | typecheck 通过；新增 variant 使全部处置点编译报错（无 default 吞掉） |

## 依赖关系

- Depends on: #698。
- Blocks: #701、#702、#703、#704、#705、#706、#708、#714、#715、#733。



---

## Comments (1)

### comment #5055603244 by `RiriAgent` — 2026-07-23T07:23:34Z

## Chain `v3-546-v2` 起手：baseline 相对本 issue 的实现快照

**新 chain**: `v3-546-v2`（preset=gh-issue-pr-iteration, baseBranch=`coder-loop/v3-546-baseline`）。
**baseline**: `coder-loop/v3-546-baseline` @ `d67fec5`（相对 `main` ahead 49 commit，源自旧 chain `v3-546` 9 轮迭代）。
**旧现场**（stopped, 勿动）: 旧 chain `v3-546` / 旧 iteration branch `coder-loop/v3-546-94cd3a68e245` / 旧 PR #749 (`changes_requested`, OPEN) / #560 (承接方 = #699, OPEN)。

### 本 issue（#700 承接 #561 par join 评估 / validator judgment channel）相对 baseline 的进度

- **已落地**: 无。baseline 无 validator spawn / CLI 写回 / advance-hold-reopen 三词派发 / drain 结构性放行 / operator override / epoch 采样冻结 / mergedness 注入零证明 / join ADT 穷尽等任何路径。
- **半成品**: 无。
- **未开始**: 本 issue 全部验收清单 — drain 语义回归、validator spawn 与 advance、hold 退避重问、判定准入门 default-deny、reopen 派发边界拒绝（#701 落地前需显式拒绝并点名未支持）、validator 可见失败成员、validator mutation 崩溃重放、validator decision 崩溃恢复、operator override、epoch 采样冻结、引擎零 mergedness 注入（`grep mergedAt|mergeCommit|mergedness|merge_state src/`）、零 stdout 判定、join ADT 穷尽 switch。

### 依赖

本 issue depends on **#698**。#698 树调度落地前，validator spawn 无 par 结构可挂载。先做 #698 再做本 issue。

### iteration agent

从 baseline checkout，全部从零构建 join 评估通道。PR base = `coder-loop/v3-546-baseline`。



---

## Timeline (23)

- 2026-07-17T20:13:18Z `assigned` @RiriAgent
- 2026-07-17T20:14:00Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-17T20:14:03Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-17T20:14:04Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-17T20:14:05Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-17T20:14:07Z `cross-referenced` @RiriAgentsrc=704
- 2026-07-17T20:14:08Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-17T20:14:09Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-17T20:14:11Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-17T20:14:28Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:14:54Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-17T20:38:33Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-17T20:38:34Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:38:56Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-23T07:23:34Z `commented` @RiriAgent
- 2026-07-23T23:17:40Z `cross-referenced` @RiriAgentsrc=755
- 2026-07-24T04:01:28Z `cross-referenced` @RiriAgentsrc=756
- 2026-07-24T04:07:17Z `cross-referenced` @RiriAgentsrc=757
- 2026-07-26T16:14:11Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-26T16:14:24Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-26T16:14:33Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-26T16:15:02Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-26T16:15:06Z `cross-referenced` @RiriAgentsrc=546