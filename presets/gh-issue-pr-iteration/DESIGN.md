# gh-issue-pr-iteration 设计书

本文件是这个 preset 的设计思路记录，写给改 prompt 的人。它不注册进 preset.toml、不被引擎加载、不被任何文档引用——只解释这套 prompt 为什么长成这样。结构性的"什么文件在哪"看 `docs/gh-issue-pr-iteration-fragments.md`，本文只讲为什么。

## 前提零：本 preset 禁用 subagent

Runner 不允许在任何 phase 里派子任务 / 委派给 nested runner session。历史上 iteration 与 review 是"调度者"形态——按 dispatch contract 把工作发给 subagent 让它去执行/复核。现在这一层被抽掉：每个 phase 的 entry agent 在自己那一次 spawn 里把工作走完，不产生 orchestrator+worker 的二级层。

- 独立复核不靠 review session 里派 subagent，靠 phase 拆分：diff-audit 与 verification-audit 各是独立的 fresh-session phase，出 durable 报告 packet 给 review 消费（前提二重新定义了 phase 图；前提四重新定义了信任来源）。
- Runner transport（spawn / notification / follow-up / cancel）不再进入 preset 描述范围——没有 dispatch 就没有 transport 面需要抹平。`common/dispatch-contract.md` 已从 fragments 列表移除。
- Iteration 里 verify 与 e2e 从 subagent 并发派发改成同一 session 内 sequential 执行（verify → e2e，e2e 需要 verify 观察到的 committed HEAD）。verify 或 e2e 里发现的失败在同一清单插入 `implement — fix: <failure>` 步骤，再顺序重跑二者。

**这是设计决策，不是临时安排**：dispatch 层带来的 orchestrator+worker 复杂度（同 session 里维护 subagent 生命周期、cancel 语义、shell / CLI / HTTP 三 runner 的 transport 差异抹平、报告结构与主 session 判断的对齐）替换成 phase 拆分的直接成本（多两个 fresh-session spawn、多两份 durable 报告 packet）后，可读性与信任边界都更清晰。

## 前提一：runner 诚实但会犯错

支持的 runner 是 Claude / Codex / OpenCode，具体默认值由 `preset.toml` 决定，item 还可覆盖非 trigger phase。它们不会故意钻空子——诚实是 baseline，指令没写清就问、判据看得见就照着做。但诚实不等于不出错：会误读 issue、会跳步骤、会把 "似乎没变化" 当成 "已完成"。设计要点由此推出：

- 不堆双受众隔离与措辞警察式条款：步骤合同是单文件（Task / Report / Acceptance 三段同页），判据对执行者可见是有意设计；quality 判据也是单文件（执行侧约束与判断侧规则同源同文）；不做 issue body 篡改检测、不做每字段必填 SHA/URL/timestamp 的重模板、不写 "immutable / verbatim 亲读逐块比对" 的 Intent/Result 警察语——这些对诚实 runner 的 token 税与维护税盖不住其收益。
- task decomposition 属于 preset：引擎没有运行时任务拆分能力，iteration 以当前 executable-contract marker 的 Deliverable / Checks 动态建清单，issue body 只供 intent 对照。清单由 iteration entry 在自己那一次 spawn 里管理（前提三），不再有 dispatch contract。
- 保留独立复核（verification phase 的 fresh-session 独立执行、diff-audit 与 verification-audit 各自 fresh-session 出报告、e2e 直跑证据、runtime manifest）——诚实 agent 也会漏看，产出者的验证不作数，review 不看独立报告就是盲判。
- 过程纪律以 superpowers skills 为设计参考蒸馏进 step 文件：TDD 的 test-first 铁律、"根因先于修复、三次失败停手"、claim gate（先跑当轮命令读全量输出再落成功措辞）、"review 反馈是待核实的主张"——取纪律内核，按无人值守 loop 改编后内联（见前提八）。preset 自包含，不做运行时 skill 调用。

## 前提二：八 phase 的分工——产出、验证、发布、两轮独立复核、裁决、终局互为信任边界

preset 声明八个普通 phase：`contract-enrichment` → `iteration` → `verification` → `publish` → `diff-audit` → `verification-audit` → `review` → `closure`，外加 `blocked-responder` / `umbrella-finalizer` 两个 trigger phase。enrichment 先把 intent 调查为 durable executable contract；后继 phase 只消费 current marker packet，phase 之间以 GitHub 上的 durable packet（`common/packets.md`：CandidateRef / VerificationPacket / DiffAuditReport / VerificationAuditReport / ReviewVerdict）交接，谁都不信谁的自述，也不看其他 phase 的 scratch state。

- **contract-enrichment**：只运行一次，调查源码、target rules 与 runtime，在 GitHub comment 发布 typed executable contract；不修改 issue body。
- **iteration**（单 session）：读 issue intent 与唯一 current marker，按 marker Deliverable 从四种路径中选一条（implementation-PR / blocker-removal / source-writing-spike / spike-comment），亲自走完 research → implement → verify → e2e → submit（或对应的 spike 序列），产 **draft** PR 或 comment + 绑定 exact pushed head SHA 的 CandidateRef。唯一声明 `startsAttempt` 的 phase：一次 attempt 覆盖整条后继链，两个 audit phase 的 non-clean 出口通过 `changes_requested` 回 iteration 才消耗新 attempt。
- **verification**（单 session）：在 fresh session materialize CandidateRef 指向的 revision，独立执行全部 contract checks、target-required suites 与一次真实 E2E——不修改产品源码——发布 VerificationPacket。产出者的验证不作数，这里才是执行真值。
- **publish**（单 session）：revision join 后按 VerificationPacket 组装 ready deliverable（PR title / body / Closes / 四层 evidence），把 draft 翻 ready，同步 branch/pr 镜像字段。只发布已验证的 SHA。
- **diff-audit**（单 session，纯读）= scope / 卫生 / 代码真值 / 测试完整性。锚定 issue intent 与 marker 明确化的设计、Pattern scope 和 Test delta；每条发现必须带可追溯锚点，不自行扩大范围。出 **DiffAuditReport** durable comment（fenced `coder-loop:diff-audit-report` json + markdown body），verdict ∈ {`clean` / `changes-requested` / `contract-invalid`}。不动 code / evidence / PR body。
- **verification-audit**（单 session，纯读 + 有界抽查）= packet 链 / identity / 覆盖真值。解析 CandidateRef → VerificationPacket，三方 SHA identity binding，check 覆盖表核对 marker Checks 是否逐项执行且绑定同一 SHA，runtime 记录与 conclusion 一致性，有界 spot 复跑抽查个别 check——不复跑 canonical suite、完整 check 表或 E2E。出 **VerificationAuditReport** durable comment，verdict ∈ {`clean` / `verification-drift` / `changes-requested` / `contract-invalid`}。`verification-drift` 回 verification 让它对同一 candidate 重跑；其余走 iteration / enrichment 路径。
- **review**（单 session）：读两份 durable 审计报告 + 亲自做 7 项 self-judgment（trace / PR protocol / title-intent / caveat / evidence form / checks-mergeability / cross-round regression；后两者消费 VerificationPacket 与 VerificationAuditReport 的记录，不重开 artifact、不重复 live 读取），落 verdict：accepted / moot 写 durable ReviewVerdict 后干净收尾进 closure；retry / reenrich / blocked 写 status；stop 走 exit-action。不再自己派 subagent 也不再自己 audit——PR-backed 路由缺任一份 audit 报告 verdict 一律无效。不 merge、不 close、不写 done/moot。
- **closure**（单 session）：重读 live state 做 drift 检查（sameness 路由回产出该 artifact 的 phase），按序执行 merge / unblock / close effect，确认 live terminal state 后最后写 `done` / `moot`。终局状态只由它写。
- **blocked-responder**：跨仓 unblock 副作用的最小化 responder。
- **umbrella-finalizer**：chain-complete 时的 umbrella 收官。

trigger 角色任务简单，单一 entry prompt，agent 一次跑完。全部普通 phase 都是单 session 形态（前提零把 iteration / review 从"调度者"退回单 session 执行者），没有嵌套。

## 前提三：iteration 的任务清单在自己的 session 里维护

"任务清单"不再是调度者向下派发的 dispatch 列表，而是 iteration entry 给自己写的执行清单。仍然是脊柱，形态是自我纪律而不是转发合同：

- 列表先于执行写出，每行注明这一步的产出与验收条件。
- 每行只有两种出口：`[x]`（自己按 runbook 的 Acceptance 判过再勾）或 `[-] skipped: <理由落进 handoff>`。
- verify / e2e 里发现失败 → 在清单里插入 `[ ] implement — fix: <failure>`，修完顺序重跑 verify → e2e 覆盖整条契约。
- 每一步的 runbook（`iter/steps/*.md`）在同一 session 内读并执行；`Task` 段是自己的动作序列、`Report` 段是自己的 handoff 备注、`Acceptance` 段是勾 `[x]` 前的自检门槛。

review 一侧不再有"审阅任务清单"——它只按行为读两份 durable 审计报告并做 self-judgment（前提四）。

## 前提四：review 的信任来自 phase 独立性，不来自派 subagent

完整的独立执行（contract checks 逐项、canonical suite、真实 E2E）由 verification phase 在 fresh session 承担；两轮独立复核（diff-audit + verification-audit）也是各自的 fresh-session phase。review 不派 subagent、不再自己重跑 audit，它读两份 durable 报告 packet + 亲做诚实 / 协议 / caveat / evidence-form / checks-mergeability / cross-round regression 判断。

这一层信任边界的关键是 **session 边界，不是主 session 内的 subagent 隔离**：

- 审计需要 fresh、无污染的判断——如果放在 review 主 session 内让 subagent 干，review 的 prompt 还是同一份，还是可能被 iteration/publish 的 handoff 污染。拆成独立 phase 后，diff-audit 和 verification-audit 的 spawn 是 fresh session，读的是 durable packet 与 live GitHub state，无法被 review 视角内的既有结论带偏。
- 报告落 durable comment（不落 review session 的 scratch）意味着 review 消费的证据永远是 GitHub 上可复核的对象——就算 review 想放水，reviewer / operator 也能拉出报告核对。
- 若 review 不同意某份 audit 的 verdict，路径是把 item 通过 graph route 送回相应 audit phase 重跑（audit 自己也可写 `verification_drift` / `changes_requested` / `contract_invalid`），不是在 review session 内影子重审。

对称原则不动：**review 绝不替被审工作修**。code / evidence / PR body 都不动，只发 retry 反馈。**diff-audit 与 verification-audit 同理不动被审工作**，它们只写自己的 durable 报告。

## 前提五：交付物必须以真实形态跑过，环境是交付物的一部分

unit/integration 测试是辅助层。正规 E2E 产物必须驱动真实消费面：程序的操作者入口、web 的真 UI，或 target rules 明确命名的 real E2E driver。该 driver 可以是仓库脚本；判据是它是否实际驱动真实路径，不是文件形态。

auth 和 binary 永远是执行者自己解决的：交付物要么是能自己起环境的单体程序（起环境时自铸 auth），要么是 IaC 基建里服务的插件（机器上必有可解析的 auth）。"no auth" / "no binary" 就是未完成的 setup，不是可报告的 blocker。

环境交接闭环：iter 跑完 e2e 后声明 `durable` 或 `recreatable`。前者交稳定 owner/liveness，后者交 clean source SHA 与 setup/start/readiness/behavior/stop；verification 执行者按 kind 穷尽复驱，并在接手环境时负责其 teardown（packet 的 `runtime.cleanup` 记录结果）。manifest 缺项是 packet 失败；review 与两个 audit phase 都不复驱 e2e runtime（review 读 durable 报告，verification-audit 只做有界 spot 抽查）。

e2e 单独成步而不并入 verify：捆在重步骤里的麻烦环节会被整体跳过——单独一行清单 + 独立验收，跳过就关不掉清单。禁 subagent 之后 verify 与 e2e 在同一 iteration session 内 sequential 跑：verify 先，e2e 后（e2e 观察的是 verify 观察到的 committed HEAD）。verify / e2e 里发现失败 → 清单插入 `implement — fix`，修完顺序重跑二者。

## 前提六：每次运行无状态，GitHub 是唯一持久层

每次 spawn 的 agent 是独立进程，无跨轮记忆；本地文件会丢、会损坏、跨机不可用。持久业务语义只能落 GitHub（issue body / labels / comments / PR thread）。由此：

- executable contract 落 issue comment；`common/executable-contract.md` 按 marker schema / source revision / Supersedes 选唯一 current packet，shared.md 永不是权威副本。
- issue↔PR 关联只认结构性链接（closing keyword 图，GraphQL `closedByPullRequestsReferences` 分页到穷尽），不做 body 文本搜索。
- retry 的指令源是 PR 的全量读取（body + 全部 comments + 全部 reviews + inline review threads）。最新 retry comment 与 PR body 的 caveat 段（scope-reduction trigger 可能出现的位置）要求原文引用；其余允许摘要——verbatim 收窄到判断依据可能被消歧的位置。
- 单 session phase 亲自读的是核心少量项 + 一跳图引用；bulk 材料通过 `coder-loop:current-state` 索引按名拉取（前面 audit 报告 / VerificationPacket / CandidateRef 全在这个索引里），避免整条 comment 时间轴 replay。禁 subagent 之后不再有"派 investigator 去读长材料"的分支——需要读就自己读，或路由回上游 phase 让它出一份 durable 摘要。

## 前提七：Intent/Result 是工程日志，不是警察证据

iter 仍在 handoff 写 `Intent (run <RUN_ID>)`（动工前，声明 scope 与理解）与 `Result (run <RUN_ID>)`（完成后，声明 delta）。review 对照 Intent 与 Result 判断 scope 是否缩水——这是 intent-action mismatch trigger 的输入。

不配套"immutable / 禁止回填 / review 必须 verbatim 亲读逐块比对"这类警察语言。诚实 runner 没有系统性地伪造 Intent 的动机；写清楚就够，不用把每次读都变成侦查。

## 前提八：superpowers 是设计参考，不是运行时依赖

step 文件里的过程纪律段以 superpowers 插件（参考版本 v6.1.1）的 skill 原文为素材蒸馏而来，preset 自包含——不在运行时调用 `superpowers:*`。理由：运行时调用把 prompt 行为耦合到 runner 机器的插件安装与版本；skill 原文按交互式结对场景写（"ask your human partner" 分支、用户确认 gate），无人值守 loop 里这个人不存在；全文加载还会把大段不相关内容拉进 executor 上下文。

蒸馏落位与改编：

- `implement` 的 **Process discipline** 段 ← `test-driven-development`（test-first 铁律、"立即通过的测试什么都没测"）+ `systematic-debugging` + `receiving-code-review`；TDD 例外与测试变更权由 marker `Test delta` 决定。
- `verify` / `e2e` / `submit` 的 **Claim gate** 段 ← `verification-before-completion`（先跑当轮完整命令、读全量输出与 exit code、再落成功措辞；"启动成功"是 startup 证据不是行为证据；本地状态不等于 live）。判据侧的 claim↔observation 审计本就在 `quality/evidence.md` / `quality/honesty.md`，Claim gate 只补执行者动手时刻的程序性纪律。

未吸收：`brainstorming` / `writing-plans` / `executing-plans`（交互确认 gate）、`finishing-a-development-branch`（4 选项分支与 issue→PR 强流程冲突）、`using-git-worktrees`（preset 有自己的 worktree 纪律）。插件升级后要吸收新内容，重读原文再改 step 文件——不是改成运行时调用。

## 前提九：一致性铁律（防 livelock）

规则各有唯一事实源：`common/executable-contract.md` 拥有 authority/currentness，`enrichment/contract-schema.md` 拥有 packet schema；entry 拥有任务拆分与路由，step/quality/action 各自拥有执行、判据与副作用。其他文件只引用，不复述完整规则。

## 写 prompt 的人最容易犯的错（本 preset 的事故记录）

- 站在作者视角写 why-and-how，读者视角下等于没写。每一句要回答的是读者此刻的问题：现在做什么、拿什么做、做完判断什么。
- 防作弊措施写过头变成自相矛盾（"PR body untouchable" 与全局路由模型冲突造成 livelock）。防的是重写叙事，不是结构修复——划界要划在动机上。
- 占位符不绑定（`<scratch>` 落哪没说）、API 失败语义不定义（sub_issues 404 算什么）、固定 cap 静默截断（first:10）——每一处含糊都是一个未来的卡死点或假阴性。
- 工具名写进机制描述（send_input / Task tool）会把 prompt 锁死在特定 runner 上；写机制（"同一 subagent 的 follow-up"），runner 自己映射。
