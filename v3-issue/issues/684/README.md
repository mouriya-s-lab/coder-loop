# #684 test(v3): 冻结合流 SHA 的整链路 integration 验收

- state: **open**  | author: `RiriAgent`  | created: 2026-07-15T10:53:39Z  | updated: 2026-07-15T12:58:50Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/684
- comments: 0  | timeline events: 124

---

## Body

## 必须先读的关联 issue

- **umbrella #683**：继承“implementation 局部验证、v3 整链路 integration、compatibility real E2E 分离”的验收契约。
- **#543–#548**：读取进入本 checkpoint 的各 RFC 完成态与 child 验证边界。

## 目标

在冻结的合流 SHA 上运行一个非 bundled 的 v3 专用场景，证明已经合流的 compile、运行态、scheduler、gate、context、ingress、status/events 与 GUI 生产者/消费者真正连接。

## 使用场景

各 implementation PR 分别通过后，由未参与实现的验证者只拿冻结 SHA、公开 issue contract 和 fixture 执行本 issue。它不重新实现功能，只发现跨 issue 接缝断裂并把失败归属回具体 implementation issue。

## 上下文

- **Repo**: `mouriya-s-lab/coder-loop`（path: `/Users/mouriya/Ext/code/coder-loop`）
- **Design source**: `v3/execution-orchestration.md` 的 G1–G5

> “所有 required task 落到同一个默认分支 SHA 后，才运行该组 Gate。” — `v3/execution-orchestration.md`

## 完成态片段

- 非 GitHub、非 bundled v3 preset 能从 compile 产物进入真实 daemon 调度。
- 两层 `seq/par` 存在真实重叠执行，join 可 hold/reopen/correction 后 advance。
- daemon 重启后恢复 pinned definition、tree cursor、evaluation epoch、context 与事件因果链，不重复副作用。
- ingress、status/events 和 GUI 消费相同稳定 identity，不读取私有表猜字段。
- 失败报告能点名断裂的生产者、消费者、输入 SHA 与应回修的 implementation issue。

## 不应残留

- 不使用 `real-e2e-minimal` 或 `gh-issue-pr-iteration` 的 GitHub PR closure 代替 v3 场景。
- 不把分别运行的 mock demo 拼成“整链路通过”。
- 不在验收分支临时修产品代码。

## 本 issue 的验证边界

- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | integration | 冻结 SHA 上运行 v3 整链路场景 | `bun scripts/v3-integration.ts --checkpoint all` | clean local checkout + isolated loop-data | exit 0；输出输入 SHA、preset/fixture、各跨边界 identity 与事件序列 |
| 2 | integration | 并发、hold/reopen/correction 与顶层完成 | `bun scripts/v3-integration.ts --checkpoint task-tree,gates` | real daemon + deterministic runners | 存在重叠时间窗；第一次判定不推进，correction 完成后才推进；无重复 spawn |
| 3 | integration | 重启恢复与下游消费 | `bun scripts/v3-integration.ts --checkpoint recovery,consumers` | real daemon restart + gateway/browser | 重启前后 definition/tree/context identity 一致；status/events/GUI 可重建同一因果链 |
| 4 | function | 仓库日常 gate | `bun run typecheck && bun test && bun scripts/engine-integration.ts` | local | 全部 exit 0；不得把该行单独当作本 issue 通过 |

## 依赖关系

- Depends on: #543–#548 中进入目标 checkpoint 的 implementation children 已合流到同一 SHA。
- Blocks: #683 关闭；v3 RFC umbrella 最终关闭复核；bundled preset compatibility E2E 的发布候选判定。


---

## Comments (0)

---

## Timeline (124)

- 2026-07-15T10:53:40Z `assigned` @RiriAgent
- 2026-07-15T10:53:43Z `cross-referenced` @RiriAgentsrc=685
- 2026-07-15T10:53:53Z `parent_issue_added` @RiriAgent
- 2026-07-15T10:56:47Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-15T10:56:49Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-15T10:56:50Z `cross-referenced` @RiriAgentsrc=545
- 2026-07-15T10:56:52Z `cross-referenced` @RiriAgentsrc=546
- 2026-07-15T10:56:54Z `cross-referenced` @RiriAgentsrc=547
- 2026-07-15T10:56:55Z `cross-referenced` @RiriAgentsrc=548
- 2026-07-15T10:56:57Z `cross-referenced` @RiriAgentsrc=549
- 2026-07-15T10:56:59Z `cross-referenced` @RiriAgentsrc=550
- 2026-07-15T10:57:00Z `cross-referenced` @RiriAgentsrc=551
- 2026-07-15T10:57:01Z `cross-referenced` @RiriAgentsrc=552
- 2026-07-15T10:57:03Z `cross-referenced` @RiriAgentsrc=553
- 2026-07-15T10:57:04Z `cross-referenced` @RiriAgentsrc=554
- 2026-07-15T10:57:05Z `cross-referenced` @RiriAgentsrc=555
- 2026-07-15T10:57:06Z `cross-referenced` @RiriAgentsrc=556
- 2026-07-15T10:57:07Z `cross-referenced` @RiriAgentsrc=557
- 2026-07-15T10:57:08Z `cross-referenced` @RiriAgentsrc=558
- 2026-07-15T10:57:10Z `cross-referenced` @RiriAgentsrc=559
- 2026-07-15T10:57:11Z `cross-referenced` @RiriAgentsrc=560
- 2026-07-15T10:57:12Z `cross-referenced` @RiriAgentsrc=561
- 2026-07-15T10:57:14Z `cross-referenced` @RiriAgentsrc=562
- 2026-07-15T10:57:15Z `cross-referenced` @RiriAgentsrc=563
- 2026-07-15T10:57:16Z `cross-referenced` @RiriAgentsrc=564
- 2026-07-15T10:57:17Z `cross-referenced` @RiriAgentsrc=565
- 2026-07-15T10:57:18Z `cross-referenced` @RiriAgentsrc=566
- 2026-07-15T10:57:20Z `cross-referenced` @RiriAgentsrc=567
- 2026-07-15T10:57:21Z `cross-referenced` @RiriAgentsrc=568
- 2026-07-15T10:57:22Z `cross-referenced` @RiriAgentsrc=569
- 2026-07-15T10:57:23Z `cross-referenced` @RiriAgentsrc=570
- 2026-07-15T10:57:25Z `cross-referenced` @RiriAgentsrc=572
- 2026-07-15T10:57:26Z `cross-referenced` @RiriAgentsrc=574
- 2026-07-15T10:57:27Z `cross-referenced` @RiriAgentsrc=575
- 2026-07-15T10:57:28Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-15T10:57:29Z `cross-referenced` @RiriAgentsrc=577
- 2026-07-15T10:57:30Z `cross-referenced` @RiriAgentsrc=578
- 2026-07-15T10:57:31Z `cross-referenced` @RiriAgentsrc=579
- 2026-07-15T10:57:32Z `cross-referenced` @RiriAgentsrc=580
- 2026-07-15T10:57:34Z `cross-referenced` @RiriAgentsrc=581
- 2026-07-15T10:57:35Z `cross-referenced` @RiriAgentsrc=582
- 2026-07-15T10:57:36Z `cross-referenced` @RiriAgentsrc=583
- 2026-07-15T10:57:37Z `cross-referenced` @RiriAgentsrc=584
- 2026-07-15T10:57:38Z `cross-referenced` @RiriAgentsrc=585
- 2026-07-15T10:57:39Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-15T10:57:40Z `cross-referenced` @RiriAgentsrc=587
- 2026-07-15T10:57:41Z `cross-referenced` @RiriAgentsrc=588
- 2026-07-15T10:57:43Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-15T10:57:44Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-15T10:57:45Z `cross-referenced` @RiriAgentsrc=591
- 2026-07-15T10:57:46Z `cross-referenced` @RiriAgentsrc=592
- 2026-07-15T10:57:47Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-15T10:57:48Z `cross-referenced` @RiriAgentsrc=595
- 2026-07-15T10:57:49Z `cross-referenced` @RiriAgentsrc=596
- 2026-07-15T10:57:51Z `cross-referenced` @RiriAgentsrc=597
- 2026-07-15T10:57:52Z `cross-referenced` @RiriAgentsrc=598
- 2026-07-15T10:57:53Z `cross-referenced` @RiriAgentsrc=599
- 2026-07-15T10:57:54Z `cross-referenced` @RiriAgentsrc=601
- 2026-07-15T10:57:56Z `cross-referenced` @RiriAgentsrc=602
- 2026-07-15T10:57:57Z `cross-referenced` @RiriAgentsrc=603
- 2026-07-15T10:57:58Z `cross-referenced` @RiriAgentsrc=604
- 2026-07-15T10:57:59Z `cross-referenced` @RiriAgentsrc=605
- 2026-07-15T10:58:11Z `cross-referenced` @RiriAgentsrc=683
- 2026-07-15T12:41:23Z `cross-referenced` @RiriAgentsrc=674
- 2026-07-15T14:22:07Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-15T14:48:47Z `cross-referenced` @RiriAgentsrc=675
- 2026-07-15T17:35:39Z `cross-referenced` @RiriAgentsrc=678
- 2026-07-15T21:13:08Z `cross-referenced` @RiriAgentsrc=676
- 2026-07-16T08:23:00Z `cross-referenced` @RiriAgentsrc=690
- 2026-07-16T18:12:38Z `cross-referenced` @RiriAgentsrc=691
- 2026-07-16T23:18:00Z `referenced` @RiriAgentcommit=1e3e49d7dc91f05e54a2a0f23b9f756741cf6050
- 2026-07-16T23:23:41Z `referenced` @RiriAgentcommit=8dc9a9a407481f33a0a0fb55386b451335eb8533
- 2026-07-16T23:38:35Z `referenced` @RiriAgentcommit=05ee53cc42027da2343ce5f24c5a0103e919fdb8
- 2026-07-17T20:13:16Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:37:46Z `cross-referenced` @RiriAgentsrc=748
- 2026-07-19T05:49:20Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-26T23:48:55Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-26T23:48:57Z `cross-referenced` @RiriAgentsrc=701
- 2026-07-26T23:48:58Z `cross-referenced` @RiriAgentsrc=702
- 2026-07-26T23:48:59Z `cross-referenced` @RiriAgentsrc=703
- 2026-07-26T23:49:00Z `cross-referenced` @RiriAgentsrc=704
- 2026-07-26T23:49:01Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-26T23:49:02Z `cross-referenced` @RiriAgentsrc=706
- 2026-07-26T23:49:03Z `cross-referenced` @RiriAgentsrc=707
- 2026-07-26T23:49:05Z `cross-referenced` @RiriAgentsrc=708
- 2026-07-26T23:49:06Z `cross-referenced` @RiriAgentsrc=709
- 2026-07-26T23:49:07Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-26T23:49:08Z `cross-referenced` @RiriAgentsrc=711
- 2026-07-26T23:49:10Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-26T23:49:11Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-26T23:49:12Z `cross-referenced` @RiriAgentsrc=714
- 2026-07-26T23:49:14Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-26T23:49:15Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-26T23:49:16Z `cross-referenced` @RiriAgentsrc=717
- 2026-07-26T23:49:18Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-26T23:49:19Z `cross-referenced` @RiriAgentsrc=719
- 2026-07-26T23:49:20Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-26T23:49:21Z `cross-referenced` @RiriAgentsrc=721
- 2026-07-26T23:49:22Z `cross-referenced` @RiriAgentsrc=722
- 2026-07-26T23:49:23Z `cross-referenced` @RiriAgentsrc=723
- 2026-07-26T23:49:24Z `cross-referenced` @RiriAgentsrc=724
- 2026-07-26T23:49:26Z `cross-referenced` @RiriAgentsrc=725
- 2026-07-26T23:49:27Z `cross-referenced` @RiriAgentsrc=726
- 2026-07-26T23:49:28Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-26T23:49:29Z `cross-referenced` @RiriAgentsrc=728
- 2026-07-26T23:49:30Z `cross-referenced` @RiriAgentsrc=729
- 2026-07-26T23:49:32Z `cross-referenced` @RiriAgentsrc=730
- 2026-07-26T23:49:34Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-26T23:49:35Z `cross-referenced` @RiriAgentsrc=732
- 2026-07-26T23:49:36Z `cross-referenced` @RiriAgentsrc=733
- 2026-07-26T23:49:37Z `cross-referenced` @RiriAgentsrc=734
- 2026-07-26T23:49:38Z `cross-referenced` @RiriAgentsrc=735
- 2026-07-26T23:49:39Z `cross-referenced` @RiriAgentsrc=736
- 2026-07-26T23:49:40Z `cross-referenced` @RiriAgentsrc=737
- 2026-07-26T23:49:41Z `cross-referenced` @RiriAgentsrc=738
- 2026-07-26T23:49:42Z `cross-referenced` @RiriAgentsrc=739
- 2026-07-26T23:49:43Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-26T23:49:44Z `cross-referenced` @RiriAgentsrc=741
- 2026-07-26T23:49:45Z `cross-referenced` @RiriAgentsrc=742
- 2026-07-26T23:49:47Z `cross-referenced` @RiriAgentsrc=743
- 2026-07-26T23:49:48Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-26T23:49:49Z `cross-referenced` @RiriAgentsrc=745
- 2026-07-26T23:49:50Z `cross-referenced` @RiriAgentsrc=746
- 2026-07-26T23:49:51Z `cross-referenced` @RiriAgentsrc=747