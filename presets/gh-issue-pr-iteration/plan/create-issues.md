# Fragment: plan/create-issues

## Goal

Post the validated draft bodies as GitHub issues. Link parent/child relationships. Record returned issue numbers for `plan/init-queue` to write into `central state DB`.

## Inputs

- Validated draft bodies from `plan/adversarial-validate`.
- Classification map from `plan/classify` (which is parent, which children, which spike blocks which implementation).

## Procedure

1. **Order of creation** matters when issues reference each other:
   - Create parent / umbrella first; record its issue number.
   - Create spike issues; record numbers.
   - Create implementation issues; reference spike numbers in their `## 依赖关系` (`Depends on: #<spike>`).
   - For spikes, rewrite `## 依赖关系` after implementation issues exist (`Blocks: #<impl>`) — `gh issue edit` to update.

2. **Post each issue** with `gh issue create`. The deliverable shape (per `contract.md` §1.2 / §1.6) is encoded in the issue body sections themselves — there is no label routing layer, so the create command only needs the title and body:
   ```bash
   gh issue create --repo <owner>/<repo> \
       --title "<title>" \
       --body "$(cat <<'EOF'
   <body verbatim from validated draft>
   EOF
   )"
   ```
   The command returns the issue URL; extract the number.
   - For `implementation` candidates → body must follow §1.2 implementation-PR-deliverable shape (the default acceptance-rows-replayed-against-a-diff body).
   - For `spike` candidates → body must follow §1.2 comment-spike-deliverable shape (`## 验证步骤` + `## 结果分支`).
   - For `source-writing-spike` candidates → body must follow §1.2 source-writing-spike-deliverable shape, including `## 约束` literally declaring no-merge / no-PR.
   - For `blocker-resolution` candidates → body must follow §1.2 unblock-deliverable shape with `Unblocks: owner/repo#N`.
   - For `parent` umbrella that has its own closure task → body uses the implementation-PR-deliverable shape (umbrella itself carries the closure task).
   - For `parent` umbrella that is coordinator-only (no closure task) → no acceptance table is required; the parent only coordinates and is never queued.
   - For `design-question` candidates → body follows §1.2 comment-spike-deliverable shape (operator answers in the issue thread, never queued).
   - For `no-code` references → don't file a new issue, just reference the existing covering issue in handoff.

3. **Link parent / child** with GraphQL `addSubIssue` (issue-to-issue only, never PR-as-child):
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

4. **Verify** every posted issue:
   ```bash
   gh issue view <N> --repo <owner>/<repo> --json title,body --jq '{title, body_lines: (.body | split("\n") | length)}'
   ```
   - `body_lines` ≥ 30 (catches accidental empty body);
   - `body` starts with `# <title>` if the body convention is to repeat the title;
   - body contains the §1.2 required sections for the candidate's deliverable shape (presence check, not content judgment).

## Failure handling

If `gh issue create` fails for any reason (auth, rate limit, network):

- record which issues already landed (with their numbers);
- emit `creation_failed` with the unlanded set and the error;
- do NOT proceed to `plan/init-queue` — partial creation produces a queue that references non-existent issues.

If `addSubIssue` fails for a critical link (e.g. parent → child where the child can't run without parent context), record the failure but continue; the operator can re-run the GraphQL call manually. Minor link failures shouldn't block `plan/init-queue`.

## Output verdict

Choose exactly one:

- `issues_created` → read `plan/init-queue`. All planned issues exist on GitHub with the required body sections and parent/child links.
- `creation_failed` → read `plan/handoff` with the partial-creation state (which issues landed, which didn't, error text).

Do not initialize the queue with a partially-created issue set.
