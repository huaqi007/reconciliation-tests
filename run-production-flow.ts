// ============================================================
// 生产环境完整流程演示
//
// 本地演示（自动部署）：npx tsx run-production-flow.ts
//
// 生产/测试网（提前用 keystore 部署合约）：
//   # 步骤 1：部署合约（一次性）
//   ./deploy.sh sepolia
//   # → 输出 Deployed to: 0xABCD...
//
//   # 步骤 2：修改本文件，把 CONTRACT_ADDRESS 填为上一步的地址
//   # 把 launchAnvil 改为 false，RPC_URL 改为 Sepolia RPC
//   # 然后运行：npx tsx run-production-flow.ts
//
// 链路：
//   部署合约（forge create --keystore）→ PgIndexer 连接已有合约
//   → 链上发交易 → PgIndexer INSERT 到 PG
//   → eventually() 轮询 PG → ProductionReconciler 对账
// ============================================================

import { Pool } from "pg";
import { PgIndexer } from "./src/pg-indexer.js";
import { ProductionReconciler } from "./src/production-reconciler.js";
import type { Address } from "viem";

// ═══════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════

// ─── 本地模式 ──────────────────────────────────────────
const PG_URL = "postgres://indexer:indexer123@localhost:5432/indexer_db";
const ANVIL_PORT = 8555;
const LAUNCH_ANVIL = true; // 本地：启动 anvil + 自动部署合约

// ─── 生产/测试网模式（取消注释，注释掉上面两行）─────────
// const PG_URL = "postgres://user:pass@your-db:5432/indexer_db";
// const RPC_URL = "https://sepolia.infura.io/v3/YOUR_KEY";
// const CONTRACT_ADDRESS = "0x你的合约地址" as Address;
// const DEPLOYER_PK = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
// const LAUNCH_ANVIL = false; // 不启动本地链，连外部 RPC

const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;
const BOB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as Address;
const ONE_STK = 10n ** 18n;

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  生产环境对账 — 完整流程现场演示                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const pool = new Pool({ connectionString: PG_URL });

  // ── 1. 启动 PgIndexer ──────────────────────────────────
  console.log("━━━ 1. 启动 PgIndexer ━━━");

  // 本地模式：启动 anvil + 自动部署
  // 生产模式：连接外部 RPC + 已部署的合约（launchAnvil=false, contractAddress=...）
  const indexerConfig: any = {
    anvilPort: ANVIL_PORT,
    pollingIntervalMs: 500,
    launchAnvil: LAUNCH_ANVIL,
  };

  if (!LAUNCH_ANVIL) {
    // 生产模式：合约已提前用 deploy.sh (forge create --keystore) 部署
    console.log(`    动作：连接 RPC → 连接已有合约 → 开始轮询`);
    // indexerConfig.rpcUrl = RPC_URL;
    // indexerConfig.contractAddress = CONTRACT_ADDRESS;
    // indexerConfig.deployerPrivateKey = DEPLOYER_PK;
  } else {
    console.log(`    动作：启动 anvil → 部署 SimpleToken → 创建 PG 表 → 开始轮询`);
  }
  console.log("");

  const indexer = await PgIndexer.create(pool, indexerConfig);
  console.log(`    ✅ 合约地址：${indexer.token.address}\n`);

  // ── 2. 初始状态 ───────────────────────────────────────
  const deployerBal = await indexer.balanceOf(indexer.token.owner);
  console.log(`━━━ 2. 初始状态 ━━━`);
  console.log(`    deployer(${indexer.token.owner.slice(0, 10)}...) 余额 = ${deployerBal / ONE_STK} STK`);
  console.log(`    (合约部署时 mint 了 1000 STK 给 deployer)\n`);

  // 等索引器捕获部署的 mint 事件
  await new Promise((r) => setTimeout(r, 800));

  // ── 3. 发链上交易 ─────────────────────────────────────
  console.log("━━━ 3. 链上发交易 ━━━");

  console.log("    [链上] mint(alice, 500 STK)...");
  const mintTx = await indexer.mint(ALICE, 500n * ONE_STK);
  console.log(`           tx: ${mintTx}\n`);

  console.log("    [链上] alice.transfer(bob, 200 STK)...");
  const transferTx = await indexer.transfer(ALICE, BOB, 200n * ONE_STK);
  console.log(`           tx: ${transferTx}\n`);

  // ── 4. 验证链上余额（即时可得，不等索引器）────────────
  console.log("━━━ 4. 链上余额（直接读合约，即时）━━━");
  const aliceOnChain = await indexer.balanceOf(ALICE);
  const bobOnChain = await indexer.balanceOf(BOB);
  console.log(`    alice = ${aliceOnChain / ONE_STK} STK`);
  console.log(`    bob   = ${bobOnChain / ONE_STK} STK\n`);

  // ── 5. eventually() 等 PG 有数据 ──────────────────────
  console.log("━━━ 5. eventually() 轮询 PostgreSQL ━━━");
  console.log("    每次 SELECT COUNT(*) FROM transfer_events...\n");

  const start = Date.now();
  const { eventually } = await import("./src/eventually.js");

  await eventually(
    async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM transfer_events WHERE tx_hash = $1`,
        [transferTx],
      );
      const found = Number(rows[0].cnt) > 0;
      if (!found) {
        // 顺便看看 PG 里现在有几条
        const { rows: all } = await pool.query(
          `SELECT COUNT(*) as cnt FROM transfer_events`,
        );
        console.log(
          `      ⏳ [${Date.now() - start}ms] transfer 未索引，PG 共 ${all[0].cnt} 条`,
        );
      }
      return found;
    },
    {
      timeout: 15000,
      interval: 600,
      backoff: "linear",
    },
  );
  console.log(`    ✅ [${Date.now() - start}ms] PG 已索引 transfer！\n`);

  // ── 6. 直接看 PG 里有什么 ──────────────────────────────
  console.log("━━━ 6. PostgreSQL 当前数据 ━━━");
  const { rows: allRows } = await pool.query(
    `SELECT id, tx_hash, block_number, from_address, to_address, amount
     FROM transfer_events ORDER BY id`,
  );
  for (const r of allRows) {
    console.log(
      `    id=${r.id} | block=${r.block_number} | ${r.from_address.slice(0, 10)}... → ${r.to_address.slice(0, 10)}... | ${BigInt(r.amount) / ONE_STK} STK`,
    );
  }
  console.log("");

  // ── 7. 跑 ProductionReconciler ─────────────────────────
  console.log("━━━ 7. ProductionReconciler 对账 ━━━");
  const reconciler = new ProductionReconciler({
    rpcUrl: `http://127.0.0.1:${ANVIL_PORT}`,
    pool,
    contractAddress: indexer.token.address,
    fromBlock: 0n,
    timeout: 10000,
    pollInterval: 500,
  });

  const report = await reconciler.run();
  console.log("");

  // ── 8. 报告 ───────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  📋 对账报告                                            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  时间：${report.timestamp}`);
  console.log(`  合约：${report.contract}`);
  console.log(`  区块范围：${report.blockRange}`);
  console.log(`  耗时：${report.durationMs}ms`);
  console.log(`  结果：${report.passed ? "✅ 全部通过" : "❌ 有失败项"}\n`);
  for (const c of report.checks) {
    const icon = c.status === "PASS" ? "✅" : c.status === "WARN" ? "⚠️" : "❌";
    console.log(`  ${icon} ${c.check}`);
    if (c.detail) console.log(`     ${c.detail}`);
  }
  console.log("");

  // ── 清理 ───────────────────────────────────────────────
  await indexer.shutdown();
  await pool.end();

  console.log("─── 完整流程结束 ───\n");
  console.log("生产环境架构总结：");
  console.log("  1. Blockchain (anvil)   ← 链上事件源");
  console.log("  2. PgIndexer (常驻进程)  ← 监听事件 → INSERT 到 PG");
  console.log("  3. PostgreSQL            ← 存储索引数据");
  console.log("  4. eventually()           ← 轮询 PG 直到数据就绪");
  console.log("  5. ProductionReconciler   ← 跑 6 条 SQL 对账");
  console.log("  6. 报告 → Slack / 监控    ← 告警");
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
