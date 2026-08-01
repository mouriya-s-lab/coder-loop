# RFC #545 R12 独立复核

## A. Verdict

**PASS**

`r12-next-batch.md` 当前只拆两项已有真实 runtime 反例、合同由 R9 固定、可在 `main + 本 issue diff` 独立验收的地基切片：

- NB-01：F-01 的 chain cleanup / restart durable 终态；
- NB-02：F-05 的真实 CLI→daemon credential attribution / classification 一致性。

两项没有互相依赖，没有吸收 CAP-IN-1～4、未来 read/group/tool/prompt，也没有新增 item-delete、internal store 封闭、exactly-once、通用 reconciliation 或 OS trust 模型。F-01/F-02/F-03/F-05 被准确表述为并列 frontier；本批选择没有被写成能力施工顺序。

本轮可以完成 R12 workflow gate；报告本身没有创建或修改 GitHub issue。

## B. 边界审计

### B.1 NB-01：PASS

NB-01 精确对应 `aggregate.md` D6/S03 与 R9 F-01 已固定的保证：

- entry 与 chain 同生共死；
- chain 到达既定删除终态后 context residue 为零；
- 故障/restart 后终态与正常路径一致；
- 他 chain 与 active chain 不受误清。

草案没有预裁实现机制。“restart 后收敛”是 durable 终态要求，既可由消除原跨事务窗口满足，也可由其他符合边界的实现满足；正文明确排除了新增通用 reconciliation。重复终结/重开只用于证明最终状态幂等，没有升级成 caller exactly-once。

边界修正完整：

- daemon internal cleanup primitive 被明确保留为实现底料，不再当作产品旁路；
- 不定义 item 删除与历史 entry 的新语义；
- 不吞 active-chain admission、F-02 audit/transport 或 F-03 exactness；
- consumer 不得通过 read 过滤 residue冒充生命周期修复。

### B.2 NB-02：PASS

NB-02 属于本 RFC 的 F-05 地基，不是从旁支 bug 临时生成的新需求：

- R9 F-05 已记录“CLI credential tuple 与 daemon auth Record 双源且已漂移；遗漏新命令会把 agent 调用退化成 operator”；
- R9 要求 operator/agent typed 区分、无 permissive classification fallback，并点名 real CLI credential composition 与分类守卫；
- R7 D-05 已通过真实 CLI→daemon 路径证明 `chain.updateBindings` 的 agent env credential 被 CLI 丢弃，daemon据字段缺失走 operator 分支。

草案的稳定合同唯一：对于 daemon auth contract 判定为 credential-sensitive 的命令，真实 CLI 不能丢掉 agent identity；daemon仍是 credential resolution 与具体授权决定的权威。它没有把 CLI 注入当成安全边界，也没有让 CLI 自行授权。

范围守卫充分：

- **没有吸收所有命令。** 目标是 daemon typed auth contract 中 credential-sensitive 的命令；现有 `read-no-auth` inspection命令明确保持原语义。
- **没有吸收 future read。** context read 的 chain-bound class、selector confinement、raw socket对抗和 J-02仍由未来 read owner建立。
- **没有吸收 OS trust。** operator仍是当前无 agent credential 的 typed路径；socket peer UID、权限、operator token或第三主体均不在本 issue重设计。
- **没有吞 handler业务授权。** NB-02只保证身份到达并触发既定 daemon resolution/classification；每个 handler 是否允许该 agent仍由 daemon拥有。
- **没有新增字符串清单机制。** 草案要求复用闭合 typed command/auth合同并建立穷尽处置，明确禁止第二份可漂移清单或 compatibility shim。

其交付保证也没有宣称完整 F-05 或 J-02完成，只生产后续 read/group/enforcement 可消费的 identity wiring 切片。

### B.3 并列 frontier 与滚动批次：PASS

R11 E.1 将 F-01/F-02/F-03/F-05都列为本 RFC 内、无外部 CAP 阻断的待修地基。R12 当前没有声称 NB-01/NB-02 比 F-02/F-03更前置，而是给出本轮选择门槛并保留下一轮重拆：

- F-02 有多个可独立保证，尚需继续收敛最小 issue 边界；
- F-03 不把生产 malformed存量未知改写成清洁或清洗保证；
- F-01其他条款不再从 internal store/tests 或无产品 caller 的 item delete生长需求。

这符合“只拆现场足够清楚的下一批”，没有一次写完整未来树，也没有用 DAG 表达施工顺序。

## C. 依赖与接缝

### C.1 NB-01 / NB-02 独立性

两项可分别在当前 main 加自身 diff 上验收：

- NB-01 只需 chain soft-delete/status、SQLite context storage、daemon restart；
- NB-02 只需 daemon command/auth ADT、credential registry、真实 CLI注入路径。

NB-01 不需要 CLI classification修复来制造或观察 cleanup residue；NB-02 不需要 context lifecycle修复来观察 fabricated/live/inactive credential是否到达 daemon。因此二者之间没有验收边。

### C.2 后续 consumer 接缝

- NB-01 为 J-01 查询集合、J-03 durable existence、group restart及 F-03 reopen proof提供生命周期输入，但不完成任何 J。
- NB-02 为 J-02、J-06/J-07提供 CLI/daemon identity wiring；future read仍须自行证明 chain confinement、request/result ADT和raw socket行为。
- NB-02 对 N-E02/N-E10只提供 credential-derived identity底料，不建立 outcome、finalize或typed verdict。

正文对 F/J/N 的“推进上游前提”与“仍保持未来”表述诚实，没有以局部切片宣称完整 foundation或原子需求关闭。

## D. 验证审计

### D.1 命令合规

两项均要求：

```sh
bun run typecheck
bun test
bun run test:integration -- --log-file /tmp/rfc-545-nb-XX-integration.log --foreground
```

符合 repo 规则：

- 默认 gate 包含 typecheck + unit；
- integration使用必填 `--log-file`，并以 `--foreground` 阻塞；
- 命令在本地运行，`/tmp` 日志路径合法；
- real-e2e 逐字句完全符合 `CLAUDE.md`；
- 两项新增行为均不经过既有两阶段 stub-runner路径，不运行 `engine-integration.ts` 的判断合理。

### D.2 NB-01 直接场景

场景覆盖正常终结、原故障窗口、restart、重复终结/重开、他 chain隔离、active chain不误清及非-context soft-delete数据保持。它们直接观察 durable DB终态，不能由成功直线、unit或旧 preset替代，证明范围与主张等宽。

### D.3 NB-02 直接场景

场景同时覆盖：

- fabricated/unknown credential通过真实 CLI后必须触发 daemon resolution并拒绝；
- live credential调用 agent禁止命令时按 daemon class拒绝，不能记为operator；
- 至少一条 agent允许命令的正向 identity路径；
- inactive credential拒绝；
- command union新增未处置 variant的编译/确定性守卫失败；
- 无 agent credential 的operator现有行为。

要求真实 CLI子进程 + 真实 daemon，并观察 metadata终态与 caller classification，准确覆盖 R7 已证的组合盲点。daemon-only手工 credential、CLI mock、typecheck或旧 preset均被明确排除为替代证据。

## E. 阻塞项

**无。**

两份 issue 草案均可由 main 与自身 diff解释和验收；没有需要操作员裁决的产品分叉，也没有依赖未来 issue才能说明的 acceptance contract。

## F. 非阻塞后续

- F-02、F-03、F-01其余 authority/admission 与 F-05 future read confinement继续留在并列 frontier，须在实现推进后按 WORKFLOW 重跑必要的 R2–R11子集再拆。
- production malformed存量、response真实极限、read concurrent append集合与未登记外部 consumer继续保持未知。
- CAP-IN-1～4、read/group/enforcement/docs及冻结 SHA综合复核均未被本批吸收。
- R12通过只证明草案边界可用；不等于授权创建 GitHub issue、实现代码或 worktree。
