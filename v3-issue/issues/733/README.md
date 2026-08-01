# #733 feat(engine): trigger 与 validator context outcome 集成

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:07Z  | updated: 2026-07-27T04:27:08Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/733
- comments: 0  | timeline events: 10

---

## Body

## 必须先读的关联 issue

继承 [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545) 的共享契约与关闭验证。

## 目标

在 trigger/validator 已迁入统一 scheduler run lifecycle 后验收正负写入与 finalize；不以无 credential 的失败路径冒充。

消费 #738 的 `[[tools]]` / `toolRequirements` 声明位：把 context CLI 注册为 `provider = engine` capability union 的第一个真实成员（含用法文档内容），其 entries 存在性条件是 outcome（确定性输出条件）的首个 variant（entry-existence）；在 run 收尾点落地对 outcome 求值的 `required | expected` 两档执法。

## 问题

#738 落地后声明位在引擎侧没有执法消费端：`required`/`expected` 声明无运行期判定，缺写不产生任何后果；context CLI 未注册为 engine capability 成员，preset 无法在 `[[tools]]` 引用它；`toolRequirementsDoc` 对 engine 工具没有用法内容可渲染。「可选的 prompt 要求必须调用某种特殊定义的 CLI 工具」（v3 目标 4 verbatim）的执法半边悬空。

## 预期结果

性质表述：

1. **capability 注册**：context CLI 是引擎闭合 capability union 的成员，携带覆盖读写两面的用法文档内容；`toolRequirementsDoc` 渲染声明该工具的 phase 时输出该用法（注入的是用法文档，不是 entry 内容）。成员经穷尽 switch 消费——新增 capability 由编译器暴露全部处置点。
2. **判定事实唯一且可计算**：判定是对该工具 outcome（确定性输出条件）的求值，provider 不参与判定——context CLI 的 outcome = entry-existence：该 run 的凭证 author 下存在至少一条 entry（entries 表存在性查询），求值的是输出条件，不是调用动作；首波 outcome union 仅 entry-existence 一个 variant。引擎不验内容质量、不看 body。
3. **required 缺写 = run 判失败**：进入现有指数退避重试链路、消耗 attempt、耗尽落 exhausted 终态——复用 `withNextSchedulerBackoff` / `exhaustItemsOverAttemptLimitForRepo` 既有机制，不自立失败通道；audit/validation 事件写明失败原因（缺 required context 写入）。
4. **expected 缺写 = 仅 validation 事件**：调度、状态、attempts 零影响。
5. **执法与 phase 种类无关**：判定逻辑只依赖「run 收尾 + 该 phase 的 toolRequirements 声明」，源码中不存在按 phase 种类（trigger / validator / 普通）豁免或特判的分支——声明即生效，对一切 run 一视同仁。
6. **未声明零扰动**：未声明 toolRequirements 的 phase，run 收尾路径行为与现状完全一致。

### 显式决策项（落地时裁，裁决留本 thread）

- 「本 run 的 scope 标识」注入形态：#406 凭证已让 daemon 端到端推导 author 与 scope 键，用法文档可能无需携带运行时 id（agent 直接调命令即可正确寻址）。按凭证推导充分性裁决；若裁定不注入具体 id（偏离 #545「CLI 用法 + 本 run 的 scope 标识」的字面），在本 thread 记录理由与 #545 登记 comment 同步。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | required 执法（RFC 关闭验证行 5） | fixture preset 声明 required 的 phase 正常退出（exit 0）但未写 context | local | run 判失败进退避重试；耗尽 attempts 落 exhausted；audit/validation 事件可见「缺 required context 写入」原因 |
| function | expected 执法（RFC 行 6） | fixture 声明 expected 的 phase 未写 context | local | 仅 validation 事件；phase 正常推进，attempts 不受影响 |
| function | required 满足零干预 | required phase 的 run 写入一条 entry 后正常退出 | local | run 成功、正常推进，无失败标记与退避 |
| function | 一视同仁（无种类豁免） | fixture 对 trigger phase 声明 required，其 run 未写 context | local | 同样判失败——与普通 phase 行为一致 |
| function | 用法文档注入 | fixture 声明 required 后渲染该 phase prompt | local | `toolRequirementsDoc` 输出含 context CLI 读写两面用法；不含任何已有 entry 内容 |
| adversarial | 判定不看 body | `bun test` 含用例：run 写入 body 为空白/控制记号的 entry，required 判定通过；未写任何 entry 时无论其他 run 写了多少，该 run 仍判失败 | local | 断言通过：判定事实仅为「本 run 存在性」，与 body 内容、他 run 写入无关 |
| type | capability union 穷尽 | `bun run typecheck`；审查 capability 成员消费 switch | local | 通过；穷尽检查在位，无 stringly 工具名分支 |
| integration | 执法证据闭环（自 #738 移交，编译半边留 #738） | 对 required 工具分别使 outcome 成立与不成立 | local | run finalize 分别通过/失败；provider 不参与判定，outcome 才是判据 |

## 依赖关系

- Depends on: #700、#705、#706、#732、#738。
- Blocks: #734、#744。



---

## Comments (0)

---

## Timeline (10)

- 2026-07-17T20:37:09Z `assigned` @RiriAgent
- 2026-07-17T20:38:55Z `cross-referenced` @RiriAgentsrc=732
- 2026-07-17T20:38:58Z `cross-referenced` @RiriAgentsrc=734
- 2026-07-17T20:39:03Z `cross-referenced` @RiriAgentsrc=738
- 2026-07-17T20:39:11Z `cross-referenced` @RiriAgentsrc=744
- 2026-07-17T20:40:07Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:48Z `cross-referenced` @RiriAgentsrc=597
- 2026-07-27T04:26:52Z `cross-referenced` @RiriAgentsrc=700
- 2026-07-27T04:26:57Z `cross-referenced` @RiriAgentsrc=705
- 2026-07-27T04:26:58Z `cross-referenced` @RiriAgentsrc=706