# #685 test(v3): bundled preset compatibility real E2E 验收

- state: **open**  | author: `RiriAgent`  | created: 2026-07-15T10:53:42Z  | updated: 2026-07-15T12:58:51Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/685
- comments: 0  | timeline events: 127

---

## Body

## 必须先读的关联 issue

- **umbrella #683**：继承“v3 整链路 integration 与现有 bundled preset compatibility real E2E 分离”的验收契约。
- **#604**：bundled preset v3 化完成态。

## 目标

在发布候选 SHA 上运行现有 bundled preset 的真实 runner + GitHub 终态路径，只回答一个问题：v3 引擎与 preset 迁移后，现有生产 GitHub 工作流是否仍兼容。

## 使用场景

本 issue 在相关机制和 bundled preset 修改合流后运行一次，不进入每个 implementation issue 的中间 commit/retry。失败时按日志把回归归属到具体 implementation issue，不在本 issue 临时修复。

## 上下文

- **Repo**: `mouriya-s-lab/coder-loop`（path: `/Users/mouriya/Ext/code/coder-loop`）
- **Fixture repo**: `mouriya-s-lab/coder-loop-e2e-fixture`
- **Design source**: #683、#604、`docs/real-e2e-fixture.md`

> “验收主线是 real-e2e 全保真：`bun scripts/real-e2e.ts --preset gh-issue-pr-iteration` 绿跑（PR MERGED / issue CLOSED）” — `mouriya-s-lab/coder-loop#604` body

## 完成态片段

- `real-e2e-minimal` 在发布候选 SHA 上完成真实 issue → PR → merge → issue close。
- `gh-issue-pr-iteration` 在最终收尾时完成全保真路径，包括迁移后的 trigger、retry、closure 与闭包分支契约。
- 证据明确写成 compatibility 结论，不把它表述成 task tree、gate、context 或 GUI 的 v3 功能证明。

## 不应残留

- 不由 implementation issue 的每轮迭代重复承担。
- 不以 engine-integration 或 mock runner 代替真实 runner/GitHub。
- 不用本 issue 的绿覆盖 #684 的 v3 整链路 integration 失败。

## 本 issue 的验证边界

- **现有 GitHub real E2E**：本 issue 必须运行 `bun scripts/real-e2e.ts --preset real-e2e-minimal` 与 `bun scripts/real-e2e.ts --preset gh-issue-pr-iteration`。

## 验收标准

| # | Dimension | Check | Command | Env | Expect |
|---|-----------|-------|---------|-----|--------|
| 1 | integration | 最小 compatibility real E2E | `bun scripts/real-e2e.ts --preset real-e2e-minimal` | clean release-candidate checkout + fixture repo | exit 0；真实 PR MERGED、seed issue CLOSED、default branch 含 fixture 改动 |
| 2 | integration | bundled preset 全保真 compatibility | `bun scripts/real-e2e.ts --preset gh-issue-pr-iteration` | clean release-candidate checkout + fixture repo | exit 0；真实 PR MERGED、issue CLOSED；trigger/retry/closure 与闭包分支契约成立 |
| 3 | integration | 证据归属 | 保存两次 run 的输入 SHA、runId、PR/issue URL、终态与清理结果 | GitHub + local loop-data | 所有证据来自同一发布候选 SHA；结论只声称 bundled preset compatibility |

## 依赖关系

- Depends on: #604；#684 在同一发布候选系列上通过。
- Blocks: #683 与六个 v3 RFC umbrella 的最终关闭复核；发版或同步到 app。


---

## Comments (0)

---

## Timeline (127)

- 2026-07-15T10:53:42Z `assigned` @RiriAgent
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
- 2026-07-15T12:58:51Z `cross-referenced` @RiriAgentsrc=684
- 2026-07-15T14:22:07Z `cross-referenced` @RiriAgentsrc=672
- 2026-07-15T14:48:47Z `cross-referenced` @RiriAgentsrc=675
- 2026-07-15T17:35:39Z `cross-referenced` @RiriAgentsrc=678
- 2026-07-15T21:13:08Z `cross-referenced` @RiriAgentsrc=676
- 2026-07-16T08:23:00Z `cross-referenced` @RiriAgentsrc=690
- 2026-07-16T18:12:38Z `cross-referenced` @RiriAgentsrc=691
- 2026-07-16T23:18:00Z `referenced` @RiriAgentcommit=1e3e49d7dc91f05e54a2a0f23b9f756741cf6050
- 2026-07-16T23:23:41Z `referenced` @RiriAgentcommit=8dc9a9a407481f33a0a0fb55386b451335eb8533
- 2026-07-17T20:13:16Z `cross-referenced` @RiriAgentsrc=699
- 2026-07-17T20:37:46Z `cross-referenced` @RiriAgentsrc=748
- 2026-07-18T10:16:12Z `cross-referenced` @RiriAgentsrc=750
- 2026-07-18T11:04:25Z `cross-referenced` @RiriAgentsrc=751
- 2026-07-18T17:02:28Z `cross-referenced` @RiriAgentsrc=698
- 2026-07-18T22:53:51Z `cross-referenced` @RiriAgentsrc=749
- 2026-07-23T23:17:40Z `cross-referenced` @RiriAgentsrc=755
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