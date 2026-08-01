# RFC #544 R10 / D5 — gateway 宿主与两数据面原子需求

> 输入边界：只读 AGG D5、`expected-foundation-544.md` 与 S1/S2 纠偏摘要。本报告不读取源码、旧 issue 或实现，不选择内部包布局，不拆 implementation issue。D5 建立独立 TanStack Start/Bun gateway；它消费 engine-owned status 与 socket contracts，不重造地基。

## A. 主 agent 摘要

D5 必须交付一个 coder-loop 仓内、可独立启动和停止的 TanStack Start gateway。它不是 daemon 的子模式，也不是 daemon 的 supervisor：daemon 停止时 gateway 仍须存活，并继续从绑定的唯一 loop-data root 提供严格只读 status 页面和 HTTP route。gateway 的启动、构建、类型检查与专项测试必须从仓库 root 有稳定 operator 命令；既有引擎路径不能反向依赖 gateway。

一个 gateway 实例只绑定一个启动期解析出的 loop-data root。该 root 进入不可变 typed runtime context；request、route 参数或前端输入均不能覆盖、枚举或逃逸到其他 root。status route 只调用地基提供的 strict-read snapshot 入口，最终 HTTP wire 通过与 CLI 相同的 engine-owned 精确 boundary；gateway 不打开 SQLite、不执行 SQL、PRAGMA、DDL、migration 或任何写入。

socket 数据面使用从引擎 command/args/result/error boundary 派生的 typed client。它继承 F07–F09 的有界完成、request/response identity 与精确错误，不复制命令字符串表、framing 或 parser。D5 只建立 read/control transport 的宿主接缝；operator 零 agent credential 是既定主体语义，不在此引入 token、登录或第二授权系统。

静态 client 资产和 server routes 由同一 gateway PID、同一个 server-owner/handler 提供；静态层先于 route，拒绝 traversal 与非文件路径，不另起静态服务。监听集合严格等于启动配置中的 localhost 与 netbird interface address：每个显式 hostname 一个 listener，共享同一 handler；禁止 wildcard、LAN 推导与 silent fallback。所有 listeners 由同一 owner 完成就绪、信号关闭和资源回收。

D5 的 daemon-down 保证只要求 gateway、静态页与 strict status route 可用，并精确呈现 daemon/socket failure；不要求 gateway 接管 daemon 生命周期。D6 replay、SSE cursor、server caps、public ingress、auth/token 和通用 supervisor 均不属于 D5。

### A1. 结论计数

| 分类 | 数量 | 结论 |
|---|---:|---|
| D5 必须自建的原子保证 | 11 | 独立宿主、root 命令、单 root、typed status、typed socket、同 PID 静态资产、精确 listeners、生命周期、daemon-down、类型图、真实消费验证 |
| 预期地基已供的保证 | 9 | F01–F09 |
| 真正地基未闭合 | 0 | U01–U07 是验证参数/样本，不改变 D5 需求 |
| 非阻塞运行未知 | 7 | U01–U07 |
| 明确排除的范围增长 | 7 | server caps、auth/token、public ingress、supervisor、replay、平行 schema/parser、跨介质事务 |

## B. 原子需求矩阵

### B1. D5 自建保证

| ID | 原子保证 | D5 必须成立的语义 | 地基映射 | 可证伪验收 |
|---|---|---|---|---|
| **D5-R01** | 独立 gateway 宿主 | coder-loop 仓内 TanStack Start server 以 Bun 运行；gateway 与 daemon 是独立进程，任一退出不隐式带走另一方 | F01–F09 | daemon 停止后 gateway PID、HTTP 与静态页仍存活；gateway 停止不承担 daemon shutdown |
| **D5-R02** | 稳定 root 命令面 | 仓库 root 提供 `gateway:start`、`gateway:build`、`gateway:typecheck`、`gateway:test`；内部包路径不是外部合同 | — | 四条命令从 root 可调用；build 产出 client assets 与 Bun 可加载 handler |
| **D5-R03** | 单 root 不动点 | 启动期唯一 parser 生成不可变 typed runtime context；实例只绑定一个 loop-data root，request 不能选择、覆盖、枚举或逃逸 root | F01–F05 | route/query/body 中注入 root/path 不能改变读取根；traversal/跨 root 请求显式拒绝 |
| **D5-R04** | typed status HTTP route | route 只调用 engine strict-read status builder；最终 response 通过与 CLI 相同的 engine-owned boundary，frontend 类型从其派生 | F01–F05 | 正常 snapshot 成功；非法 boundary 明确失败；无第二 builder/schema 或 assert 后改写 |
| **D5-R05** | gateway SQLite 零所有权 | gateway 生产代码不打开 SQLite、不发 SQL/PRAGMA/DDL/migration/写调用，只消费 strict-read engine API | F01–F03 | daemon-down 重复 HTTP 读取后 DB/schema/WAL/journal byte/metadata 中立 |
| **D5-R06** | engine-derived typed socket client | command→args→result/error 从引擎闭集派生；共享既定 framing/parser；deadline、cancel、id match、EOF/protocol/remote failure 保持精确 | F07–F09 | 合法 read RPC 精确 parse；错 id、invalid envelope、EOF、timeout 均不冒充成功且 socket 被释放 |
| **D5-R07** | 同 PID 静态资产 | 唯一静态资产层位于 server owner；同一 gateway PID 同时提供构建资产与 routes，静态处理先于 route；拒绝 traversal 与非文件路径 | — | 浏览器加载的 client asset 与 status route 来自同一 PID；不存在第二静态 server |
| **D5-R08** | 精确 listener 集合 | listener 集合只含显式 localhost 与 netbird interface address；每个 hostname 一个 `Bun.serve`、共享 handler；禁止 `0.0.0.0`、`::`、wildcard、LAN 推导和 silent fallback | — | `lsof` 只见两类显式地址；localhost/netbird 可达，LAN IP 不可达 |
| **D5-R09** | 多 listener 单 owner 生命周期 | 一个 server-owner 持有全部 listeners，启动就绪与 shutdown 穷尽所有实例；信号关闭后 PID 与全部监听消失 | — | 任一 listener 启动失败不能留下伪就绪半实例；SIGINT 后所有 listener 关闭并 wait 收尸 |
| **D5-R10** | daemon-down 服务 | daemon 不可达时 gateway 仍提供构建页面与 strict status snapshot；socket/connect/RPC failure 以 typed 状态呈现，不把 daemon-down 误报为网络/gateway down | F01–F09 | 真实 chain 停 daemon 后，HTTP status 仍读出持久状态；socket failure 精确，页面仍可加载 |
| **D5-R11** | 同仓类型图与真实消费路径 | gateway 纳入 root typecheck/build/test 图；生产页面实际消费经过 boundary parse 的 HTTP 数据，不用替身 HTML/mock 绕过 Bun、SQLite mode 或 socket transport | F04、F05、F07–F09 | root typecheck/test 覆盖 gateway；本机生产页显示 seeded chain identity，来源可追到真实 status route |

### B2. 预期地基已供

| ID | 已供保证 | D5 的消费方式 | D5 不得重造 |
|---|---|---|---|
| **D5-F01** | F01 strict-read 从打开到关闭无 create/journal/migration mutation | R04/R05 调用唯一 strict status 入口 | gateway SQLite opener、文件权限假只读 |
| **D5-F02** | F02 不可消费盘与读取失败的精确 typed 结果 | status route 原样映射 domain variant | catch-all `missing-state` 或统一 500 文案 |
| **D5-F03** | F03 SQLite 持久槽来自同一 read snapshot | route 消费完成的 snapshot | gateway 多次查询或手写 SQL 拼装 |
| **D5-F04** | F04 精确 status boundary 与派生类型 | server/frontend 从 engine boundary 派生 | gateway 平行 schema、匿名 object |
| **D5-F05** | F05 CLI/HTTP 最终 wire 共用 engine-owned boundary | R04 在 response 出口复用该 wire | HTTP 专属 reshape、第二 serializer contract |
| **D5-F06** | F06 三证独立分类 | daemon 状态页面可消费三证，不折叠 boolean | gateway 自造单一 `running` |
| **D5-F07** | F07 typed client 有界完成且取消销毁 socket | R06 直接消费 transport guarantee | 外层 race 或遗留 socket |
| **D5-F08** | F08 response identity 与 envelope 完整性 | R06 严格绑定 request id | 任意非空 id 或首行即成功 |
| **D5-F09** | F09 command/result/error 从引擎闭集派生 | R06 导入 typed facade/codec | 字符串命令表、第二 framing/parser |

### B3. 供需归属与未闭合判断

| 需求面 | 预期地基已供 | D5 自建 | 真正地基未闭合 |
|---|---|---|---|
| process host | typed data contracts | TanStack/Bun 独立进程、root 命令、同仓类型图 | 无 |
| root isolation | strict status API | 启动期 parser、不可变 single-root context、request 不可覆盖 | 无 |
| SQLite/status | F01–F05 | HTTP route 与 frontend 消费 | 无 |
| socket | F06–F09 | gateway typed client 接线与 HTTP/UI 映射 | 无 |
| static assets | 无需地基供给 | 同 PID、唯一 asset layer、path rejection | 无 |
| listeners | 无需地基供给 | localhost+netbird 精确 bind、单 owner lifecycle | 无 |
| daemon-down | strict read 与 typed socket failure | gateway/页面持续服务 | 无；不需要 supervisor |

### B4. 非阻塞运行未知

| 未知 | D5 验证影响 | 不得推出 |
|---|---|---|
| **U01** live WAL strict-read 配置 | daemon-down byte/metadata 中立 E2E 参数 | 放宽 F01 或 gateway 直开 SQLite |
| **U02** 历代盘/特殊 FS | status error fixture 矩阵 | 通用 migration framework |
| **U03** writer 频率与 snapshot 规模 | route 并发/性能参数 | 跨系统全局 snapshot |
| **U04** optional wire 分支 | HTTP/frontend golden 样本 | gateway 平行 schema |
| **U05** pid/socket 权限与 PID 复用 | daemon 状态展示样本 | 单 boolean 活性 |
| **U06** 合理 deadline 与 Bun socket 销毁 | typed client 真实 transport 验证 | server cap/idle deadline |
| **U07** mutation response 丢失窗口 | 若后续控制面复用 client，决定 UI 文案 | durable operation 或共同 commit |

### B5. 明确排除

1. 不把 response/server byte cap、server idle/handler deadline或connection/concurrency cap升级为 D5 成立前提。
2. 不新增应用登录、token、agent credential、peer credential或第二授权系统。
3. 不建立公网 listener、public ingress、反向代理合同或 wildcard bind。
4. 不让 gateway 成为通用 process supervisor，也不把 daemon 生命周期依附 gateway。
5. 不引入 events replay、`Last-Event-ID`、restart cursor；这些不属于 D5 两数据面宿主。
6. 不复制 status schema、command registry、framing/parser或手写 SQL projection。
7. 不要求 SQLite、socket、events 与 HTTP response 具有跨介质共同事务。

### B6. R11 接缝

| 接缝 | 供方 | D5 消费点 | 固定边界 |
|---|---|---|---|
| strict status snapshot | F01–F05 | R04/R05/R10 | gateway 不拥有 SQLite；HTTP 与 CLI 同 boundary |
| daemon probe / typed transport | F06–F09 | R06/R10 | engine-derived codecs；失败精确；无第二 parser |
| browser status consumption | D5-R04/R07/R11 | 后续页面交付物 | 同 PID assets，frontend 再 parse engine boundary |
| exact network exposure | D5-R08/R09 | 本机与 mesh 浏览器路径 | localhost+netbird only；无 public ingress |

