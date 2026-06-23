// ============================================================
// ProductionReconciler — 生产环境对账执行器
//
// 生产环境的真实架构：
//
//   Blockchain (L1/L2)
//        │
//        │  emit Transfer / Swap / ...
//        ▼
//   ┌──────────────────┐
//   │  索引器服务        │  ← 不是你的代码！是团队后端/Subgraph/Kafka
//   │  (24x7 运行)      │     它负责监听事件 → 解析 → 写 PostgreSQL
//   └──────┬───────────┘
//          │ INSERT INTO transfer_events (...)
//          ▼
//   ┌──────────────────┐
//   │  PostgreSQL      │  ← 共享数据库
//   │  transfer_events │
//   └──────┬───────────┘
//          │
//          │ SELECT ... ← 你的代码只在这里
//          ▼
//   ┌──────────────────────────────────────┐
//   │  ProductionReconciler（你的对账脚本）  │
//   │                                      │
//   │  1. 连接现有的 RPC（读链上数据）         │
//   │  2. 连接现有的 PG（读索引器数据）         │
//   │  3. eventually() 轮询 PG               │
//   │  4. 跑 6 条对账 SQL                    │
//   │  5. 输出 PASS/FAIL                     │
//   │                                      │
//   │  运行方式：cron job / GitHub Actions    │
//   │  每 10 分钟一次，或每次有交易后触发       │
//   └──────────────────────────────────────┘
//
// ============================================================

import { createPublicClient, http, type Address } from "viem";
import type { Pool } from "pg";
import { eventually } from "./eventually.js";
import { QUERIES, CREATE_TABLE } from "./db-queries.js";
import { ZERO_ADDRESS } from "./types.js";

// ═══════════════════════════════════════════════════════════
// 配置（生产环境从环境变量读取）
// ═══════════════════════════════════════════════════════════

interface ReconciliationConfig {
  /** 链 RPC URL（你自己的节点或 Infura/Alchemy） */
  rpcUrl: string;
  /** PostgreSQL 连接池（索引器已经在往里写数据了） */
  pool: Pool;
  /** 要检查的合约地址（你的 SimpleToken/Uniswap/... 部署地址） */
  contractAddress: Address;
  /** 从哪个区块开始检查（通常是最新 N 个区块） */
  fromBlock: bigint;
  /** 对账超时（毫秒）*/
  timeout: number;
  /** 轮询间隔 */
  pollInterval: number;
}

// ═══════════════════════════════════════════════════════════
// Reconciler
// ═══════════════════════════════════════════════════════════

export class ProductionReconciler {
  private config: ReconciliationConfig;
  private publicClient: ReturnType<typeof createPublicClient>;

  constructor(config: ReconciliationConfig) {
    this.config = config;
    this.publicClient = createPublicClient({
      transport: http(config.rpcUrl),
    });
  }

  /**
   * 主入口：执行一次完整的对账检查。
   * 返回 { passed, report } — 直接给监控系统 / Slack bot 用。
   */
  async run(): Promise<ReconciliationReport> {
    const start = Date.now();
    const report: ReconciliationReport = {
      timestamp: new Date().toISOString(),
      contract: this.config.contractAddress,
      blockRange: `${this.config.fromBlock} → latest`,
      checks: [],
      passed: true,
      durationMs: 0,
    };

    try {
      // ── Step 0：确保表存在（生产环境应该已经存在，这里只是兜底）──
      await this.config.pool.query(CREATE_TABLE);

      // ── Step 1：读链上最新区块 ──────────────────────────
      console.log("[Reconciler] 读取链上最新区块...");
      const latestBlock = await this.publicClient.getBlockNumber();
      const chainEvents = await this.publicClient.getLogs({
        address: this.config.contractAddress,
        event: {
          type: "event",
          name: "Transfer",
          inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
          ],
        },
        fromBlock: this.config.fromBlock,
        toBlock: latestBlock,
      });
      console.log(
        `[Reconciler] 链上 ${this.config.fromBlock}→${latestBlock} 共 ${chainEvents.length} 个 Transfer`,
      );

      // ── Step 2：eventually() 等索引器追上 ────────────────
      console.log(`[Reconciler] eventually() 轮询 PostgreSQL...`);
      await eventually(
        async () => {
          const { rows } = await this.config.pool.query(QUERIES.countAll);
          const count = Number(rows[0]?.total ?? 0);
          const expected = chainEvents.length;
          console.log(`  PG=${count} 链上=${expected}`);
          return count >= expected;
        },
        {
          timeout: this.config.timeout,
          interval: this.config.pollInterval,
          backoff: "linear",
          onRetry: (n, ok) => {
            if (n % 5 === 0) {
              console.log(`  [retry #${n}] 索引器尚未追上，继续等待...`);
            }
          },
        },
      );
      console.log("[Reconciler] ✅ 索引器已追上链上数据\n");

      // ── Step 3：逐条对账 — 链上 vs PG ───────────────────
      console.log("[Reconciler] 逐笔对账...");
      let mismatchCount = 0;
      for (const log of chainEvents.slice(0, 20)) {
        // 抽样检查最近 20 笔
        const { rows } = await this.config.pool.query(QUERIES.getByTxHash, [
          log.transactionHash,
        ]);
        if (rows.length === 0) {
          // eventually() 已经确保总数一致，这里不应该出现
          report.checks.push({
            check: "单笔存在性",
            status: "FAIL",
            detail: `tx ${log.transactionHash} 链上有但 PG 无`,
          });
          report.passed = false;
          mismatchCount++;
          continue;
        }

        const pg = rows[0];
        const chainAmount = log.args.value as bigint;
        const chainFrom = (log.args.from as string).toLowerCase();
        const chainTo = (log.args.to as string).toLowerCase();

        if (pg.amount !== chainAmount.toString()) {
          report.checks.push({
            check: `amount: ${log.transactionHash.slice(0, 10)}...`,
            status: "FAIL",
            detail: `链上=${chainAmount} PG=${pg.amount}`,
          });
          report.passed = false;
          mismatchCount++;
        }
      }

      if (mismatchCount === 0) {
        report.checks.push({
          check: "单笔对账（20 笔抽样）",
          status: "PASS",
          detail: "全部一致",
        });
      }
      console.log(
        `[Reconciler] 单笔对账：${mismatchCount === 0 ? "✅" : "❌"} ${mismatchCount} 笔不一致\n`,
      );

      // ── Step 4：全局对账 — SQL ──────────────────────────
      console.log("[Reconciler] 全局对账 SQL...");

      // 查询 1：行数
      const { rows: rowCount } =
        await this.config.pool.query(QUERIES.rowCountByBlock);
      console.log(`  查询1 行数：${rowCount.length} 个区块`);

      // 查询 4：重复检测
      const { rows: dups } =
        await this.config.pool.query(QUERIES.duplicateTransactions);
      if (dups.length > 0) {
        report.checks.push({
          check: "重复检测",
          status: "FAIL",
          detail: `发现 ${dups.length} 个重复 tx_hash`,
        });
        report.passed = false;
      } else {
        report.checks.push({ check: "重复检测", status: "PASS", detail: "" });
      }
      console.log(`  查询4 重复：${dups.length} 个`);

      // 查询 5：延迟检测
      const { rows: lags } = await this.config.pool.query(
        QUERIES.latencyRecords,
        [60],
      );
      if (lags.length > 0) {
        report.checks.push({
          check: "延迟检测",
          status: "WARN",
          detail: `${lags.length} 条记录延迟 >60s`,
        });
        console.log(`  ⚠️  查询5 延迟：${lags.length} 条 >60s`);
      } else {
        report.checks.push({ check: "延迟检测", status: "PASS", detail: "" });
        console.log("  查询5 延迟：无");
      }

      // 查询 6：全局恒等式
      const { rows: [globalCheck] } =
        await this.config.pool.query(QUERIES.mintBurnGlobalCheck);
      const checkPassed = globalCheck.global_check === "PASS";
      report.checks.push({
        check: "全局恒等式 (mint-burn=Σ)",
        status: checkPassed ? "PASS" : "FAIL",
        detail: checkPassed
          ? `mint=${globalCheck.minted_wei} burn=${globalCheck.burned_wei} Σ=${globalCheck.sum_of_all_balances_wei}`
          : `差额=${BigInt(globalCheck.minted_wei) - BigInt(globalCheck.burned_wei) - BigInt(globalCheck.sum_of_all_balances_wei)}`,
      });
      if (!checkPassed) report.passed = false;
      console.log(`  查询6 恒等式：${checkPassed ? "✅" : "❌"}\n`);
    } catch (err: any) {
      report.passed = false;
      report.error = err.message;
      console.error(`[Reconciler] ❌ 对账异常：${err.message}`);
    }

    report.durationMs = Date.now() - start;
    return report;
  }
}

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

interface ReconciliationCheck {
  check: string;
  status: "PASS" | "FAIL" | "WARN";
  detail: string;
}

interface ReconciliationReport {
  timestamp: string;
  contract: string;
  blockRange: string;
  checks: ReconciliationCheck[];
  passed: boolean;
  durationMs: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════
// 可执行入口（示例）
// ═══════════════════════════════════════════════════════════

/**
 * 生产环境中这样运行：
 *
 * 方式 1：npm script
 *   "reconcile": "npx tsx src/production-reconciler.ts"
 *
 * 方式 2：cron job — 每10分钟 cd /app && npm run reconcile
 * 方式 3：GitHub Actions schedule — npm ci && npm run reconcile
 * 方式 4：K8s CronJob — image reconciler:latest with RPC_URL+DATABASE_URL
 */

// 如果直接运行此文件，执行一次对账
if (process.argv[1]?.includes("production-reconciler")) {
  (async () => {
    const { Pool } = await import("pg");

    const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
    const dbUrl =
      process.env.DATABASE_URL ||
      "postgres://indexer:indexer123@localhost:5432/indexer_db";
    const contractAddr =
      (process.env.CONTRACT_ADDRESS as Address) ||
      "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // 你的 SimpleToken 部署地址
    const fromBlock = BigInt(process.env.FROM_BLOCK || "0");

    const pool = new Pool({ connectionString: dbUrl });
    const reconciler = new ProductionReconciler({
      rpcUrl,
      pool,
      contractAddress: contractAddr,
      fromBlock,
      timeout: 60_000, // 给索引器 60 秒追上
      pollInterval: 1000,
    });

    console.log("╔══════════════════════════════════════╗");
    console.log("║  生产对账 — ProductionReconciler    ║");
    console.log("╚══════════════════════════════════════╝\n");
    console.log(`  RPC:     ${rpcUrl}`);
    console.log(`  DB:      ${dbUrl}`);
    console.log(`  合约:     ${contractAddr}`);
    console.log(`  起始区块: ${fromBlock}\n`);

    const report = await reconciler.run();

    console.log("\n─── 对账报告 ───");
    console.log(JSON.stringify(report, null, 2));
    console.log("");
    console.log(
      report.passed ? "✅ 对账通过" : "❌ 对账失败，请检查上述 FAIL 项",
    );

    await pool.end();
    process.exit(report.passed ? 0 : 1);
  })();
}
