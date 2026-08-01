# #730 feat(cli): context scope 过滤读取与 GUI boundary

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:37:01Z  | updated: 2026-07-27T01:00:38Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/730
- comments: 0  | timeline events: 7

---

## Body

## 必须先读的关联 issue

继承 [#545](https://github.com/mouriya-s-lab/coder-loop/issues/545) 的共享契约与关闭验证。

## 目标

交付 item/chain/group 查询与 pagination 读取面。

落地 context entry 的读取命令面——经 daemon socket 的过滤查询、分页游标、以及作为 GUI 消费契约的 arktype 返回 boundary。

## 问题

地基 child 落地后 entries 只写不可读：agent 侧无任何拉取命令，#545「拉取制」读取形态没有载体；#544 的 entries 展示面没有可消费的 read boundary（其接口假设明文等待 #545 的实现 child）。

## 预期结果

性质表述：

1. **可见范围恒等于凭证所属 chain**：agent 凭证下的一切查询路径，结果集都限定在凭证所属 chain——跨 chain 零可见不依赖调用方自觉，由 daemon 从凭证推导，请求里的 chain 指定字段对 agent 无效或被拒。operator 无凭证读任意 chain。
2. **过滤维度经 arktype 请求 boundary 穷尽声明**：闭集为 scope variant + stable key、author subject/phase、`after` cursor；未声明参数被 boundary parse 拒绝，不存在隐藏过滤参数。
3. **返回 boundary 即 GUI 消费契约**：读命令返回经 arktype boundary 校验的 JSON（envelope 全字段 + 分页游标），#544 纯消费；shape 后续变更须在 PR body 显式列 diff（#544 的消费依赖）。
4. **引擎不把 entry 内容渲染进 prompt**：读取只经本命令面拉取；prompt 渲染路径（`renderPrompt`/doc builders）不出现 entries 内容注入。
5. **分页游标在 append-only 存储上稳定**：使用 `(ts, id)` 或等价单调稳定键的 keyset cursor；翻页期间新写入不导致漏读已有 entry 或重复游标。请求必须显式提供正整数 `pageSize`；引擎无魔法默认页长、无总结果截断，调用方沿 cursor 读至 exhausted。
6. 命令进 #409 编译期穷尽分类，agent 可用（区别于 `logs.query` 硬拒绝）。

### 查询契约裁决

- 过滤闭集：scope variant + stable key、author subject/phase、`after` cursor。无 topic/tag、无 offset、无自由查询字符串。
- `pageSize` 是每次请求的显式正整数，不提供引擎默认 magic number；响应返回 `nextCursor | exhausted`，调用方必须可持续翻页至穷尽。若底层 transport 出现真实单响应限制，必须引用该限制并以 boundary error 暴露，不得静默缩页或截断全集。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | scope 过滤读取成立（RFC 关闭验证行 2） | 同一 item 跨两轮 run 写 item-scope；另一 item 写 chain-scope；第三 chain 的 agent 凭证读 | local | item 谱系跨 run 可读；chain-scope 跨 item 可读；跨 chain 零可见 |
| function | agent 无法越 chain（主体对抗） | agent 凭证请求中显式指定他 chain 的标识查询 | local | 指定字段无效或被拒，结果仍限本 chain |
| function | operator 全量读 + GUI shape（RFC 行 7） | 无凭证读任意 chain entries，输出过 arktype boundary 断言 | local | exit 0；shape 与 read boundary 一致（#544 纯消费该契约） |
| function | 过滤维度逐一生效 | 对 scope、author subject/phase、after cursor 各构造命中/不命中查询（`bun test` 用例断言结果集） | local | 每维度命中集正确；boundary 外参数被拒 |
| function | 分页游标稳定 | 写入 N 条后按显式 pageSize 翻页至 exhausted，翻页间再写入新 entry | local | 已有 entries 无漏读无重复；新 entry 不打乱游标 |
| adversarial | prompt 零内容注入 | `bun test` 含用例：store 预置 body 为唯一 sentinel 串的 entries 后渲染各 phase prompt，断言渲染产物零 sentinel 命中 | local | 断言通过——entry 内容不经任何渲染路径进 prompt |
| type | boundary 精确 | `bun run typecheck`；审查请求/返回 boundary 定义 | local | 通过；请求与返回均为精确 arktype schema，无匿名 `"object"` |

## 依赖关系

- Depends on: #594。
- Blocks: #731、#734、#727。


---

## Comments (0)

---

## Timeline (7)

- 2026-07-17T20:37:02Z `assigned` @RiriAgent
- 2026-07-17T20:38:49Z `cross-referenced` @RiriAgentsrc=727
- 2026-07-17T20:38:54Z `cross-referenced` @RiriAgentsrc=731
- 2026-07-17T20:38:58Z `cross-referenced` @RiriAgentsrc=734
- 2026-07-17T20:40:04Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:44Z `cross-referenced` @RiriAgentsrc=595
- 2026-07-26T16:15:04Z `cross-referenced` @RiriAgentsrc=545