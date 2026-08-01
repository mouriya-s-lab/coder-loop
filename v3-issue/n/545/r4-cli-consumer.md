# RFC #545 R4 供给侧深审：CLI、prompt/doc-binding 与 consumer

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。设计锚点仅为 `aggregate.md` 的 D1/D7/D8/D9/D13/D14/D15 与 S13/S19/S20–S22/S29/S36/S40–S43。本文不把 compile 投影中的空字段、旧文档或测试自洽当成 v3 实现。

## A. 主 agent 摘要

### 问题

现有 context 写 CLI、socket、prompt/doc-binding、`shared.md` 和 compile/GUI/hook 消费面，能否直接作为 read boundary、工具用法注入与文档对齐的地基？

### 结论与置信边界

**高置信：写面与 shared 面各有可保留地基，但 read、工具注册/声明/注入、GUI/hook read consumer 均不存在；文档尚未按稳定设计对齐。**

1. **可保留写地基。** `context append` 已有 argv/文件输入、begin→chunk→commit socket 协议、CLI 端返回 boundary、run credential 自动附带、daemon 端 operator/agent 归因、封闭 scope/author ADT、逐阶段 admission audit。真实 CLI integration 覆盖多 MB 中文、operator、活跃 agent、拒绝与软删。
2. **D9 尚有具体 transport 缺口。** CLI 固定按 256 Ki UTF-16 code unit 切块，但 socket 对 JSON request line 有 1,048,576-byte 硬限。大量需 JSON 转义的字符（例如控制字符）可把单 chunk 序列化到上限以上；CLI 不按实际 JSON UTF-8 bytes 预检，也不以 context admission 点名该已知边界。中途失败留下 daemon 内存 session；无 abort、超时或断线回收。现有多 MB 中文测试没有覆盖此放大条件。
3. **read boundary 是零实现，不是占位实现。** daemon 命令 union/spec、CLI、`context-entry.ts` 均无 query/read request/response schema。唯一 `listContextEntries(chainId)` 是 store 内部全 chain 读取，消费者只有测试/迁移脚本；不可当 socket read API。故 S20/S21/S22 的 read 半边没有地基，GUI/hook 也没有 read shape 依赖。
4. **prompt 当前不注入 entry body，但没有 S19 对抗证明。** 全部生产 prompt 只经变量 placeholder/doc builders；没有 store/context-entry 依赖或 body 读取。现状静态支持“不会注入”，但没有“预置唯一 sentinel 后渲染每 phase prompt”的测试。未来 read 实现会新引入依赖，需保留独立负向验收。
5. **doc-binding 有成熟模式，但 context tool doc 完全不存在。** `ENGINE_RUNTIME_BINDING_KEYS`、phase variable declaration、`resolvePhaseBinding` 的穷尽 doc-builder 分派、scheduler 与 direct loop 两条 context 构造路径、文档 key/count 守护，是 S36/S42 可复用地基。当前无 `toolRequirementsDoc` key/builder，也无 context CLI 用法注入。
6. **compile 的 `tools` / `toolRequirements` 是误导性空占位。** public arktype projection声明二者，但 preset TOML boundary、`PresetPhase`/`Preset` 内存模型没有对应字段；projection 无条件写 `[]`。仓内 consumer 只有 boundary/compile tests，没有执行消费者。这既不满足 S29，也可能让外部 compile consumer误认契约已落地；实现时不能在空数组上“补 consumer”，必须从声明→parse→typed model→projection→prompt/gate 贯通。
7. **命令鉴权需要双边维护。** daemon 的 `Record<DaemonCommandName, DaemonCommandSpec>` 保证每个命令有 auth class；CLI 的 `AGENT_ATTRIBUTED_COMMANDS` 是独立白名单，只在其内才附 credential。漏 daemon spec 会 typecheck 失败；漏 CLI 白名单不会失败，agent 请求会被当 operator。历史注释明确这曾使 hard-deny 命令落入 operator 分支。新增 context read 若设 `read-no-auth` 且按 D7 要 agent 可用，可不需 credential；但若其 handler 要凭证推导 chain，则必须进入白名单，否则会形成跨 chain/身份旁路。设计实现必须消除或编译期约束这层双源。
8. **`shared.md` 并存机制真实且会继续向 prompt 暴露。** daemon create/start recovery 以 `wx` 创建、不覆盖既有文件；preset 显式声明 `runtime.sharedContextPath` 才把路径写入 prompt并授权该单文件；引擎不读取内容。它是自由文件面，与 context DB/socket 是两条并行通道。不过现有 bundled preset/文档把它称为 handoff、durable cross-issue scratchpad，甚至“only durable”，与 D1/D13 的“chain 生命周期内自由 prompt 注入、非持久业务事实源”尚未收敛。
9. **help/docs 已漂移。** 实测 root `--help` 返回 exit 1；root usage 已列 `context append`，但只展示 `--body`，未展示同样真实的 `--body-file`/`--loop-data-root`/`--json`。`context append --help` 才显示完整选项。`CLAUDE.md` 的 Root usage 整段既未列 `context`/`preset`，又声称源在已过时的 `src/loop.ts:2684`。preset 作者手册也完全没有 context 命令或 required|expected。

### 因果、影响与证明缺口

- **当前影响：** 写 CLI 可用；shared handoff 继续可用；不存在任何 agent/operator socket read、过滤/分页、GUI/hook read。compile 用户看到永远为空的“工具字段”；作者看不到 context/required 语法。
- **未来影响：** read shape 若不先建 arktype boundary 和鉴权分类，会直接污染 GUI 合同；工具声明若沿用空数组占位，会缺失 compile-time outcome 合法性与 phase slice；若 prompt builder误接 store，则破坏拉取制。共享文件旧措辞会诱导 agent 把它当持久事实源或唯一通道。
- **纯证明缺口：** 缺 S19 sentinel prompt test、root/help 与 docs 自动对照、shared 创建+注入冻结 SHA 复核、JSON-escape 放大体的最小 transport test。

### 可保留资产

- `context-entry.ts` 的 arktype request/result boundary、scope/author ADT 与 exhaustive switch。
- daemon closed command union + typed spec record + auth-class exhaustive switch。
- `requestDaemonResult`、credential env 自动附带、newline response incomplete-close 拒绝。
- begin/chunk/commit 协议和 CLI `--body-file`；但 chunk sizing/recovery需修补，不能原样宣称 D9 完成。
- doc builder/placeholder/phase slicing架构，以及 runtime key与文档计数守护先例。
- `shared.md` idempotent 创建、显式 runtime variable 才注入路径、filesystem surface最小授权。

### 未知与下一步

- 仓内无 GUI 源码/read consumer；外部 GUI 是否已偷读 DB，当前 repo 无法证明。确定方法：在 GUI repo 固定 SHA 搜 `context_entries`/future socket verb；不能据本仓空结果推断全局不存在。
- `cmd-ts` 对 argv 中特殊 Unicode/空字符串的全部行为未穷尽；核心 transport 风险可用下述隔离脚本实测。
- 下一步无需操作员裁决：先把上述事实纳入供给总账。需求侧应以“read/tool contract 不存在、doc-builder 模式存在、shared 独立存在”为地基，而非以 compile 空数组为地基。

## B. 证据附录

### B1. 设计逐条三态

| 条款 | 状态 | 生产事实 |
|---|---|---|
| D1 / S13 | **部分符合** | shared 与 DB context 同时存在且互不读取；创建/注入机制可保留。现有措辞把 shared 称为 durable/only，尚未完成并存与边界文档对齐；本调查未重跑 S13 runtime。 |
| D7 | **写半边部分符合；读半边未实现** | 写全经 socket且有 typed auth spec/audit；read verb不存在。CLI credential 分类另有独立白名单，漏项不会编译失败。 |
| D8 / S19 | **当前行为静态符合，验收未证明** | prompt builder无 context store/body读取；无 sentinel across-all-phases测试。 |
| D9 | **部分符合** | 多段传输能过多 MB常见 UTF-8；单 request 真实 1 MiB上限存在，但 chunk算法不按 serialized bytes，且错误/恢复未按 context 边界完整显式化。 |
| D13 / S40 | **未完成** | agent spawn无状态的旧陈述存在；受控中间态例外及四边界未写入 CLAUDE.md，bundled DESIGN仍写“GitHub 唯一持久层”且 shared template写“only durable”。 |
| D14 / S20 | **写半边大体符合；read/tool链未实现** | 写 schemas/ADT/exhaustive scope存在；read request/response schema、closed capability union不存在。compile空 `string[]` 不是 ADT实现。 |
| D15 / S22 | **未实现** | 无 socket read response boundary，故无 GUI contract可演进；也无 PR shape-diff执法/仓内机制。 |
| S21 | **未实现** | read command不在 daemon union/spec；“agent可用且区别事件流 hard deny”尚无对象。 |
| S29 | **未实现/负资产** | projection有 `tools: {id:string}[]` 与 phase `toolRequirements:string[]`，但永远投影空数组，声明/parser/model/consumer全无。 |
| S36 | **未实现，有地基** | runtime/status/exit docs有 builder模式；无 tool requirements doc、无 context读写用法文本。 |
| S41 | **未完成** | docs/preset多处 handoff/shared叙述未加入并存分工，template有“only durable cross-issue scratchpad”。 |
| S42 | **未实现，有守护先例** | preset authoring无 context/tools/required|expected；runtime binding key/list/count已有文档同步测试。 |
| S43 | **不符合** | root usage、nested help、CLAUDE command list互相漂移。 |

### B2. context append 从输入到响应的完整路径

1. CLI 声明：`src/loop.ts:1943-1969`。scope 必填；`--body`/`--body-file`均 optional，执行期强制恰一项。
2. body 读取：`src/loop.ts:1971-1976`。argv string原样使用；文件按 Node `utf-8` 解码。它是字符串通道，不是任意 bytes通道。
3. begin/chunk/commit：`src/loop.ts:1977-1986`。固定 `256*1024` JS character slice；空 body直接 begin→commit，合法写空字符串。
4. socket client：`src/loop.ts:2487-2504` → `src/daemon.ts:4652-4689`。每请求新 Unix socket，写一行 JSON，首个完整 newline response parse；peer提前 close返回 `incomplete_response`，没有重试。
5. credential：`src/loop.ts:2526-2556`。仅 `AGENT_ATTRIBUTED_COMMANDS` 成员从 `CODER_LOOP_RUN_CRED` 自动附带；已有显式字段不覆盖。operator进程无 env则省略。
6. daemon request parse/limit：`src/daemon.ts:1660-1722,4946-4975`。以 UTF-8 byteLength执行 1,048,576 bytes/line上限。
7. typed dispatch：`src/daemon.ts:1725-1766`，三 verb 均为 `mutation-credential-gated`；真正 caller判定由 context handler自行完成。
8. begin admission：`src/daemon.ts:1830-1883`。先 caller、chain、删除态、自报 author、arktype request、item/group校验，再以 credential binding构造 author并建内存 session。
9. chunk/commit：`src/daemon.ts:1789-1828,1886-1917`。每段重新解析 caller并校验 session owner/sequence；commit先删 session，再拼接全文同步落库，然后 emit allow并返回 `{entryId,createdAt}`。
10. CLI response再次过 boundary：`src/context-entry.ts:30-37,115-117`；输出 JSON或简短文本。

**编码/大小：** `ContextAppendChunkRequestBoundary` 接受 string (`src/context-entry.ts:23-28`)；JSON确保传输编码。多字节普通文本已由 `tests/integration/cli/central-cli.integration.ts:1347-1378` 以约 2.25M characters中文验证。它未覆盖 JSON escape 放大；256 Ki个控制字符序列化约 1.5 MiB，会命中1 MiB line限制。

**恢复/并发/事务：** session存于 daemon `Map` (`src/daemon.ts:1196`)，无 TTL、abort、socket owner或断线清理；任意分段失败后原 session可在同 daemon内继续（若调用者掌握 session/sequence），但 CLI不恢复而是退出，下次新建 session。并发 session以 UUID隔离，单 session用sequence拒绝乱序。commit在单 daemon event loop内先删除 session后调用同步 SQLite append；DB失败则 session及body不可恢复，且不会 emit commit allow/deny admission。daemon重启自然丢弃未提交 session；chain delete显式 invalidate (`src/daemon.ts:2512-2549`)。

### B3. 鉴权双边维护与漏配后果

- daemon command type union：`src/daemon.ts:183-208`；精确枚举守护：`src/daemon.ts:5731-5767`；每命令 auth spec `Record`：`src/daemon.ts:1725-1766`；auth-class exhaustive switch：`src/daemon.ts:1938-...`。
- CLI credential注入另由 `src/loop.ts:2526-2556` 的独立 literal tuple控制，未见 `Record<DaemonCommandName,...>` 的双向覆盖。注释 `src/loop.ts:2512-2517` 明载 pre-#409 漏列 hard-deny commands 后，agent请求未带凭证而被 resolver当 operator，导致操作落地。
- 因此“daemon命令必须分类”有编译保证；“需身份的CLI命令必须附credential”没有同等保证。read究竟是否附 credential 必须由 D3/D7 的 chain推导形态决定，不能照搬现有 `read-no-auth` 注释。

### B4. root usage/help 漂移

隔离只读命令（输出留在 `/tmp/rfc545-r4-cli-consumer/`）：

```text
bun src/loop.ts --help                  # exit 1
bun src/loop.ts context --help          # exit 0
bun src/loop.ts context append --help   # exit 0
```

实现：`src/loop.ts:3004-3062`。root列 `context append ... --body`，nested help同时列 `--body-file`、`--loop-data-root`、`--json`。`CLAUDE.md:31-43` 的命令块遗漏 `context` 与 `preset`，且引用旧行号 `src/loop.ts:2684`。未找到help/docs一致性测试。

### B5. prompt/doc-binding 与 shared 的全部生产路径

**prompt builders：**

- runtime binding闭集：`src/loop.ts:1221-1264`（26 keys）；解析/placeholder声明在 phase variables。
- render入口：direct loop `src/loop.ts:5481`，central scheduler `src/scheduler.ts:1660-1673,3128-3142`，最终都进 `renderPrompt`。
- builder dispatch：`src/loop.ts:5778-5822`；现有 builders为 `runtimeInputsDoc`、`phaseExitsDoc`、四个 status docs (`src/loop.ts:5824-5932`)。
- 两套 runtime context构造：`src/loop.ts:6126-6181` 与 `src/scheduler.ts:3145-3200`。新增 doc key必须两处提供placeholder，并进入key/document count守护。
- fragment索引按phase roles切片：`src/loop.ts:6083-6101`；这是最接近“per-phase tool doc slice”的现成模式。

**shared 创建/读取/注入：**

- 文件路径定义：`src/runtime-paths.ts:21,74-96`。
- chain create与daemon启动恢复：`src/daemon.ts:2221-2258`；`wx`只在不存在时写 `# Shared durable context`，不会覆盖已有内容。
- 引擎不 `readFile(sharedFile)`；只构造路径：`src/loop.ts:6113,6155` 与 `src/scheduler.ts:3170`。
- preset必须把 phase variable绑定到 `runtime.sharedContextPath` 才会出现在 prompt。bundled preset四处声明：`presets/gh-issue-pr-iteration/preset.toml:94,195,246,295`；entry/fragment再通过对应 placeholder或runtime inputs doc展示。
- filesystem authorization只在 phase声明该 runtime path时开放 writable single file：`src/loop.ts:6767-6784`，不是整个 loop-data root。
- 因此 shared **内容**不是engine自动prompt injection；engine注入的是路径，agent按prompt自行读取/写入。D1称“自由 prompt注入面”在当前机制中的准确落点是“自由文件面 + prompt路径暴露”，不是daemon读取内容拼进prompt。

### B6. prompt 零 context body 注入边界

生产 grep显示 `ContextEntry/listContextEntries`只在 store、daemon append、历史迁移存在；`renderPrompt`/scheduler没有 import或调用。`tests/integration/scheduler/core.integration.ts:191-204` 预置含状态/FINALIZER文字的entry，只证明scheduler行为不受body影响，不检查最终prompt。未找到 S19 sentinel prompt test。

建议的最小隔离证明（未来实现 read 后纳入测试，而非本调查修改）：建临时 store/chain/item，append唯一 UUID sentinel，逐 `preset.phases` 调 `renderSchedulerSpawnPrompt`，断言全部结果不含 sentinel；必须覆盖trigger phases和direct loop render路径。

### B7. compile 空形状与 consumer

- boundary声明：`src/loop.ts:533-583`。
- projection硬编码：`src/loop.ts:2935-2955` 中每 phase `toolRequirements: []`，顶层 `tools: []`。
- TOML boundary `src/loop.ts:490-518` 不接受 `tools` 或 phase `toolRequirements`；`PresetPhase` `src/loop.ts:714-728`、`Preset`也无成员。
- 仓内唯一consumer是 compile boundary/CLI tests (`tests/unit/preset/compile.test.ts`)；没有 scheduler/gate/prompt消费。

风险：public schema已经看似承诺 stringly数组和仅 `{id}` tool shape，但稳定设计要求 closed capability union、outcome合法性与穷尽消费。空字段是未来迁移负资产，不是实现地基；shape演进还会影响潜在仓外compile consumer，需显式diff。

### B8. GUI、hook、其他 read consumer

全仓 `context_entries|ContextEntry|listContextEntries|context.read|context.query` 结果显示：生产 consumer仅 SQLite store和append daemon；其余为测试、迁移脚本。hook declarations/execution不引用context。仓内无 GUI source，也无 status/compile投影context entries。故本仓没有现存 read shape依赖；不能外推GUI repo。

### B9. 文档陈述与矛盾索引

- `presets/gh-issue-pr-iteration/templates/shared.md:3-9`：stateless；shared是“only durable cross-issue scratchpad”；canonical task state仍在GitHub和central SQLite。与 D13 的“context chain生命周期受控中间态、不得当持久事实源”未并存说明，且“only durable”会与context跨run通道冲突。
- `presets/gh-issue-pr-iteration/DESIGN.md:55-65`：“GitHub 是唯一持久层”，同时要求handoff Intent/Result。对业务持久语义可成立，但没写context受控例外，S40未完成。
- `docs/gh-issue-pr-iteration-fragments.md:34,109,128,143`：shared是主 handoff，并要求各phase读取/写入；无context并存分工。
- `docs/preset-authoring.md:278-294`：只说明 shared/runtime doc builders，无context命令、tools或 required|expected。
- `docs/operations.md:173,176,317` 与 `docs/operator-quickstart.md:213`：shared/handoff作为runtime文件的恢复与git污染说明；不必删除，但S41要求补并存定位。
- `templates/README.md:23`：starter列shared模板；无冲突但需在最终全文核对中明确是否无需改。
- `CLAUDE.md`：无D13受控中间态说明；命令块漂移，见B4。

### B10. ADT/arktype 与计数守护先例

- arktype边界和derived types：`src/context-entry.ts:4-40`；scope exhaustive transforms `:119-145`。
- daemon命令精确枚举与auth `Record`：B3。
- prompt runtime key闭集：`src/loop.ts:1221-1272`。
- 文档守护：`tests/unit/loop/runtime-bindings.test.ts:29-34` 同时比较 `docs/preset-authoring.md`、`CLAUDE.md` 的计数和完整key列表。CLAUDE中写死26 (`CLAUDE.md:19`)；新增 doc builder需同步三处，否则测试失败。
- phase exits ADT + exhaustive doc rendering是 capability union实现可借鉴形态：`src/loop.ts:684-698,5838-5850`。

### B11. 测试覆盖、同错与盲区

**覆盖资产：**

- CLI真实daemon、多MB中文、operator/agent author、audit、软删、incomplete response：`tests/integration/cli/central-cli.integration.ts:1347-1419`。
- caller、session owner、inactive/cross-chain、sequence、chain deletion、scope/audit：`tests/integration/daemon/context.integration.ts:4-175`。
- store round-trip/delete/malformed persisted row：`tests/unit/runtime/context-entry.test.ts`。
- entry控制文字不改变scheduler：`tests/integration/scheduler/core.integration.ts:191-204`。

**同错/盲区：**

- 大body测试与固定字符chunk算法共同只覆盖不易触发JSON escape放大的文本。
- tests直调 `sendDaemonRequest` 时手工附 credential，无法证明新CLI verb已进入 `AGENT_ATTRIBUTED_COMMANDS`。
- 没有命令union↔credential-injection tuple的编译或测试双向一致性。
- compile tests会把永远空的tools字段稳定下来，但不证明声明/执行；属于同错风险。
- 无context read、GUI/hook consumer、S19 sentinel、help/docs drift、shared与context并存语义测试。
- shared创建测试散落在chain/CLI fixture；本调查未执行冻结SHA S13回归，因此只能认代码地基，不能登记终态通过。

### B12. 最小实验与限制

本调查仅执行三条只读 help命令，写入 `/tmp/rfc545-r4-cli-consumer/*.out`；未启动daemon、未写数据库、未跑测试、无生产副作用。

JSON escape上限的可复现实验应在隔离 loop-data root进行：启动fixture daemon，创建chain，把由 `"\\u0001".repeat(262144)` 构成的文件交给 `context append --body-file`，预期当前CLI在首个chunk收到 `request_too_large`，随后检查daemon `contextAppendSessions`仍有未提交session；完成后停止fixture并删除本地临时root。该实验会验证已由源码确定的放大/残留机制，不应接触中央daemon。

### B13. 证据索引

| 主题 | 关键证据 |
|---|---|
| CLI与chunk | `src/loop.ts:1943-1986` |
| credential注入 | `src/loop.ts:2487-2556` |
| socket client/limit | `src/daemon.ts:410,1660-1722,4652-4689,4946-4975` |
| auth spec | `src/daemon.ts:1725-1766,5731-5818` |
| context handlers | `src/daemon.ts:1769-1917` |
| write boundaries/ADT | `src/context-entry.ts:4-145` |
| prompt builders | `src/loop.ts:1221-1272,5778-5932,6083-6181`; `src/scheduler.ts:3128-3200` |
| shared lifecycle | `src/daemon.ts:2221-2258`; `src/loop.ts:6767-6784` |
| compile空字段 | `src/loop.ts:533-583,2900-2958` |
| docs冲突 | `CLAUDE.md:31-43`; `docs/preset-authoring.md:273-294`; `docs/gh-issue-pr-iteration-fragments.md:34,143`; `presets/gh-issue-pr-iteration/templates/shared.md:3-9`; `presets/gh-issue-pr-iteration/DESIGN.md:55-65` |
| runtime测试 | `tests/integration/cli/central-cli.integration.ts:1347-1419`; `tests/integration/daemon/context.integration.ts:4-175` |

**完整交付：** 本报告已覆盖任务书要求的十类事实、逐条三态、全部仓内入口/消费者、事务/并发/恢复、测试同错、实验限制与证据索引；未修改产品代码、测试、配置或 `WORKFLOW.md`，未创建 worktree/issue/PR。
