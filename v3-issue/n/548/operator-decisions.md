# RFC #548 · 操作员裁决记录

## D1 · schema artifact 公共载体

- **裁决日期：** 2026-07-31
- **裁决：** CLI 输出真正的 JSON Schema。
- **确定含义：**
  - PATH CLI 是跨仓 schema 获取协议；
  - schema document 与现有 compile projection instance 保持不同身份；
  - schema 从 preset 的同一权威归一模型派生；
  - schema 必须表达 preset identity、字段类型、required 与 unknown-field policy；
  - 树外消费 daemon 通过 CLI 获取 schema、校验版本并派生请求类型。
- **关联裁决：** required 权威表达见 D2；可执行 item 持久态不变量见 D3/D10；CLI typed rejection 见 D4；完整合成校验域见 D8。

## D2 · required 的权威表达

- **裁决日期：** 2026-07-31
- **裁决：** required 在 field object 内逐字段表达。
- **权威形态：**

  ```toml
  [item.fields.issue]
  type = "string"
  required = true
  ```

- **兼容口径：**
  - 旧 `field = "string"` 默认 required；
  - 旧 `{ type = "string" }` 默认 required；
  - optional 必须显式声明 `required = false`。
- **确定含义：**
  - field object 同时承载类型与必填性；
  - CLI JSON Schema 从该归一模型派生 required 集合；
  - loader、artifact 与创建校验不得分别解释 required。
- **关联裁决：** 可执行 item 持久态不变量见 D3/D10；CLI typed rejection 见 D4。

## D3 · 引擎 schema 兜底强度

- **裁决日期：** 2026-07-31
- **裁决：** 守住持久态不变量。
- **确定含义：**
  - `item add`、`item batch-add` 及所有会改变 `extra` 的 `item update` 使用同一归一 schema 校验；
  - missing、unknown 与类型错误不能经任一写入口进入新的持久态；
  - loader、CLI JSON Schema、创建与更新校验共享同一权威模型；
  - 目标保证限定为“所有可执行 item 始终符合其当前合成 schema”；terminal/deleted 历史快照不在该量词内，任何重入可执行态先过同一 gate。
- **关联裁决：** CLI typed rejection 见 D4；合成校验域见 D8；历史启动校验、扫描量词与原子修复见 D9-D11。

## D4 · PATH CLI 机器可读错误契约

- **裁决日期：** 2026-07-31
- **裁决：** CLI 定义独立但无损的 typed rejection ADT。
- **确定含义：**
  - CLI 公共错误契约不直接复制 daemon socket 的内部 envelope；
  - socket response 到 CLI rejection 必须穷尽转换；
  - missing、unknown、type mismatch、missing preset 等错误保留稳定 variant 与必要细节；
  - 当前有损的 `code: message` 文本不能继续作为机器消费契约；
  - delivery id、`consumed | not-consumed` 与消费 daemon 日志仍属于树外集成契约。

## D5 · duplicate item 的工作意图证据

- **裁决日期：** 2026-07-31
- **裁决：** `(chain, itemId)` 是规范工作身份。
- **确定含义：**
  - 相同 `(chain, itemId)` 一律表示同一工作，不再比较 payload 或增加 operation identity；
  - item 已存在时可解释为该规范工作已经被接管；
  - 调用方必须保证 itemId 映射稳定且无语义碰撞；
  - engine uniqueness 继续作为重放收敛地基；
  - CLI typed rejection / success ADT 必须能无损表达 already-existing，而非仅返回扁平 conflict。

## D6 · new-workspace 部分失败后的空 chain

- **裁决日期：** 2026-07-31
- **裁决：** 空 active chain 是长期合法状态，不归属某个 delivery。
- **确定含义：**
  - engine 不自动补种第二步，也不自动删除空 chain；
  - startup recovery 不需要从空 chain 推导待执行的 `item.add`；
  - 空 chain 本身既不证明 delivery consumed，也不证明 delivery 仍待重放；
  - delivery verdict 与重试状态必须由 router / 消费 daemon 的其他记录给出；
  - `chain.delete` 仍是显式 operator/caller 操作，不是两步调用失败的隐式补偿。

## D7 · engine 的逐请求 durable 审计

- **裁决日期：** 2026-07-31
- **裁决：** engine 新增 durable、可关联的逐请求记录。
- **确定含义：**
  - 记录稳定 request identity，以及 created / already-existing / rejected / no-op 等 typed verdict；
  - 记录必须与对应 mutation 建立明确的 durability / transaction 关系；
  - 现有 best-effort JSONL events 不能冒充该记录；
  - 消费 daemon 的 delivery 决策日志仍保留，并通过稳定 request identity 与 engine durable record 关联。

## D8 · preset schema 校验域

- **裁决日期：** 2026-07-31
- **裁决：** 合成 engine-owned 与 preset-owned 字段的完整 schema。
- **确定含义：**
  - CLI JSON Schema 暴露整个持久化 `extra` 的合成契约；
  - engine-owned control keys 与 preset-owned business fields 必须分别有权威子模型，再合成为单一严格 schema；
  - 外部调用者能够看到 engine-owned 字段契约，但不得自行写入仅供 engine 内部维护的字段；可写性必须在 schema/ADT 中明确；
  - unknown-field policy 对合成后的完整字段集合执行，不能把现有 engine keys 误判为 preset unknown；
  - loader、artifact、add/batch-add/update 校验均消费同一合成模型。

## D9 · 历史 item 的启动校验与修复入口

- **裁决日期：** 2026-07-31
- **裁决：** daemon 启动时核对历史 item；不符合当前合成 schema 的 item 标注为不可启动，并提供专门命令更新该 item。
- **确定含义：**
  - startup reconciliation 必须扫描纳入范围的历史 item，并按其 preset 的当前合成 schema 校验；
  - 校验失败不会让该 item进入调度或 spawn；
  - 失败必须形成 durable、可观察的“不可启动”状态/原因，而不是只写日志或在 scheduler 中反复失败；
  - 专门的 operator CLI 命令是修复入口，必须按同一合成 schema 校验更新结果；
  - 修复成功后清除不可启动标记，使 item 可重新进入正常调度资格；
  - 普通 engine 控制字段写回不能绕过该状态，也不能把非法历史行静默升级为合法。
- **关联裁决：** 扫描量词见 D10；修复命令以目标现存 preset + 完整合成 `extra` 为原子边界，不提供逐字段修复，见 D11。preset 缺失或 schema 漂移导致不合格时沿本节 durable“不可启动”原因表达。

## D10 · startup 历史扫描量词

- **裁决日期：** 2026-07-31
- **裁决：** 仅校验可能再次执行的 item。
- **确定含义：**
  - active、stopped 以及仍可 resume/retry 的 item 纳入 startup schema reconciliation；
  - terminal item 与所属 chain 已 deleted 的 item 保留为历史快照，不标记“不可启动”；
  - D3 的持久态保证收敛为“所有可执行 item 始终符合其当前合成 schema”；
  - 历史归档行可以不符合当前 schema，但不得重新进入可执行状态而不先经过 D9 校验/修复；
  - 从 terminal/deleted 历史态到可执行态的任何未来入口必须先执行同一 schema gate。

## D11 · 专用修复命令的原子边界

- **裁决日期：** 2026-07-31
- **裁决：** 专用修复命令可原子替换 preset 与完整 `extra`。
- **确定含义：**
  - 单次事务同时指定目标现存 preset 与完整合成 `extra`；
  - 提交前按目标 preset 的当前合成 schema 校验全部字段；
  - preset 不存在、missing/unknown/type mismatch 或 engine-owned 字段不合法时整笔拒绝；
  - 不允许出现“新 preset + 旧非法 extra”或“新 extra + 旧缺失 preset”的中间态；
  - 修复成功后在同一事务语义中清除“不可启动”原因并恢复调度资格；
  - 该命令是显式 operator 修复面，不替代正常 `item update`，也不自动猜测或生成缺失业务值。
