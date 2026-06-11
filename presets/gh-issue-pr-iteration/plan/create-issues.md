# Fragment: plan/create-issues

## Goal

Post the validated draft bodies as GitHub issues. Link parent/child relationships. Record returned issue numbers for `plan/init-queue` to write into `central state DB`.

## Inputs

- Validated draft bodies from `plan/adversarial-validate`.
- Classification map from `plan/classify` (which is parent, which children, which spike blocks which implementation).

## Procedure

1. **Idempotently ensure this preset's `kind:*` label assets exist in the target repo and match the declaration**.

   Asset declaration:

   | Name | Color | Description |
   |---|---|---|
   | `kind:code` | `1f883d` | `Issue 的 deliverable 是代码 PR` |
   | `kind:comment` | `0969da` | `Issue 的 deliverable 是 PR comment / review reply` |
   | `kind:code-spike` | `fbca04` | `Issue 的 deliverable 是 source-writing spike evidence；不走 PR merge` |
   | `kind:blocked` | `b60205` | `Issue 的 deliverable 是解除具体阻塞条件并恢复被阻塞 loop` |

   First check which declared names already exist and what metadata they currently carry:

   ```bash
   gh label list --repo <owner>/<repo> --search kind: --json name,color,description
   ```

   Compare the output to the asset declaration above by `name`, `color`, and `description`. For each missing declared label, create exactly that label with its declared color and description. For each existing declared label whose color or description differs from the declaration, edit that label to the declared color and description. For each existing declared label that already matches the declaration, take no action. Do not create, edit, or delete labels that are not declared by this preset.

   ```bash
   gh label create kind:code --repo <owner>/<repo> --color 1f883d --description "Issue 的 deliverable 是代码 PR"
   gh label create kind:comment --repo <owner>/<repo> --color 0969da --description "Issue 的 deliverable 是 PR comment / review reply"
   gh label create kind:code-spike --repo <owner>/<repo> --color fbca04 --description "Issue 的 deliverable 是 source-writing spike evidence；不走 PR merge"
   gh label create kind:blocked --repo <owner>/<repo> --color b60205 --description "Issue 的 deliverable 是解除具体阻塞条件并恢复被阻塞 loop"
   ```

   ```bash
   gh label edit kind:code --repo <owner>/<repo> --color 1f883d --description "Issue 的 deliverable 是代码 PR"
   gh label edit kind:comment --repo <owner>/<repo> --color 0969da --description "Issue 的 deliverable 是 PR comment / review reply"
   gh label edit kind:code-spike --repo <owner>/<repo> --color fbca04 --description "Issue 的 deliverable 是 source-writing spike evidence；不走 PR merge"
   gh label edit kind:blocked --repo <owner>/<repo> --color b60205 --description "Issue 的 deliverable 是解除具体阻塞条件并恢复被阻塞 loop"
   ```

2. **Order of creation** matters when issues reference each other:
   - Create parent / umbrella first; record its issue number.
   - Create spike issues; record numbers.
   - Create implementation issues; reference spike numbers in their `## 依赖关系` (`Depends on: #<spike>`).
   - For spikes, rewrite `## 依赖关系` after implementation issues exist (`Blocks: #<impl>`) — `gh issue edit` to update.

3. **Post each issue** with `gh issue create`. Per `contract.md` §1.3, every issue must have exactly one `kind:*` label:
   ```bash
   gh issue create --repo <owner>/<repo> \
       --title "<title>" \
       --label kind:code \
       --body "$(cat <<'EOF'
   <body verbatim from validated draft>
   EOF
   )"
   ```
   The command returns the issue URL; extract the number.
   - For `kind:code` deliverables → `--label kind:code`.
   - For `kind:comment` spike / design-dialog → `--label kind:comment`.
   - For source-writing no-merge spike deliverables → `--label kind:code-spike`.
   - For blocked-resolution deliverables with an `Unblocks:` back-link → `--label kind:blocked`.
   - For `parent` umbrella that has its own closure task → `--label kind:code`.
   - For `parent` umbrella that's coordinator-only (no closure task) → no `kind:*` label (it won't be queued anyway; this is the legacy / coordinator pattern).
   - For `design-question` issues → `--label kind:comment` (deliverable is operator's clarifying comment).
   - For `no-code` references → don't file a new issue, just reference the existing covering issue in handoff.

4. **Link parent / child** with GraphQL `addSubIssue` (issue-to-issue only, never PR-as-child):
   ```bash
   PARENT_ID=$(gh api graphql -F num=<parent> -f query='
     query($num:Int!){repository(owner:"<owner>",name:"<repo>"){
       issue(number:$num){id}}}' --jq '.data.repository.issue.id')

   CHILD_ID=$(gh api graphql -F num=<child> -f query='
     query($num:Int!){repository(owner:"<owner>",name:"<repo>"){
       issue(number:$num){id}}}' --jq '.data.repository.issue.id')

   gh api graphql -f query='
     mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){
       subIssue{number title}issue{number title}}}' \
     -f p="$PARENT_ID" -f c="$CHILD_ID"
   ```
   Mind:
   - sub-issue is single-parent;
   - if `addSubIssue` returns `Issue may not contain duplicate sub-issues`, the link already exists — safe to ignore;
   - if it returns `Sub issue may only have one parent`, decide which line owns the child and `removeSubIssue` the other.

5. **Verify** every posted issue:
   ```bash
   gh issue view <N> --repo <owner>/<repo> --json title,labels,body --jq '{title, labels: [.labels[].name], body_lines: (.body | split("\n") | length)}'
   ```
   - `labels` contains exactly one `kind:*`;
   - `body_lines` ≥ 30 (catches accidental empty body);
   - `body` starts with `# <title>` if the body convention is to repeat the title.

## Failure handling

If `gh issue create` fails for any reason (auth, rate limit, network):

- record which issues already landed (with their numbers);
- emit `creation_failed` with the unlanded set and the error;
- do NOT proceed to `plan/init-queue` — partial creation produces a queue that references non-existent issues.

If `addSubIssue` fails for a critical link (e.g. parent → child where the child can't run without parent context), record the failure but continue; the operator can re-run the GraphQL call manually. Minor link failures shouldn't block `plan/init-queue`.

If a `kind:*` label is rejected after the ensure step, bail with `creation_failed` and record the exact label name, command, stdout, and stderr. Do not instruct the operator to create the labels first; this preset's planning agent owns the missing-label ensure step.

## Output verdict

Choose exactly one:

- `issues_created` → read `plan/init-queue`. All planned issues exist on GitHub with correct labels and parent/child links.
- `creation_failed` → read `plan/handoff` with the partial-creation state (which issues landed, which didn't, error text).

Do not initialize the queue with a partially-created issue set.
