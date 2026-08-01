# #713 feat(engine): preset 级具名 gate 点声明与绑定解析

- state: **open**  | author: `RiriAgent`  | created: 2026-07-17T20:36:23Z  | updated: 2026-07-27T04:27:02Z
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/713
- comments: 0  | timeline events: 9

---

## Body

## 必须先读的关联 issue

继承 [#543](https://github.com/mouriya-s-lab/coder-loop/issues/543) 的共享契约与关闭验证。

## 目标

消费已落地的共享 gate decision ADT，不复制或预猜类型。

preset 声明的具名 gate 点获得执行语义：全局/chain 层绑定声明（gate 名 → 脚本 + 超时 + onFailure）、运行期在声明点解析绑定并执行 gate、未绑定语义（optional 空过；required 在实例创建边界拒绝；已存在实例恢复时缺绑定则显式 hold）。

## 问题

#740 只做声明位与产物暴露（语义零实现，见继承快照）；绑定声明、运行期查找、未绑定语义全部悬空——RFC 关闭验证行 5 的 preset 层份额与开放问题「preset 抽象 gate 点未被任何层绑定时的语义」无处成立。

## 预期结果

性质表述：

1. **绑定声明**：全局/chain 层可声明 gate 名 → 脚本绑定（含超时/onFailure），arktype 边界 parse，进#586（声明模型） 的生效视图（preset 层成员，合成顺序位置 = preset）。
2. **解析三态穷尽**：装载时每个 preset 声明的 gate 点解析为穷尽三态——已绑定（执行如普通 gate，走统一评估路径零特例）| 未绑定 optional（空过，跳过事件可见）| 未绑定 required（新实例创建拒绝；既有实例恢复 hold）；无 default 兜底。
3. **可分发性质**：preset 本体（toml + 模板）中不存在本机脚本路径的通道——绑定只在全局/chain 层。
4. **执行同路径**：绑定后的 gate 执行与其他层 gate 走同一协议/onFailure/合成实现，无 preset 层特例代码。

### 绑定解析裁决

- preset compile 不依赖某台机器的绑定，因此 required 未绑定不在 compile 期伪报。chain/item 实例创建时解析 effective binding：required 缺失则结构化拒绝创建并点名 gate；optional 缺失空过且发 skip 事件。已存在的 pinned 实例在 daemon 重启时若 required binding 丢失，进入可观察 hold，不回退到 optional、不换脚本。
- 同名绑定采用配置覆盖语义：chain binding 覆盖 global binding；只有一个 effective script 作为 preset 层 gate 执行，不把两份绑定都跑。global/chain 自己声明的普通 hooks 仍按四层合成各自执行，与“为 preset named gate 提供绑定”是两种不同角色。生效视图必须同时显示 selected binding 与 shadowed source，便于审计。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 绑定执行（RFC 行 5 preset 层份额） | fixture preset 声明具名 gate 点，chain 层绑定 fixture 脚本（hold→advance），真跑 | local | 声明点按 preset 层合成顺序执行该 gate；hold/advance 行为与其他层 gate 一致 |
| function | optional 未绑定空过 | optional gate 点零绑定，真跑 | local | 调度照常推进；跳过事件可见 |
| function | required 未绑定 | required gate 零绑定分别创建新实例、恢复既有 pinned 实例 | local | 新实例结构化拒绝创建；既有实例 hold；两者都点名 gate，无 optional fallback |
| function | 层间遮蔽/回落 | 同名 binding 同时置于 global 与 chain 层 | local | 只执行 chain binding；生效视图显示 selected chain + shadowed global；普通 global/chain hooks 不受影响 |
| function | 可分发性质 | grep fixture preset 全文 | local | preset 本体无本机脚本路径 |
| integration | 四层全景合成（RFC 行 5 完整化） | 全局 + chain + preset（绑定）+ item 同挂点各声明一个 gate，其一 hold，真跑 | local | 按 全局→chain→preset→item 顺序执行（脚本记录执行序）；任一 hold 即整点 hold——RFC 行 5 全语义在此行成立 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 架构切片

1. **系统定位**：hook 声明面的 preset 层间接绑定级——「接口与实现分离」在声明模型上的实例：preset 声明需求（名字），operator 声明供给（绑定），装载期做需求-供给匹配。
2. **全局坐标**：preset 声明域（可分发工件，#740 编译产物）× operator 绑定域（本机全局/chain 声明）→ 装载期匹配 → 生效视图 preset 层成员。两个输入域各自已有边界 parse，本 child 拥有匹配语义与三态结果类型。
3. **类型↔值不漂移**：防值漂移——gate 名在 preset 与绑定两侧是同一标识符空间，匹配结果三态穷尽，不存在「绑了但没被看见」的静默中间态。防类型泄露——本机路径不得进入 preset 域（可分发性质）。
4. **消除的错误类别**：「preset 需要的 gate 漏配且无人知晓」不可表达（三态 + required 裁决语义 + 编译产物暴露）；「preset 携带本机路径失去可分发性」不可表达。

## log/观测义务

- optional 未绑定的空过跳事件（lifecycle/diagnostic 按裁决定）——「为什么这个 gate 点没拦」可从事件流回答。
- required 未绑定按裁决形态产生 load 错误或运行期拒绝事件，点名 gate 名。
- 绑定执行本身沿统一 `hook.*` 事件契约（#712（决策点闭集） 已铺）。

## 依赖关系

- Depends on: #549、#586、#710、#712、#740、#743。
- Blocks: #715。



---

## Comments (0)

---

## Timeline (9)

- 2026-07-17T20:36:24Z `assigned` @RiriAgent
- 2026-07-17T20:38:27Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:38:30Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:38:34Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:39:06Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-17T20:39:41Z `parent_issue_added` @RiriAgent
- 2026-07-17T20:41:07Z `cross-referenced` @RiriAgentsrc=591
- 2026-07-26T16:15:00Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-27T04:27:12Z `cross-referenced` @RiriAgentsrc=743