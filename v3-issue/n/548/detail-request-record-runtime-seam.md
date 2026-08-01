# RFC #548 · durable request record/query runtime seam 调查

## A. 主 agent 摘要（≤1 页）

### 结论

**RR 可以成为唯一的 next-batch child，置信度中高。** 它没有 preset authority、JSON Schema、write gate、startup quarantine、repair 或 consumer delivery ledger 的入边；固定 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` 已有独立的 socket request identity、真实 daemon 进程、SQLite mutation transaction、可重启隔离 data root 和直接 DB 观察面。缺失的是 RR 自身必须交付的能力，而不是外部前置：PATH CLI 目前不让调用方指定/取得稳定 request identity；没有 durable record/query；dispatcher 在 store transaction 外，无法把 request verdict 与 mutation自动线性化。

该 child 必须保持为一个原子结果：**持久记录并按 request identity 查询 engine request verdict**。它拥有 request identity 的公共传递、created/already-existing/rejected/no-op verdict、与 mutation/判定读点的线性化、reply-loss 后查询和重启恢复。它不拥有 schema-aware rejection variants、delivery verdict、consumer retry、preset model 或具体表结构。

真实 runtime checkpoint 可在不新增产品 test hook 的前提下建立：

- 以固定 main 源码启动隔离 daemon，并通过真实 PATH 形态 CLI / Unix socket 发请求；
- raw socket 写完整请求后立即断开，稳定制造“daemon 可能已提交、reply 未交付”，随后按 request identity 查询；
- 重启同一隔离 daemon，复查 verdict 与业务当前态；
- 使用隔离 SQLite 上的外部 abort trigger，在真实 mutation table 的写点确定性制造失败，再通过公共 query 与业务读面证明没有伪 created/半提交；trigger 只是 fixture 故障注入，不要求产品 hook；
- 用两个真实进程并发提交相同 request identity，验证唯一 durable verdict和冲突 fail-closed；
- 直接只读隔离 SQLite 只作事务/重启证据，公共 query仍是验收的消费者读面。

当前边界的两个明确约束必须写进 child，而不能偷渡给 schema/typed CLI：一是 socket `id` 只有在整个 envelope（`id`、`command`、`args`）解析成功后才进入 handler；malformed JSON、缺失 id，乃至“id 合法但 command/args shape 非法”目前都回 `id:"unknown"`，因此 RR 的量词只能覆盖**可关联请求**，并须把 identity 提取点前移到业务判定之前。二是 PATH CLI 当前每次随机生成 id且不向调用方暴露；RR child 必须提供最小稳定 identity/request-query公共面，但不必等待完整 D4 schema-aware CLI ADT。

**没有验收前置 blocker。** 当前 transaction seam 需要 RR child 自己改造，工作量不可被“已有 transaction”低估；但它是该 child 的交付内容，不依赖 RFC-2，也不需要先建测试 seam。不得把“可独立”误写成“现有代码已近完成”。

---

## B. 入口、事务、身份、消费者与实验

### B1. 固定事实与源码入口

| 事实 | 固定 main 证据 | RR 含义 |
|---|---|---|
| socket request 已有 `id / command / args` | `src/daemon.ts:283-287` | request identity 的 wire 载体已存在；它不是 `(chain,itemId)` work identity，也不是 deliveryId |
| response 原样携带 request id | `src/daemon.ts:289-296,1706-1722` | 同连接相关性已有；没有 durability |
| CLI transport 每次生成随机 UUID | `src/daemon.ts:4692-4694`; `src/loop.ts:2591-2594` | 当前 PATH caller 无法预先固定或事后取得可查询 identity；RR 必须补最小公共传递面 |
| envelope 完整 parse 后才保存 request id | `src/daemon.ts:1706-1711,4978-4983` | malformed-before-identity 当前不可关联；不能声称每个字节串都有 record |
| auth gate 在 handler 前 | `src/daemon.ts:1920-1931` | authorization rejection 可在 identity 已取得后形成 typed durable rejected；subject仍须来自现有 admission，不得信 caller 自报 |
| chain create 先读再 create/no-op/conflict | `src/daemon.ts:2193-2219` | created、相同输入的 no-op、冲突 rejected 都有真实判定入口，但现在没有 durable verdict |
| item add duplicate lookup 与 create 分离 | `src/daemon.ts:2910-2918` | already-existing/read verdict 必须与竞争后的最终事实同一串行化语义，不能记录事务外预读 |
| item update 从 admission/validation进入 store write | `src/daemon.ts:3104-3126` 及其后 `store.updateItem` | permission rejection、validation rejection、changed/no-op 都可作为真实验收分支 |
| store 单次写使用 SQLite immediate transaction | `src/sqlite-state.ts:1605-1611` | 有窄原子性地基；当前 request dispatcher不在该 transaction内，RR必须让对应 mutation/判定与 record共享串行化语义 |
| daemon client收到 socket close会报 incomplete response | `src/daemon.ts:4652-4688` | reply-loss 是真实边界，不需要 fake response hook |
| CLI错误目前可被压平为文本 | `src/loop.ts:2640-2656` 及现有命令表现 | RR query可先有自己的稳定机器输出；不能借此宣称完整 D4 typed rejection ADT已交付 |

### B2. request identity、主体与消费者边界

| 问题 | 当前实然 | RR child 必须闭合 | 不属于 RR |
|---|---|---|---|
| request identity | raw socket caller可传 `id`；PATH CLI隐藏随机 UUID | caller可稳定提供/取得 identity；同 identity同请求重查同一 verdict；同 identity不同命令/目标 fail closed | `(chain,itemId)` payload比较或 operation identity |
| parse-before-identity | 完整 `parseDaemonRequest`成功前 response id保持 `unknown` | 明确“可关联请求”的最早提取/校验点；identity有效而业务 envelope无效时可留下 rejected | 为无合法 identity 的任意坏字节虚构 record |
| operator主体 | 无 agent credential 的本机 socket请求走 operator路径 | record使用现有 admission所得主体；operator真实mutation/reject可查询 | 新认证系统 |
| agent主体 | credential经现有 gate解析，不能信请求自报 | authorized/denied均以 gate结论记录；相同 identity换主体/credential必须冲突或返回既有事实，不能重执行 | 重定义 phase rights |
| query consumer | 当前无 request query；current status/events不能替代 | operator/调用方通过稳定公共 query读取 typed record；权限沿现有 caller stratification明确且实测 | consumer delivery ledger、GitHub delivery verdict |
| DB观察 | 隔离 `db.sqlite` 可由 sqlite3只读观察 | runtime测试用来证明record与业务状态同存亡；正式消费者不能直连DB | 以DB schema作为跨仓公共协议 |

### B3. 线性化要求（不预选存储结构）

1. **created：** 对真正创建/改变业务状态的请求，业务 mutation与最终 created/changed verdict共同 commit或共同不出现；reply发生在该事实之后。
2. **already-existing：** 对 D5 规范 work identity，竞争后的唯一既存事实与 already-existing verdict在同一串行化语义内确定；不得用事务外 lookup记录一个随后失效的判断。
3. **no-op：** 无状态变化必须在稳定读点判定并持久化唯一 no-op verdict；当前相同 `chain.create` 只返回既有 chain，wire上并未声明 no-op。
4. **rejected：** identity已关联后，unknown command、权限拒绝、validation/conflict和持久层拒绝形成 typed rejected且零业务 mutation；完全无法取得合法 identity 的输入在量词外。
5. **reply loss：** socket write失败或caller断开不能撤销已提交事实；重试/查询只返回原 verdict，不重做 mutation。
6. **rollback/crash：** 任何可观察恢复态只能是“mutation与其成功 verdict都存在”或“二者都不存在/形成对应 rejected事实”，禁止 split-brain。不得声称 socket reply与DB commit原子。
7. **identity collision：** 同 request identity携带不同 command、目标、规范请求内容或主体时 fail closed；不得覆盖旧 record或执行第二次 mutation。这里不要求比较 D5 work payload来决定同一工作。

### B4. 已运行的有限真实实验

实验均从固定源码 `main@699842e` 启动隔离 daemon，data root 为 `/tmp/rfc548-rr-live-32420`；未改产品、测试或配置。

| 实验 | 操作 | 观察 | 证明 / 不证明 |
|---|---|---|---|
| created | 真实 CLI `chain create rr-seam` | 返回 row id 1，SQLite/`chain list`可见 | 真实 PATH形态CLI→socket→daemon→SQLite mutation seam可用；尚无request record |
| no-op | 以相同字段再次 `chain create rr-seam` | 返回同 row/id/timestamps，无新row | 有真实 no-op判定路径；当前wire不区分created/no-op |
| rejected | 同名不同 repository再次create | 返回 `conflict`，原row不变 | 有真实零mutation rejection；当前CLI文本丢失结构细节且无durable record |
| malformed identity | raw socket发送合法 `id` + 非对象args/非字符串command | 两者都回 `id:"unknown"` | identity保存过晚；RR必须先闭合可关联边界 |
| identity后reject | raw socket发送 `id:"rr-reject"` + unknown command | response保留该id并返回typed socket error | identity取得后的拒绝已有真实入口，可承载durable rejected |
| commit后reply未交付 | raw socket发送 `id:"rr-lost-reply"` 的有效create后立即shutdown/close，不读response | 稍后 `chain list`看到 `rr-lost` row id 2 | 无需产品hook即可稳定制造caller未收到reply而mutation已提交；当前无法按request id查询 |
| restart | 正常down/up同一data root后 `chain status rr-lost` | row仍存在且active | SQLite事实跨daemon重启；未来record/query可走同一恢复checkpoint |
| DB读面 | `sqlite3 db.sqlite '.tables'` | 只有现有engine tables，无request/verdict表 | 当前无durable RR；直接DB可作测试证据但不是公共consumer |

上述实验只证明 seam 可用，不把当前 state/event冒充 D7 完成态，也不证明尚未实现的共同事务。

### B5. 可执行 runtime checkpoint 矩阵

| Checkpoint | 真实驱动 | 必须观察 | 现有 seam是否足够 | 是否需先新增test seam |
|---|---|---|---|---|
| C1 created + query | PATH CLI以显式稳定request identity创建；公共request query；CLI业务读面；只读SQLite互证 | 一条created/changed verdict；一个对应业务结果；重查完全相同 | 足够，RR child补产品能力后执行 | 否 |
| C2 already-existing并发 | 两个独立进程对同一work identity发不同request identity，或重放同request identity | 唯一业务row；每个可关联request各有最终一致verdict；同request不重执行 | 足够，socket/UNIQUE/多进程均已有 | 否 |
| C3 no-op | 对已存在且字段相同的chain create，及不改变值的真实update | durable no-op；业务row/timestamp按契约无非法变化 | 足够；现有真实no-op路径可触发 | 否 |
| C4 typed rejected | unknown command、conflict、validation、权限deny各带稳定identity | durable rejected分类/必要细节；目标业务状态不变 | 足够；现有auth/validation/conflict入口可触发 | 否 |
| C5 parse-before-identity | malformed JSON、缺id、合法id但坏command/args分别发送 | 前两者明确不关联；后者按新最早identity规则得到可查询rejected | 足够；raw socket可精确发每种line | 否 |
| C6 reply loss | raw socket写完整请求后立即断开；不用response；随后query | query得到唯一最终verdict；业务状态与verdict一致；重试不重复mutation | 足够；已实验证明断连窗口可制造 | 否 |
| C7 restart query | C1/C4/C6后杀/重启隔离daemon | 所有已提交record按identity可查且与业务状态一致 | 足够；隔离data root与进程控制已有 | 否 |
| C8 deterministic rollback | 在隔离DB给目标真实mutation table安装临时abort trigger，再经真实socket发请求 | 无半业务mutation、无伪success verdict；query得到契约允许的rejected/未提交结果 | 足够；fixture外部故障注入作用于真实production write path | 否 |
| C9 crash race | 发足够大的真实batch/并发mutation并SIGKILL daemon，重启后逐identity查询 | 每个request恢复为成对存在或成对缺席/明确rejected，从不出现record与mutation分裂 | 足够作恢复补强；时序非确定，不能单独替代C8 | 否 |
| C10 identity collision | 两进程以同request identity发送不同command/target/subject | 第二意图零mutation并fail closed；原record不可覆写 | 足够；raw socket/CLI可固定identity | 否 |
| C11 权限/身份 | operator、有效agent credential、错误/过期/跨item credential分别发mutation | record主体来自admission；deny零mutation；query权限符合既定trust boundary | 足够；现有daemon integration已能取得真实run credential，child应复用而非fake | 否 |
| C12 公共面隔离 | consumer仅spawn PATH CLI；源码依赖扫描辅助 | request identity可传递、query为机器稳定输出；不import daemon/store、不直连DB | 足够；CLI是既定跨仓边界 | 否 |

### B6. 唯一 next-batch child 的范围判定

**可发布 child：持久记录并查询 engine request verdict。**

必须拥有：

- 可关联 engine request identity 的最早边界、稳定传递和collision规则；
- created/already-existing/rejected/no-op穷尽 verdict及按identity公共query；
- verdict与mutation或稳定判定读点的线性化；
- reply-loss、rollback/crash、重启后的唯一结果；
- operator/agent admission所得主体关联；
- 上表C1–C12中与实际变更命令集合对应的真实checkpoint。

必须排除：

- preset field authority、engine-control schema、JSON Schema artifact、required/unknown/writable policy；
- D4完整schema-aware CLI success/rejection矩阵（RR只补其identity/query所需的最小公共面）；
- startup quarantine、repair、全写入口schema gate；
- deliveryId、consumed/not-consumed、consumer账本、router retry；
- HAPI/external terminal；
- single-winner术语、未来具体table/column/index设计。

若 child只记录 `item.add`、只记录成功、只记录event、只在reply返回后落盘、或只提供DB内部读法，均不满足D7，不能以“先做一部分”冒充该独立原子结果。命令覆盖集合应从实际会产生engine mutation或稳定no-op/reject判定的公共request面穷尽得出，而不是在本调查中先验缩窄。

### B7. 阻塞与置信

| 项 | 判定 |
|---|---|
| 依赖 RFC-2 preset authority | **否** |
| 依赖公共 JSON Schema / schema validation | **否** |
| 依赖完整 D4 typed CLI ADT | **否**；只需要RR自己的最小identity/query机器契约 |
| 依赖 consumer/router/delivery ledger | **否** |
| 需要先新增产品 test hook | **否** |
| 当前已有共同transaction seam | **否**；这是RR child必须实现的核心，不是前置 |
| 能否成为唯一next-batch child | **能** |
| 总体置信 | **中高**：入口、断连、重启、DB与故障注入均可真实执行；具体实现尚须在不预选存储结构下闭合所有mutation/read判定 |

## C. 完成核对

- [x] 固定并核对 `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。
- [x] 阅读 `r12-resplit-review.md` 第二轮、`supply-demand-match.md` RR节点、`demand-schema-audit.md` B6/B7与 `operator-decisions.md` D7。
- [x] 只调查 RR runtime seam；未调查schema实现、consumer或external-terminal。
- [x] 运行真实隔离daemon/socket/CLI/SQLite/restart/reply-loss实验。
- [x] 未创建worktree、issue、PR，未修改产品/测试/config/DB schema/`WORKFLOW.md`/draft。
- [x] 唯一仓内写入为本报告。
- [x] 未发明single-winner或具体持久表结构。
