# Fragment: plan/business-frame

## Goal

Before decomposing into atomic sub-issues, force the planning agent to articulate the work in **user-facing business language**. This fragment exists because past planning runs jumped straight from `classify` to `decompose` and emitted sub-issues whose `## 问题` / `## 预期结果` were engineering-observable ("e2e-script.ts line 67-71 is fetch", "session jsonl 出现 tool_use") rather than user-observable ("用户的 task agent 中途卡住要找 PM 澄清需求，现在只能让用户手工转述")。Without a business frame, every downstream sub-issue inherits the audit-only framing and reviewers can only mechanically check artifacts — they cannot judge "is this what the user wanted to be able to do".

This fragment runs **once per planning invocation**, builds the business frame for the whole intake, and every later sub-issue body must cite back to it.

## When this fragment runs

Always, after `classify` (and after `triage-existing` if it ran), before `decompose`. Even for a single-issue intake, the business frame must exist and be reachable from the issue body.

For pure-`design-question` or pure-`no-code` intake (no `implementation` / `spike` candidates), skip via `business_frame_skipped` — there's no downstream issue body to anchor.

## Inputs

- Classified candidate list from `plan/classify`.
- Intake quotes from `plan/intake` (source design doc / RFC / user task).
- Target repo conventions (workflow.md extracts).

## Required outputs (three named sections)

The planning agent must produce a markdown block with exactly these three sections, each at least one substantive paragraph. The block will be stored on the umbrella issue body (if the intake spawns a parent / umbrella) under `## 业务陈述`, and every sub-issue body will cite into it.

### 1. `### 用户当前做不了什么 / 痛点`

What can users not do today, **in the user's own words about their workflow**. Not in implementation terms.

- Subject of every sentence is a user (or a thing the user owns: "my task agent", "my PM session"), never a process, file, port, package, or log line.
- Verbs describe user actions or user observations ("我想让...", "我得手动..."), not engineering actions ("the system spawns", "the child process attaches").
- If the only way you can describe the pain is "the engineering trace doesn't yet show X", you haven't yet found the user pain — go back and ask "what does the user lose because of that missing trace?"

### 2. `### 用户做完之后能多干什么`

The user-facing capability that comes online when the work lands. **User capability**, not implementation milestone.

- Same subject / verb constraints as §1.
- Describe the *new affordance*, not the *engineering proof of the affordance*.

### 3. `### 具体用户场景`

One named user, one concrete sequence from start to end of what they do and what they observe.

- Format: "Alice 在 fulcrum 起一个 task 'X'. 中途她的 task agent 发现 Y. 它给 Alice 的 PM agent 发 clarification_request. PM session 收到提示, Alice 回答 'Z', PM 发 clarification_response. Task agent 看到, 继续做."
- Steps describe what the user / her agents *do and observe*, not what the system *executes internally*. If a step is "MCP child POSTs to /v1/envelope", that's wrong — that's an implementation step.
- The scenario must touch every classified `implementation` candidate at least once. If a candidate has no place in any scenario, either the scenario is incomplete or the candidate has no business justification (re-classify).

## Calibration examples

These examples contrast pass / fail; the planning agent should use them as anchors.

❌ Engineering-framed (FAIL):
> 用户当前做不了什么：fulcrum 起 task agent 后，Claude 子进程不通过 MCP `channel.send` 把 envelope 投递到 exchange；e2e-script.ts line 67-71 只有 fetch transport，没有真实 MCP stdio。
>
> 用户做完之后能多干什么：fulcrum 起的真实 `claude` 子进程能调用 `channel.send` tool，Claude session jsonl 出现 tool_use 记录，exchange access log 收到 envelope，三方对账可关联。
>
> 具体场景：起 task → claude 进程拉起 → MCP child 挂上 → tool_use → POST /v1/envelope → exchange 投递。

Why this fails: every subject is a process / file / port / log; verbs are engineering ("拉起", "挂上", "POST", "投递", "对账"). A reviewer reading this learns the audit recipe, not what the user gains.

✅ User-framed (PASS):
> 用户当前做不了什么：我在 fulcrum 起一个复杂多步 task，让 task agent 自己跑。它中途如果遇到我没在 prompt 里写清楚的决策（比如"用哪个 OAuth provider"），只能停下等我去看 transcript、再手工把答案塞回去。我的 PM agent 这时也帮不上忙——它和 task agent 没有任何渠道直接对话，所有 cross-agent 协作都是我做人肉中继。
>
> 用户做完之后能多干什么：我的 task agent 卡住时可以直接 ping 我的 PM agent；PM agent 在自己的 session 里看到提问，可以问我或直接回答；task agent 收到答案继续做。反过来 PM agent 也可以把活派给某个 task agent 然后看着它回报结果。整个过程不需要我手工转述。
>
> 具体场景：Alice 起了一个 task "给 /api/users 加 OAuth"。Task 跑到一半，task agent 不确定 Alice 想用哪个 OAuth provider。它给 Alice 的 PM agent 发了一条请求澄清的消息。Alice 这时打开的是 PM session，看到 PM agent 提示她需要澄清 OAuth provider 选型，Alice 回答 "Google"，PM agent 把答案转给 task agent。Task agent 收到，选 Google OAuth library，继续完成 task。Alice 全程在 PM session 里，没切到 task agent 的 transcript。

Why this passes: subjects are people and their agents (人格化对象), verbs describe user-observable actions and observations ("等我去看", "做人肉中继", "可以直接 ping", "提示她"), the scenario is one named user with one concrete sequence of *what she sees happen*, not what processes execute.

## Forbidden vocabulary in the business frame

If any of these appear in the business frame's three sections, the frame is failing and must be rewritten. (They are fine in `## 验收标准` / `## 约束` later — that's the audit layer, not the business layer.)

- Process / runtime: spawn, fork, exec, pid, ppid, subprocess, child process, stdio, pipe, pgrep, ps
- Wire / API: POST, GET, fetch, envelope, payload, tool_use, tool_result, jsonl, transcript, access log
- Code structure: line N, function X, module Y, file path, MCP child, mailbox poller
- Config / packaging: docker, image, port, container, fnox key, mcpGitRef
- Verification recipe verbs: register, deregister, evict, three-way reconciliation, tool_use 记录

This is not exhaustive — the rule is "if the noun is a thing the engineering team owns rather than a thing the user owns, it doesn't belong in the business frame".

## Procedure

1. Read the intake source quotes and the classified candidate list.

2. Draft the three sections per the format above.

3. Self-check against the calibration examples:
   - Is every subject in §1 + §2 a user or a user-owned agent? (Not a process / file / port.)
   - Does §3 describe what one named user *does and observes*, top to bottom, without skipping into "the system then..."?
   - Does §3 touch every `implementation` candidate at least once?
   - Do any forbidden-vocabulary words appear? If yes, rewrite the offending sentence in user terms before continuing.

4. If the source design doc itself is purely engineering-framed and the planning agent cannot extract user pain / user capability / user scenario from it without inventing, emit `business_frame_missing_source` and bounce to handoff — the operator needs to add user-facing motivation to the design source before planning can produce business-anchored issues.

## Output verdict

Choose exactly one:

- `business_frame_ready` → read `plan/decompose`. The three sections exist, pass self-check, and touch every implementation candidate.
- `business_frame_skipped` → read `plan/decompose`. Intake has no `implementation` / `spike` candidates (pure design-question / no-code); no anchor needed.
- `business_frame_missing_source` → read `plan/handoff`. Source design doc is purely engineering; operator must add user-facing motivation before planning can proceed.

Do not advance to `decompose` while the business frame is still in engineering language. Decompose's `## 问题` and `## 预期结果` sections will cite back to this frame; if the frame is in audit language, every sub-issue inherits the audit framing and the cycle repeats.
