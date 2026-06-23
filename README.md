# Reconciliation Tests

**区块链对账测试框架** — `对账 SQL` + `eventually()` 异步轮询，覆盖本地→测试网→主网全阶段。

## 一句话概括

链上发生交易 → 索引器异步捕获（可能延迟）→ `eventually()` 轮询等待索引器追上 → 跑 6 条对账 SQL 校验一致性 → 输出 PASS/FAIL 报告。

```
链上（source of truth）       索引器（异步，可能延迟/丢数据）
     │                              │
     │  emit Transfer(...)          │  ← 监听事件，写入 DB
     │                              │
     ▼                              ▼
 你的对账脚本：eventually(() => pool.query("SELECT ... WHERE tx_hash=$1"))
                │
                ▼
         ✅ 数据一致？跑 6 条对账 SQL
```

## 为什么需要这个框架

区块链应用有一个天然的数据一致性挑战：

| 环节 | 可能出错 |
|------|---------|
| 合约 → 索引器 | 事件漏监听、区块重组后索引未更新、RPC 超时 |
| 索引器 → DB | 重复写入、字段解析错误（uint256 → number 溢出） |
| DB → API | 缓存过期、SQL 写错、分页遗漏 |

索引器是**最终一致性**的 — 链上交易确认后，可能需要几秒甚至几十秒才能完成索引。普通 `assert` 会立刻失败（假阳性），所以需要 `eventually()` 来轮询等待。

## 项目结构

```
reconciliation-tests/
├── src/
│   ├── eventually.ts              # 硬超时轮询断言（零依赖，通用件）
│   ├── types.ts                   # 事件结构 + 查询结果类型
│   ├── reconciliation-queries.ts  # 6 条 SQL → TS 纯函数（内存对账用）
│   ├── db-queries.ts              # 6 条原版 PostgreSQL SQL（生产用）
│   ├── mock-indexer.ts            # 内存假索引器（教学/快速验证）
│   ├── chain-indexer.ts           # 真实链上索引器（内存存储，集成测试）
│   ├── pg-indexer.ts              # 生产级索引器（链上 → PostgreSQL）
│   └── production-reconciler.ts   # 生产对账执行器（输出报告）
├── test/
│   ├── reconciliation.integration.test.ts  # 9 个 Mock 集成测试
│   └── chain-reconciliation.test.ts       # 真实链上集成测试（需 anvil）
├── demo.ts                        # 交互式演示脚本
├── run-production-flow.ts         # 生产环境完整链路演示
├── docker-compose.yml             # 一键启动 PostgreSQL
├── .env.example                   # 三环境配置模板
├── package.json
└── tsconfig.json
```

## 三层索引器架构

同一套对账逻辑，三种数据源，从教学到生产逐级进阶：

```
                    ┌──────────────────────────────────┐
                    │  reconciliation-queries.ts       │
                    │  对账逻辑（纯函数，三层共用）       │
                    │  eventually.ts                   │
                    │  轮询断言（纯函数，三层共用）       │
                    └──────────────┬───────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
  ┌─────┴──────┐           ┌──────┴──────┐           ┌───────┴────────┐
  │ MockIndexer│           │ ChainIndexer│           │   PgIndexer    │
  │            │           │             │           │                │
  │ 内存假数据  │           │ 真实链上数据 │           │ PostgreSQL     │
  │ 无外网依赖  │           │ anvil 本地链 │           │ 真实链上数据    │
  │ TS 纯函数   │           │ TS 纯函数    │           │ 真实 SQL 查询  │
  │ 毫秒级完成  │           │ 秒级         │           │ 持久化         │
  │            │           │             │           │                │
  │ 教学/开发   │           │ 集成测试     │           │ 生产环境       │
  └────────────┘           └─────────────┘           └────────────────┘
```

| | MockIndexer | ChainIndexer | **PgIndexer（生产）** |
|---|---|---|---|
| 数据在哪 | 内存 `events[]` | 内存 `events[]` | PostgreSQL 表 |
| 怎么查 | `events.filter(...)` | `events.filter(...)` | `pool.query(SQL, [...])` |
| 对账方式 | TS 纯函数 | TS 纯函数 | **原版 PostgreSQL SQL** |
| eventually 查什么 | `indexer.getEventsByTxHash()` | `indexer.getEventsByTxHash()` | `pool.query("SELECT * WHERE tx_hash=$1", [txHash])` |
| 持久化 | ❌ | ❌ | ✅ |
| 运行命令 | `npm test` | `npm test` | `docker compose up -d && npx tsx run-production-flow.ts` |

## 三阶段测试流水线

**代码一行不用改，只换 3 个环境变量。**

```
┌──────────────────────────────────────────────────────────────────┐
│                    对账测试三阶段流水线                             │
│                                                                  │
│  阶段 1                   阶段 2                   阶段 3         │
│  本地开发                  测试网验证               生产监控        │
│                                                                  │
│  ┌──────────┐           ┌──────────┐            ┌──────────┐    │
│  │  anvil   │           │ Sepolia  │            │ Ethereum │    │
│  │ (本地链)  │           │ (测试网)  │            │ (主网)    │    │
│  └────┬─────┘           └────┬─────┘            └────┬─────┘    │
│       │                      │                       │           │
│  RPC_URL=             RPC_URL=               RPC_URL=            │
│  127.0.0.1:8555       sepolia.infura.io      mainnet.infura.io   │
│       │                      │                       │           │
│  ┌────┴─────┐           ┌────┴─────┐            ┌────┴─────┐    │
│  │ Docker PG│           │ 测试环境PG│            │ 生产 PG   │    │
│  └────┬─────┘           └────┬─────┘            └────┬─────┘    │
│       │                      │                       │           │
│       └──────────────────────┼───────────────────────┘           │
│                              │                                   │
│              同一套代码，同一套 SQL，同一套 eventually()            │
│                                                                  │
│  目的：                  目的：                   目的：          │
│  改代码 → 秒级验证       上线前确认               出问题 → 告警    │
│                          模拟真实网络延迟          dev → 修 → 部署 │
└──────────────────────────────────────────────────────────────────┘
```

### 环境切换

```bash
cp .env.example .env
# 编辑 .env，取消注释目标环境的三行配置
```

```bash
# ─── 阶段 1：本地开发 ──────────────────────────────
RPC_URL=http://127.0.0.1:8555
DATABASE_URL=postgres://indexer:indexer123@localhost:5432/indexer_db
CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3

# ─── 阶段 2：Sepolia 测试网（上线前验证）───────────
# 需要先部署 SimpleToken 到 Sepolia
RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
DATABASE_URL=postgres://user:pass@your-staging-db:5432/indexer_db
CONTRACT_ADDRESS=0x你在Sepolia部署的地址

# ─── 阶段 3：主网（生产持续监控）───────────────────
RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
DATABASE_URL=postgres://user:pass@your-prod-db:5432/indexer_db
CONTRACT_ADDRESS=0x你在主网的地址
```

### 合约部署（keystore 方式）

本地开发可以自动部署。但**测试网和主网必须用 keystore 手动部署一次**，之后索引器连接已有合约即可。

```bash
# 1. 导入私钥到 keystore（一次性）
cast wallet import deployer --keystore-dir ~/.foundry/keystores
# 输入私钥 + 密码

# 2. 部署合约
./deploy.sh sepolia    # 部署到 Sepolia 测试网
./deploy.sh mainnet    # 部署到主网
./deploy.sh local      # 部署到本地 anvil

# 输出：
# Deployed to: 0xABCD1234...
# ✅ 部署完成。把地址填入 .env 的 CONTRACT_ADDRESS
```

部署完合约后，索引器连接已有合约（不重新部署）：

```ts
const indexer = await PgIndexer.create(pool, {
  rpcUrl: "https://sepolia.infura.io/v3/...",
  contractAddress: "0xABCD1234...",  // deploy.sh 输出的地址
  deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY,
  launchAnvil: false,  // 连接外部 RPC，不启动本地链
});
```

### 去 Sepolia / 主网前的准备

1. **用 keystore 部署合约**（上方 deploy.sh）
2. **确认索引器已连上**（你的团队后端 / Subgraph 在往 PG 写数据）
3. **改 `.env` 三个变量**，对账脚本直接用

## 核心组件

### 1. `eventually()` — 硬超时异步轮询

```ts
await eventually(
  async () => {
    const { rows } = await pool.query("SELECT * FROM transfer_events WHERE tx_hash=$1", [txHash]);
    return rows.length > 0;
  },
  {
    timeout: 10000,   // 最多等 10 秒
    interval: 500,    // 每 500ms 查一次
    backoff: "exponential",  // 等待时间逐次翻倍（上限 10s）
    onRetry: (n, ok) => console.log(`[retry #${n}] found=${ok}`),
  }
);
```

**关键设计：**

- `Promise.race([poll, hardTimeout])` — 独立的 `setTimeout` 到点必 reject，即使 `poll` 卡死在 `fn()` 或 `sleep` 里
- `AbortController` — 超时触发时主动取消正在等待的 sleep，`setTimeout` 不会残留在事件队列
- `finally` 块中清理所有计时器，零泄漏

### 2. 对账 SQL（6 条）

| # | SQL 查询 | 对什么账 | 本地 | 生产 |
|---|---------|---------|------|------|
| 1 | `GROUP BY block_number, COUNT(*)` | 行数对账 | TS 纯函数 | PostgreSQL |
| 2 | `GROUP BY from_address, SUM(amount)` | 金额对账 | TS 纯函数 | PostgreSQL |
| 3 | CTE: `incoming - outgoing` | 余额推导 | TS 纯函数 | PostgreSQL |
| 4 | `HAVING COUNT(*) > 1` | 重复检测 | TS 纯函数 | PostgreSQL |
| 5 | `ABS(epoch diff) > threshold` | 延迟检测 | TS 纯函数 | PostgreSQL |
| 6 | `mint - burn = Σ balances` | 全局一致性 | TS 纯函数 | PostgreSQL |

所有金额用 `bigint` 保持 NUMERIC(78,0) 精度，不会出现浮点误差。

### 3. ProductionReconciler — 生产对账执行器

```ts
const reconciler = new ProductionReconciler({
  rpcUrl: process.env.RPC_URL,           // 链 RPC
  pool: new Pool({ connectionString }),   // PostgreSQL 连接池
  contractAddress: CONTRACT_ADDRESS,      // 要检查的合约
  fromBlock: 0n,                          // 从哪个区块开始
  timeout: 60_000,                        // 给索引器 60 秒追上
  pollInterval: 1000,                     // 每秒轮询一次 PG
});

const report = await reconciler.run();
// → { passed: true, checks: [...], durationMs: 1823 }
```

运行方式：
- **本地手动**：`npx tsx run-production-flow.ts`
- **cron job**：`*/10 * * * * cd /app && npm run reconcile`
- **GitHub Actions**：`schedule` 触发 → `npm ci && npm run reconcile`
- **K8s CronJob**：容器化 → 定时执行 → 告警机器人

## 完整生产链路（本地演示）

```bash
# 1. 启动 PostgreSQL
docker compose up -d

# 2. 运行完整流程（anvil + 部署 + 发交易 + 对账）
npx tsx run-production-flow.ts

# 输出示例：
# ╔══════════════════════════════════════════════════╗
# ║  生产环境对账 — 完整流程现场演示                  ║
# ╚══════════════════════════════════════════════════╝
# [PgIndexer] transfer_events 表已就绪
# [PgIndexer] SimpleToken 已部署：0x5fbd...
# [链上] mint(alice, 500 STK)...    tx: 0xf7e5...
# [链上] alice.transfer(bob, 200)... tx: 0x01d0...
# [eventually] 轮询 PostgreSQL...
#   PG=1/3 [613ms]    ← 没追上，继续等
#   PG=1/3 [1222ms]
#   PG=3/3 [3644ms] ✅ 索引完成！
# [对账] ✅ 单笔一致  ✅ 无重复  ✅ 无延迟  ✅ 恒等式 PASS
```

## 测试

```bash
npm install
npm test
```

10 个测试覆盖：

| 测试 | 类型 | 场景 |
|------|------|------|
| A — 基础对账 | Mock | eventually() 等索引器 → 6 条查询 PASS |
| B — 超时 | Mock | 索引器严重延迟 → reject + 错误信息完整 |
| C — 重复检测 | Mock | 同 tx_hash 写两次 → 检出 |
| D — 延迟检测 | Mock | 120s 延迟事件 → 检出 |
| E — 批量余额 | Mock | mint+transfer+burn → Σ = totalSupply |
| F — onRetry 回调 | Mock | 轮询失败时回调记录 pending 状态 |
| G — exponential backoff | Mock | 翻倍退避策略 |
| H — 真实链上对账 | ChainIndexer | anvil + 真实 tx + eventually + 对账全流程 |

## 换项目复用

只改 2 个地方：

**1. `types.ts`** — 换成你的事件结构（SwapEvent, DepositEvent, ...）

**2. 数据源** — MockIndexer → 真实 PostgreSQL 查询

其他的 `eventually.ts`、对账 SQL 模式、测试模板，全部直接复用。

## 设计原则

1. **硬超时 > 协作超时**：`Promise.race` 保证超时独立于循环状态
2. **纯函数 > 类方法**：对账查询是纯函数，可在测试中直接调用、组合
3. **数据源可替换**：MockIndexer ↔ ChainIndexer ↔ PgIndexer 是同一套接口
4. **bigint 精度**：所有金额运算不丢精度，和 PostgreSQL NUMERIC(78,0) 对齐
5. **零泄漏**：`AbortController` + `finally` 保证所有 timer 被清理
6. **环境无关**：代码不变，只换 RPC_URL + DATABASE_URL + CONTRACT_ADDRESS
