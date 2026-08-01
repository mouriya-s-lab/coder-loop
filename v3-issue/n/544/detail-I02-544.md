# RFC #544 R7 细节 I02：status 精确 boundary 与最终 wire 等价性

> 固定事实面：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。唯一设计锚点：AGG D3；R5 L03/L04/L10；R6 I02。本文只调查现状，不裁决所有权、未来 route/UI 或修补形态。

## A. 主 agent 摘要（最多一页）

### 结论与置信

**高置信：当前 status 有两个并存、却不等价的对象契约。** builder 返回手写 `CoderLoopStatusSnapshot`；私有 `StatusSnapshotBoundary` 只要求七槽是 ArkType 的宽 `object`、`taskTree` 是递归 exact ADT 或 null。两个 CLI 入口在 builder 内 assert 一次、输出前再 assert 一次，但随后私有 `flattenExtraReplacer` 递归删除每个 JSON-object 的 `extra` 容器并把其键平铺。因此：

- 七匿名槽对字段名、必填字段、嵌套类型和额外键没有运行时约束；数组、Date、函数等也可先被 `"object"` 接受。`taskTree` 是唯一会拒绝非法/extra shape 的槽。
- assert 后确有已发生的 wire 改写：生产 `item.extra` / `current.run.extra` 被平铺；冲突时显式字段（`rest`）覆盖 extra；任意未来/意外名为 `extra` 的 JSON object 也被同一 generic replacer 改写。
- 最终 wire **可以被当前宽边界复 parse 不等于与被验证对象等价**。真实 missing-state CLI 样本复 parse 成功；平铺样本也复 parse 成功但对象已不同。相反，Date/函数等被宽边界接受后会 stringify 成 string/被删除，最终 wire 复 parse 失败。这同时证明“复 parse 成功”只证明七槽仍为 object，不证明 D3 精确等价。

### 完整因果、放大条件与影响

1. status 最初以手写 TS shape + coarse root ArkType 同批加入；后续字段持续扩张，boundary 七槽未随之细化。`TaskTreeSnapshotBoundary` 后加时只把第八槽接成 exact predicate，形成平行强度。
2. `extra` 从 index-signature 收口为 `JsonObject` 时，为维持既有透明 wire，序列化器被放在 assert 后；它不是某个 item adapter，而是 JSON.stringify 的递归全对象 replacer。
3. builder 靠 TypeScript/各上游 parser 产生通常可序列化值，所以常态样本看似稳定；放大条件是外部/测试构造绕过 TS、宽槽新增非 JSON 值或任何层出现 `extra`。这时值会在 boundary 接受后被丢弃、null 化、字符串化、平铺或直接 stringify 崩溃。
4. 直接消费者分裂：内部 doctor/daemon-start/tests 消费 builder TS 对象（含 `.extra`）；CLI/shell/supervisor/docs 消费平铺 wire。生产 boundary 与 serializer均不导出，外部无法由同一精确边界获得类型；唯一 CLI reparse 测试自建只含 `events.recent` 的局部 boundary。

**消费者影响：** `.state/.queue/.current/.processes` 拼错字段仍能过生产 assert；CLI 契约明确要求 `queue.selected.item.<field>`，而内部对象要求 `.item.extra.<field>`；extra 冲突无错误、由 base 字段胜出；未来 gateway 若只导入 builder 类型看不到 wire 改写，若只 JSON.parse 又无生产 parser可用。

### 根因集合、症状修补边界、资产与未知

- **根因集合：**（R1）boundary 七槽是存在性/对象性护栏，不是 domain schema；（R2）TS shape 与 runtime boundary 独立手写且 boundary 私有；（R3）generic post-assert replacer承担透明字段协议，验证对象与传输对象分叉；（R4）测试从 builder字段或自建局部 schema验证，未闭合 builder→assert→replacer→wire→同边界链。
- **症状修补边界：** 单加 wire reparse 测试不能发现“改写后仍是 object”；只导出当前 boundary不能获得精确类型；只给七槽补字段而保留 post-assert generic transform仍不能证明对象等价；只删 replacer会改变已登记的透明字段 wire。本文不据此选择未来修补。
- **可保留资产：** taskTree 的 exact recursive validator/ADT；各 builder的命名 TS types与局部 parser；events 入 builder 前 JSON round-trip；生产 CLI确有两次 assert；真实 stable read face和现有 wire文档/测试可作兼容样本。
- **未知：** 本轮未用真实活 chain穷尽所有 optional分支；未证明所有历史持久 extra key是否与 base key冲突；未判定 D3 最终所称“被验证对象”应是 domain snapshot还是投影 wire（不能由现状倒推）。
- **下一步事实输入：** D3 主报告应同时携带精确的 domain→boundary→wire阶段表、现有平铺兼容样本、八槽正反例与最终 wire复 parse结果；不得把“当前边界复 parse成功”写成精确契约已成立。

## B. 证据附录

### B1. 数据流与每一变换点

| 阶段 | 现存对象/函数 | 实际允许或输出 | 接受、丢弃、改写点 |
|---|---|---|---|
| 上游 domain | SQLite rows、preset、phase status、observability event、`ps`/daemon RPC、task runtime tables | 多个已局部 parse 的 domain records | 上游各自 parser负责局部输入；不能替代总快照契约。 |
| snapshot TS | `CoderLoopStatusSnapshot` + 七个命名 slot types + `TaskTreeSnapshot` | 编译期声明完整字段；item/current run保留 `extra: JsonObject` | TS 仅约束 typed caller；运行时外来值/强制构造不受保护。 |
| builder | `buildCoderLoopStatusSnapshot` / `makeUnavailableStatusSnapshot` | 组装八槽；成功与 unavailable 两条 shape | builder末尾第一次 `StatusSnapshotBoundary.assert`；unavailable返回不在 helper内 assert，但随后 CLI会 assert。 |
| boundary | 私有 `StatusSnapshotBoundary` | `target/state/queue/runs/current/events/processes: "object"`; `taskTree: exact ADT|null` | 七槽只拒绝 null/primitive；不拒字段缺失、extra key、任意嵌套；顶层 extra key也允许。taskTree拒非法/extra/undefined。 |
| CLI adapter | `runStatusCommand`; `runDaemonCommand(action=status)` | builder后再次 assert | 重复同一宽检查，无新信息；内部 builder consumers不经 stringify。 |
| serialization | 私有 `stringifyStatusSnapshot` + `flattenExtraReplacer` | tab-indented JSON；递归 `{...extra,...rest}` | 删除 `extra` key；extra独有键上移；冲突时 rest覆盖；undefined/function/symbol丢弃，array中的非有限数/undefined→null，Date→string，BigInt throw。 |
| final wire | stdout single JSON object | 平铺 item/current extra；不等于 builder对象 | 没有生产-side final-wire assert；当前 boundary也不导出给消费者。 |
| consumer parse | scripts/docs/jq或测试局部 ArkType | 多数直接 `JSON.parse`/jq取字段 | harness boundary仅验证 `events.recent`，不是生产 snapshot schema。 |

证据：`src/loop.ts:119-157,520-529,936-1077,2130-2135,2856-2881,3113-3177,3290-3332,3438-3467,3521-3527,3592-3629`。

### B2. 八槽的实际 shape 来源、builder 与消费者

| 槽 | TS/domain shape与 builder来源 | boundary实际强度 | 当前直接消费 |
|---|---|---|---|
| `target` | `StatusTargetSnapshot`; runtime paths/preset/runner defaults，由 `makeStatusTargetSnapshot` | 任意 non-null ArkType object | doctor读 runner；docs/jq读 paths/preset/runner |
| `state` | `StatusStateSnapshot`; runtime errors/DB identity | 同上 | doctor health；scripts/docs读 kind/ok/path |
| `queue` | counts + selected item/runner/preset；item带 `extra` | 同上 | doctor、supervisor、tests；wire consumers读平铺 item字段 |
| `runs` | DB runs聚合 `byPhaseStatus/counts` | 同上 | stable snapshot输出，未发现生产内部字段消费者 |
| `current` | DB current + item + phase status；run/item各可带 `extra` | 同上 | doctor、resume/operator docs、tests；wire被递归平铺 |
| `events` | query typed observability events，再 `JSON.stringify→JSON.parse→isJsonValue` | 同上（但 builder局部保证 JSON） | scripts/tests/docs读 path/recent/latest |
| `processes` | `ps` + daemon.status投影 | 同上 | daemon start `findOwnedLiveProcess`; doctor/docs |
| `taskTree` | persisted recursive task runtime ADT | exact keys、variant、生命周期、activeRuns；或 null | status wire与未来D9；当前未见字段级生产消费者 |

额外入口/消费者清单：

- **生产构造入口：** `buildCoderLoopStatusSnapshot` 唯一总 builder；`makeUnavailableStatusSnapshot` 是其失败支路；七槽局部 builders为 `makeStatusTargetSnapshot`, `buildStatusRunnerDefaultsSnapshot`, `buildStatusQueueSnapshotFromRecords`, `buildStatusRunsSnapshot`, `buildStatusCurrentSnapshotFromRecords`, `buildStatusEventsSnapshotFromRecords`, `buildCentralStatusProcessSnapshot`, `readDbTaskTree`。
- **生产 wire入口：** `coder-loop status <target> --json` 和 legacy-shaped `coder-loop daemon status <target> --json` 两处共享同一 builder/assert/stringifier。
- **生产内部消费者：** `executeDaemonStart→findOwnedLiveProcess`; `runDoctorCommand→buildLiveRuntimeHealthLines`; 两者读 builder对象而非 wire。
- **外部/文档消费者：** `CLAUDE.md:86`; `docs/operations.md:46-84,122-149`; `docs/operator-quickstart.md:83-109`; `docs/preset-authoring.md:106-107,372`; `scripts/engine-integration.ts:464`; `scripts/real-e2e.ts:569`; preset fragments/contract中的 CLI+jq。
- **测试消费者：** daemon hooks/runs-observability直接读 builder；CLI smoke/central-cli多为宽 `JSON.parse`; `tests/integration/daemon/harness.ts:117` 自建 `{events:{recent: ObservabilityEventBoundary[]}}`，仅一个投影。

### B3. 运行实验：真实 CLI 八槽样本与复 parse

隔离命令（未创建worktree；不存在DB，未写产品/生产数据）：

```text
bun src/loop.ts status /tmp/coder-loop-544-I02-target --json \
  --loop-data-root /tmp/coder-loop-544-I02-loop-data \
  > /tmp/coder-loop-544-I02-cli.json
bun /tmp/coder-loop-544-I02-reparse-cli.ts /tmp/coder-loop-544-I02-cli.json
```

结果：exit 0；顶层恰有八槽。实际 unavailable 样本：target有 paths/runner/preset；state=`missing-state`; queue/runs/current/events/processes均有其手写TS声明的空态字段；taskTree=null。把最终 JSON 用从固定 SHA 临时副本导出的**同一个现存** `StatusSnapshotBoundary` 复 parse，结果 `ok:true`。这证明常态 wire可过当前边界，不证明七槽字段精确。

实验方法：复制固定 SHA working tree到 `/tmp/coder-loop-544-I02-repo-2`，只在临时副本导出私有 boundary/stringifier；产品树未改。原始结果：`/tmp/coder-loop-544-I02-results-2.json`, `results-3.json` 及 `tree.ts` 输出。

### B4. 七匿名槽、taskTree、extra与特殊值正反例

| 输入 | boundary assert | stringify结果 | final wire复 parse | 结论 |
|---|---|---|---|---|
| 七槽逐一替换为 `{illegal:true,nested:{arbitrary:[1,"x",null]}}` | **七项全接受** | 原样JSON | 全接受 | boundary只证明“是object”。 |
| 七槽任一缺必填字段（baseline甚至只含一个随意字段） | 接受 | 原样 | 接受 | TS shape没有运行时对应证据。 |
| 顶层 `illegalTop:true` | 接受 | 保留 | 接受 | 顶层也非exact。 |
| slot=`null/number/string/boolean` | 拒绝 | 不执行 | — | 当前七槽唯一可靠负例是非object primitive/null。 |
| slot=`[]/RegExp/Map` | 接受 | `[]/{}/{}` | 接受 | 接受域大于JSON record域。 |
| slot=`Date` | 接受 | ISO string | **拒绝** | 已验证对象与wire类型不同。 |
| slot=`function` | 接受 | 属性整项被删除 | **拒绝**（required slot缺失） | assert后丢弃导致wire越界。 |
| slot object字段=`undefined/function/symbol` | 接受 | 字段丢弃 | 常可接受 | 宽边界掩盖已发生丢失。 |
| events array含 `undefined/NaN/±Infinity`（强制构造） | 接受 | 四项全变null | 接受 | wire被改写但宽边界仍绿；正常builder的event转换会提前拒/归一化，此为boundary能力反例。 |
| BigInt嵌入宽槽 | assert接受，stringify throw | 无wire | — | CLI可在post-assert阶段崩溃。 |
| `taskTree:null` | 接受 | null | 接受 | 合法空态。 |
| 合法最小leaf tree | 接受 | 原样 | 接受 | exact ADT资产成立。 |
| taskTree非法shape/undefined/合法tree加top或child extra key | **拒绝** | 不执行 | — | 第八槽确有字段/variant exactness。 |
| nested item `{extra:{issue:544,newKey:"from-extra",status:"shadow"},status:"real"}` | 接受 | 变 `{issue:544,newKey:"from-extra",status:"real"}` | 接受 | extra被删/上移；冲突由rest `status:"real"`覆盖。 |
| `events.extra={recent:"shadow",newKey:3}` 且 `events.recent=[]` | 接受 | `extra`删除，`newKey`上移，真实recent覆盖shadow | 接受 | replacer不只作用于item，命名碰撞会扩散至任意层。 |

注意：`JSON.stringify(asserted)===JSON.stringify(parsed)` 对 NaN/undefined 会自身先归一化，不能作JS对象等价证明；报告以逐字段值/own-key差异判定。

### B5. 上游 shape、历史与平行类型原因

- `b9ac9b5`（2026-05-17，issue #72）同一提交加入手写完整 status types/builders和七槽 `"object"` boundary。该 boundary从诞生起就不是类型单源；并非后来字段演进才偶然变宽。
- `52b34e2`（2026-05-19，issue #109）把 item/current从 index signature改为 `extra: JsonObject`，并新增 `flattenExtraReplacer`以继续输出透明字段。它同时把多处局部手写parser替换为精确ArkType，但没有收紧总status boundary；于是平铺成为明确post-assert adapter。
- `9ac3b87d`（2026-07-16，issue #558）新增 task-tree时直接把导出的 exact `TaskTreeSnapshotBoundary`嵌入第八槽；旧七槽保持匿名。故现在的强度差异来自“新域带精确边界、旧域沿用coarse boundary”，不是taskTree也宽。
- 后续 runner/preset/runs字段持续追加到手写TS类型；编译器能暴露内部 typed consumers，但生产 runtime boundary不会随字段变化报错。boundary私有、TS导出进一步让内部消费偏向平行TS shape。

### B6. 已发生改写与纯证明缺口

**已发生：** production `StatusItemSnapshot.extra` 和 `StatusCurrentRunSnapshot.extra` 必经 generic replacer；CLI wire显式平铺，文档也要求读 `queue.selected.item.issue/branch/pr`。被assert的builder对象含`.extra`，wire无该容器，因此不等价是现行协议，而非理论风险。extra/base冲突规则也是当前代码确定的rest-wins。

**纯证明缺口：** 正常builder经现有局部parser通常不会产生Date/function/BigInt/NaN；本轮反例证明的是 boundary本身挡不住，并非声称生产DB已出现这些值。历史extra冲突是否已真实发生、所有活态optional分支能否wire round-trip仍未实测。顶层/七槽非法extra key被接受是直接运行事实，不是证明缺口。

### B7. 测试同错、盲区、崩溃限制与可保留资产

现有绿测证明：真实scheduler events进入builder/CLI；status taskTree可读；doctor按手写type读取；若干wire字段可由宽JSON对象访问。它们不证明：七槽非法shape拒绝、顶层exact、最终wire与assert对象等价、generic extra仅改预期节点、冲突检测、特殊值post-assert安全、最终wire由生产边界复 parse。

`runs-observability.integration.ts:199`看似做CLI parse，实际使用harness的局部 boundary，只检查`events.recent` typed events；它与生产边界既不同源也不覆盖其余七槽、taskTree或extra rewrite。builder tests直接读`.extra`，而CLI tests直接读平铺字段，分别自洽但没有对账，是典型分层盲区。

可保留：taskTree exact negative/round-trip测试模型；observability event在builder前的JSON normalization；现有CLI fixture与wire文档可形成兼容golden；两个CLI入口共享stringifier，避免了入口间第三种wire。

崩溃限制：BigInt会在`JSON.stringify`同步throw，使CLI在两次assert之后无JSON输出；Date/function会生成越过当前boundary的wire但生产没有再assert。实验没有触碰实际DB或daemon。

### B8. 证据索引

```text
git rev-parse HEAD
git blame -L 520,529 src/loop.ts
git blame -L 936,1077 src/loop.ts
git blame -L 3320,3332 src/loop.ts
git log -S 'StatusSnapshotBoundary' -- src/loop.ts
git log -S 'flattenExtraReplacer' -- src/loop.ts
rg -n 'CoderLoopStatusSnapshot|StatusSnapshotBoundary|buildCoderLoopStatusSnapshot|statusSnapshot' src tests scripts
nl -ba src/loop.ts | sed -n '119,157p;520,529p;936,1077p;2130,2135p;2856,2881p;3113,3177p;3290,3332p;3438,3629p'
nl -ba src/task-runtime.ts | sed -n '7,178p'
nl -ba tests/integration/daemon/harness.ts | sed -n '107,118p'
nl -ba tests/integration/daemon/runs-observability.integration.ts | sed -n '123,205p'
```
