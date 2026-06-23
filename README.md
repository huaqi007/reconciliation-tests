# Reconciliation Tests

**区块链对账测试框架** — `对账 SQL` + `eventually()` 异步轮询组合的通用解决方案。

## 一句话概括

链上发生交易 → 索引器异步捕获（可能延迟）→ `eventually()` 轮询等待索引器追上 → 运行对账 SQL 校验链上数据与索引器数据一致。

```
链上（source of truth）       索引器（异步，可能延迟/丢数据）
     │                              │
     │  emit Transfer(...)          │  ← 监听事件，写入 DB
     │                              │
     ▼                              ▼
 你的测试：eventually(() => checkIndexer(txHash))
                │
                ▼
         ✅ 数据一致？ 跑 6 条对账 SQL
```

## 为什么需要这个框架

区块链应用有一个天然的数据一致性挑战：

| 环节 | 可能出错 |
|------|---------|
| 合约 → 索引器 | 事件漏监听、区块重组后索引未更新、RPC 超时 |
| 索引器 → DB | 重复写入、字段解析错误（uint256 → number 溢出） |
| DB → API | 缓存过期、SQL 写错、分页遗漏 |

**对账测试就是：给每个环节找一个"锚点"，对比锚点两边的数据是否一致。**

但索引器是**最终一致性**的 — 链上交易确认后，索引器可能需要几秒甚至几十秒才能完成索引。普通的 `assert` 会立刻失败（假阳性），所以需要 `eventually()` 来轮询等待。

## 项目结构

```
reconciliation-tests/
├── src/
│   ├── eventually.ts              # 硬超时异步轮询断言（零依赖，通用件）
│   ├── types.ts                   # 事件结构 + 查询结果类型定义
│   ├── reconciliation-queries.ts  # 6 条对账 SQL 翻译成的 TS 纯函数
│   └── mock-indexer.ts            # 内存索引器（模拟异步索引延迟）
├── test/
│   └── reconciliation.integration.test.ts  # 9 个集成测试
├── package.json
└── tsconfig.json
```

## 核心组件

### 1. `eventually()` — 硬超时异步轮询

```ts
await eventually(
  async () => indexer.getEventsByTxHash(txHash).length > 0,
  {
    timeout: 5000,    // 最多等 5 秒
    interval: 200,    // 每 200ms 查一次
    backoff: "exponential",  // 等待时间逐次翻倍（上限 10s）
    onRetry: (n, v) => console.log(`retry #${n}`),
  }
);
```

**关键设计：**
- `Promise.race([poll, hardTimeout])` — 独立的 `setTimeout` 到点必 reject，即使 `poll` 卡死在 `fn()` 或 `sleep` 里
- `AbortController` — 超时触发时主动取消正在等待的 sleep，`setTimeout` 不会残留在事件队列
- `finally` 块中清理所有计时器，零泄漏

### 2. 对账 SQL → TypeScript 翻译

6 条对账查询全部翻译为对 `TransferEvent[]` 操作的**纯函数**：

| # | SQL 查询 | TS 函数 | 对什么账 |
|---|---------|---------|---------|
| 1 | `GROUP BY block_number, COUNT(*)` | `rowCountByBlock()` | 行数对账 |
| 2 | `GROUP BY from_address, SUM(amount)` | `amountByAddress()` | 金额对账 |
| 3 | CTE: `incoming - outgoing` | `balanceDerivation()` / `allBalances()` | 余额推导 |
| 4 | `HAVING COUNT(*) > 1` | `duplicateTransactions()` | 重复检测 |
| 5 | `ABS(epoch diff) > threshold` | `latencyRecords()` | 延迟检测 |
| 6 | `mint - burn = Σ balances` | `globalConsistency()` / `mintBurnGlobalCheck()` | 全局一致性 |

所有金额用 `bigint` 保持 NUMERIC(78,0) 精度，不会出现浮点误差。

### 3. MockIndexer — 可替换的数据源抽象

```ts
class MockIndexer {
  forceIndexEvent(params)  // 同步写入（测试 setup）
  catchEvent(params)       // 异步写入（模拟索引延迟）
  // 查询方法全部委托 reconciliation-queries.ts 的纯函数
}
```

**换真实数据源时只需要替换这一层** — 把 `this.events.filter(...)` 改成 `pg.query("SELECT ...")`。

## 测试场景

9 个集成测试覆盖：

| 场景 | 演示内容 |
|------|---------|
| A — 基础对账 | `eventually()` 等索引器捕获 → 6 条查询全部 PASS |
| B — 超时 | 索引器严重延迟 → eventually reject + 错误信息含耗时和重试次数 |
| C — 重复检测 | 同一 tx_hash 写两次 → `occurrence_count = 2` |
| D — 延迟检测 | 构造 120s 延迟事件 → 被 `latencyRecords()` 检出 |
| E — 批量余额 | mint + multi-transfer + burn → Σ balances = totalSupply |
| F — onRetry 回调 | 轮询失败时触发回调，记录索引器 pending 状态 |
| G — exponential backoff | 翻倍退避策略下仍然正确等待 |

运行测试：

```bash
npm install
npm test
```

## 换项目复用指南

这个框架不绑定任何具体业务，只依赖一个事件接口。换项目时：

### 需要改的（插件层）

**1. `types.ts`** — 定义你的事件结构

```ts
// 原来：TransferEvent
// 改为：
interface SwapEvent {
  tx_hash: string;
  pair: string;
  amount0In: bigint;
  amount1Out: bigint;
  sender: string;
  // ...
}
```

**2. 数据源** — 把 MockIndexer 替换为真实查询

```ts
// 原来：this.events.filter(e => e.tx_hash === txHash)
// 改为：await pg.query("SELECT * FROM swap_events WHERE tx_hash = $1", [txHash])
```

**3. 对账查询** — 在 `reconciliation-queries.ts` 里写新业务的对账逻辑

```ts
// Swap 专属：常量积不变式
export function constantProductCheck(events: SwapEvent[]): boolean {
  // amount0In * amount1Out >= K (简化)
}
```

### 不用动的（通用件）

- **`eventually.ts`** — 它只关心 `fn: () => Promise<boolean>`，查什么都行
- **测试模式** — 永远是：造交易 → eventually 等索引器 → 断言一致性 → 跑对账查询

### 依赖关系

```
你的数据源（Postgres / REST / GraphQL）
        │
        ▼  ← 换项目改这里
   types.ts  +  数据源适配层
        │
        ▼  ← 加新查询
   reconciliation-queries.ts
        │
        ▼  ← 不动
   eventually.ts
        │
        ▼
   集成测试模板
```

## 技术栈

- TypeScript (ESNext, strict)
- Vitest (测试框架)
- Node.js EventEmitter (MockIndexer 事件)
- 零运行时依赖（仅 devDependencies: `typescript`, `vitest`, `@types/node`）

## 设计原则

1. **硬超时 > 协作超时**：`Promise.race` 保证超时独立于循环状态
2. **纯函数 > 类方法**：对账查询是纯函数，可在测试中直接调用、组合
3. **数据源可替换**：MockIndexer ↔ 真实 Postgres 是同一套接口
4. **bigint 精度**：所有金额运算不丢精度，和 PostgreSQL NUMERIC(78,0) 对齐
5. **零泄漏**：`AbortController` + `finally` 保证所有 timer 被清理
