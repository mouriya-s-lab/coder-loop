# coder-loop 只读巡查清单

巡查是只读工作。目标是回答 “loop 是否还在推进、卡在哪里、GitHub 侧是否一致”，不是修改 chain、item、issue、PR 或本地 runtime。按下面顺序执行；前一层给出 WARN / ERROR 后再下钻。

| Step | Command | OK | WARN | ERROR |
|---|---|---|---|---|
| 1 daemon | `coder-loop daemon status <target> --json` | central daemon reachable，target chain 可解析 | daemon 活着但 target 没有 selected/current | socket 不可达、daemon 无响应、scanError 非空 |
| 2 target | `coder-loop status <target> --json` | `.state.kind == "ok"`，queue/current/events/processes 可读 | selected 为 null 但 GitHub parent 仍 open | `missing-*` / `invalid-*` state kind |
| 3 doctor | `coder-loop doctor <target> --repo <owner>/<repo>` | bootstrap layers 与 runner CLI 全 OK | optional skill copy stale | PATH / gh auth / preset / workflow 缺失 |
| 4 chain | `coder-loop chain status <chain-name> --json` | chain active，item counts 与 status 一致 | chain completed 但 umbrella open | chain missing/deleted 或 runtime layout 不可解析 |
| 5 item | `coder-loop item list <chain-name> --json` | queued / blocked / done 分布符合预期 | terminal item 仍有 open GitHub issue | duplicate id、非法 status、依赖未满足却被调度 |
| 6 active run | `coder-loop status <target> --json | jq '.current, .events.latest'` | `lastEventAt` 近期更新或 phase clean exit | 长时间无新事件但进程仍有 CPU/IO | exitCode 非 0、signal 非 null、attempt timeout |
| 7 GitHub issue | `gh issue view <issue> -R <owner>/<repo> --json state,labels,comments,closedByPullRequestsReferences` | issue state 与 queue status 一致 | issue open 但 local terminal，需要 review 解释 | issue closed 但 local queued，或 label kind 缺失 |
| 8 GitHub PR | `gh pr view <pr> -R <owner>/<repo> --json state,mergedAt,reviewDecision,statusCheckRollup,closingIssuesReferences` | PR state / mergedAt 与 item verdict 一致 | reviewDecision 空或 checks pending | PR open 且 item done，或 merged PR 未关闭 issue |
| 9 checks | `gh pr checks <pr> -R <owner>/<repo>` | required checks pass | pending / skipped 有说明 | failed checks 且 review accepted |

## GitHub 侧读取

GitHub 侧只读取 issue / PR / checks metadata，不用 GitHub API 或 raw URL 读源码内容：

```bash
gh issue view <issue> -R <owner>/<repo> --json number,state,labels,comments,closedByPullRequestsReferences
gh pr view <pr> -R <owner>/<repo> --json number,state,mergedAt,reviewDecision,statusCheckRollup,closingIssuesReferences
gh pr checks <pr> -R <owner>/<repo>
```

## 何时下钻 run artifacts

只有当 `coder-loop status <target> --json` 返回具体 artifact 路径时才读取 run files：

```bash
STATUS=$(coder-loop status <target> --json)
echo "$STATUS" | jq -r '.events.path // empty'
echo "$STATUS" | jq -r '.current.phaseStatus.value.outputPath // empty'
echo "$STATUS" | jq -r '.current.phaseStatus.value.statusPath // empty'
```

不要把旧巡查入口当成当前入口。巡查清单不引用旧 `state.json`、`.dev-loop` 或 `sync-daemon-registry`；如果这些字符串在其他文档中出现，应只属于 legacy、ignore、迁移或反例说明。
