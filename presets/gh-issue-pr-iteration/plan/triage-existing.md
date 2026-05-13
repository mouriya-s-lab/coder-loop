# Fragment: plan/triage-existing

## Goal

把 intake 阶段命中的已开 issue 走显式 triage 路径，按 operator policy 分到 5 类副作用动作，避免被压进 `plan/classify` / `plan/decompose` 当 pass-through。新 issue（intake 列出的、GitHub 上还不存在的候选）继续走 `plan/business-frame` → `plan/decompose` → `plan/checkpoint-author` → `plan/create-issues`。

triage 与新 issue planning 共存：一次 `/dev-plan` 调用既可以 triage 5 个既存 + decompose 2 个新（`triage_complete`），也可以只 triage 不 decompose 任何新（`triage_only`）。

## Inputs

- intake 输出的"既存 issue 候选清单"（intake `## Procedure` step 3 的 `gh issue list` 结果中被 operator 显式点名要 triage 的 N 个 issue）。
- operator 在 `/dev-plan` 调用 prompt 里给出的 triage policy。policy 必须 explicit，常见形态：
  - "内容没问题 → 改写 body 到 §1 正规格式"
  - "有问题 + 已有 PR → 在 PR thread 回复"
  - "有问题 + 无 PR → 关掉"（默认走 review 关；operator 显式写"plan 直接关"才进 `close_with_operator_auth`）
- `contract.md` §1（issue body 必备段、`kind:*` 单值规则、`## 验收标准` 表 6 列契约）。
- `contract.md` §2（PR body `Closes` 首行、四层证据、CI parity、retry 在 PR thread）。
- 每个候选 issue 的当前 GitHub 状态：`gh issue view <repo>#<N> --json title,body,state,labels,linkedPullRequests`。

## Action 分类

每个候选 issue 走下面 5 类**恰好一个**动作：

| 动作 | 触发条件 | plan 做什么 | 副作用 |
|---|---|---|---|
| `rewrite_body` | issue content 符合 operator 意图，但 body format 不合 §1（缺必备段 / `## 验收标准` 表列错 / kind label 缺或多）→ 内容留、形态正规化 | 草拟新 body 文本 → 实际跑 `gh issue edit <repo>#<N> --body-file <tmp>` → 视需要补 `gh issue edit ... --add-label kind:code` 或 `--remove-label kind:foo` | 改 issue body / labels |
| `pr_reply` | issue content 有问题且 GitHub 上 issue 已有关联 open / merged PR | 草拟 review feedback comment → 实际跑 `gh pr comment <repo>#<PR> --body-file <tmp>`（不动 issue body，不关 issue —— 路由规则要求 PR 存在后讨论留 PR thread） | PR thread 新评论 |
| `close_with_operator_auth` | issue content 有问题、无关联 PR、operator intake **显式授权 plan 关** | 草拟 close 理由 comment → 实际跑 `gh issue comment <repo>#<N> --body-file <tmp>` 再 `gh issue close <repo>#<N>` | 关 issue + 留 close 理由 |
| `close_propose_to_review` | issue content 有问题、无关联 PR、operator **未显式授权** plan 关 | 写进 handoff 文件的 "Suggested closures（need review approval）" 段 + 草拟理由文本，等 `/dev-loop` review phase 走 `review/issue-closure-gate` 决定 | 不动 GitHub；只写 handoff |
| `no_op` | issue content 与 format 都合（content OK + §1 通过） | trace 记一行 "no_op: #N 通过 §1 校验，未修改" | 无 |

授权范围严格：`close_with_operator_auth` 仅当 operator intake 同时满足三条件：(a) "授权 plan 关"显式语言；(b) issue content 有问题；(c) issue 无关联 PR。任一不满足 → 落回 `close_propose_to_review`。

## Procedure

1. 列出 intake 给的所有既存 issue 候选。一条 bullet 一个 issue，附 `<repo>#<N>` + 当前 title。

2. 对每个 issue 跑 `gh issue view <repo>#<N> --json title,body,state,labels,linkedPullRequests`。检查：
   - `kind:*` label 数量（§1.3：必须恰好 1 个，且 value ∈ `{code, comment}`）；
   - 必备段是否齐全（§1.2 / §1.4 / §1.6）；
   - 关联 PR 状态（影响 `pr_reply` vs `close_*` 分支）。

3. 把 operator policy 文本逐条匹配到 issue。每个 issue 选**恰好一个**动作。
   - operator policy 与 issue 状态冲突时（如 operator 说"关掉" + issue 已有 open PR），按"PR 存在 → 评论走 PR thread"路由规则强制走 `pr_reply`，trace 记一行 conflict resolution。
   - operator policy 未覆盖某个 issue → 走 `no_op` 或 `close_propose_to_review`（取决于 content / format 状态），trace 注明 "policy 未覆盖，按 default 走 X"。

4. 按动作分组草拟产物。每组写到本 fragment 的 trace 段：
   - `rewrite_body`: issue #N → 完整新 body markdown 草稿（满足 §1.2 必备段、§1.4 表 6 列、§1.6 spike 分支）；
   - `pr_reply`: issue #N + PR #M → comment markdown 草稿（引用 review feedback 来源 + 具体下一步）；
   - `close_with_operator_auth`: issue #N → close-reason comment 草稿；
   - `close_propose_to_review`: issue #N → 同上 + 显式标 "needs review approval"；
   - `no_op`: issue #N → 一行 "通过 §1 校验" 记录。

5. 执行 GitHub 写入（按动作顺序：`rewrite_body` → `pr_reply` → `close_with_operator_auth`；`close_propose_to_review` 与 `no_op` 不写 GitHub）。每次写入：
   - 写 body / comment 到 `.coder-loop/runtime/issues/triage-<run-id>/issue-<N>.{body,comment}.md` 留 trace；
   - `rewrite_body`：实际 gh issue edit `<repo>#<N> --body-file <tmp>` 必须真跑通；只把 body 写到本地 tmp 不算完成（trace 会被 review verify 跑一次 `gh issue view` 比对 GitHub live state，diverge → 该 issue 落 `triage_blocked`）。
   - `pr_reply`：实际 gh pr comment `<repo>#<PR> --body-file <tmp>` 必须真跑通；只草拟 markdown 不发不算完成。
   - `close_with_operator_auth`：实际 gh issue close `<repo>#<N>` 必须真跑通（同时实际 gh issue comment 把 close-reason 留 issue thread）。
   - 任一 GitHub 写入失败（exit 非零 / network error / 权限不足）→ 当 issue 落 `triage_blocked` 集合，继续处理其余 issue 不立刻停。

6. 收尾：把每个 issue 的最终 verdict + 命令 stdout / stderr 写进 fragment trace，作 review 复核证据。`gh issue view <repo>#<N> --json state,labels,body` 在 mutate 后再跑一次，确认 GitHub live state 与 plan 意图一致；不一致 → 该 issue 落进 `triage_blocked`。

## Failure handling

- 任意 issue 的 `gh` 写入命令 exit 非零、或写后 verify 显示 GitHub 实际 state 与 plan 草稿 diverge → 该 issue 进 `triage_blocked` 集合。trace 完整记录命令、stderr、当前 GitHub state。
- operator policy 与 contract.md §1 / §2 冲突（如 "policy 要求 kind:foo" 但 §1.3 仅允许 `{code, comment}`）→ 不要走 `rewrite_body`，emit `triage_blocked` 并把冲突写进 handoff 让 operator 仲裁。
- 候选 issue 已 closed 但 operator policy 要求 "改 body" → 该 issue 进 `triage_blocked`，trace 记 "issue closed; cannot rewrite"，不重开 issue（不在 plan 授权范围）。

## Output verdict

每条 verdict 严格映射到下游 fragment：

- `triage_complete` → read `plan/business-frame`。triage 已处理；intake 还有新 issue 候选要拆，先建立业务陈述再 decompose。
- `triage_only` → read `plan/init-queue`。仅 triage，无新 issue 候选；既存 issue 中有 `rewrite_body` 落地的、且要入 coder-loop queue 的，按动作产物准备 queue item 后直接 init-queue。
- `triage_close_via_review` → read `plan/handoff`。triage 含一条或多条 `close_propose_to_review` 动作；plan 把待关清单 + 理由 + 引用证据写进 handoff，由 `/dev-loop` review phase `review/issue-closure-gate` 决定关 / 不关。
- `triage_blocked` → read `plan/handoff`。至少一条 issue 上 GitHub 写入失败 / state diverge / policy 冲突；plan 不继续 decompose，把阻塞集合 + 已成功集合都写进 handoff，operator 决定下一步。

`triage_complete` 与 `triage_only` 互斥（前者下游还有新 issue，后者没有）。`triage_close_via_review` 优先于 `triage_complete`：只要存在 `close_propose_to_review` 动作就走 handoff，避免 review 关 issue 的提议被埋在 decompose 之后。`triage_blocked` 优先级最高，凡含 blocked 一律走 handoff。
