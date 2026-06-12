# Report template: submit

Structure your final message exactly as below. Every section and field is required; write `none` for empty sets — never omit a field.

```markdown
## Why I organized it this way
<packet organization decisions: which evidence went where, fresh-PR vs retry-comment
routing, anything deliberately left out and why>

## What I actually did
Commit: <sha(s)> on <branch>, pushed to <remote ref>
Deliverable: PR #<n> <url> (fresh) | PR comment <url> (retry)
Result block: appended at <handoff path>; delta verdict: matched / drifted: <why>
Packet sections: <list of layered sections actually present in the body/comment>
E2E + manifest: <confirmation both are in the packet; auth referenced by location only>
Test delta line: <the exact line included in the packet>

## Problems
<anything the packet does not cover; structural defects found in an existing PR body;
push/PR command failures with exact output; side effects for the cleanup ledger
— or `none` per item>
```
