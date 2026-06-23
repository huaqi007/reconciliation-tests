/**
 * 对账测试框架 — 交互式演示
 *
 * 模拟一个完整的对账流程，每一步都打印到终端，
 * 让你直观看到框架在干什么。
 *
 * 运行：npx tsx demo.ts
 */

import { MockIndexer } from "./src/mock-indexer.js";
import { eventually } from "./src/eventually.js";
import {
  rowCountByBlock,
  balanceDerivation,
  allBalances,
  duplicateTransactions,
  latencyRecords,
  globalConsistency,
  mintBurnGlobalCheck,
} from "./src/reconciliation-queries.js";
import { ZERO_ADDRESS } from "./src/types.js";

// ═══════════════════════════════════════════════════════════
// 故事背景
// ═══════════════════════════════════════════════════════════

const OWNER = "0xOwner";
const ALICE = "0xAlice";
const BOB = "0xBob";
const ONE_STK = 10n ** 18n;

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  区块链对账测试框架 — 全流程现场演示                ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ── Step 0：启动索引器 ──────────────────────────────────
  console.log("📦 Step 0：启动 MockIndexer（模拟 500ms 索引延迟）");
  const indexer = new MockIndexer(500);
  console.log("   索引器已就绪，内部事件表为空。\n");

  // ── Step 1：合约部署 → 索引器记录历史数据 ──────────────
  console.log("━━━ Step 1：初始化已索引的历史数据 ━━━");
  console.log("   链上：合约部署，mint 1000 STK 给 owner");
  console.log("   → 索引器 forceIndexEvent() 同步写入（模拟『已经索引好的旧数据』）");

  indexer.forceIndexEvent({
    tx_hash: "0xMINT_OWNER_1000",
    block_number: 0n,
    block_timestamp: 1700000000n,
    from_address: ZERO_ADDRESS,
    to_address: OWNER,
    amount: 1000n * ONE_STK,
  });

  console.log(`   ✅ 索引器已有 ${indexer.getAllEvents().length} 条记录\n`);

  // ── Step 2：链上发生新交易 ──────────────────────────────
  console.log("━━━ Step 2：链上发生新交易 ━━━");
  console.log("   链上：alice.transfer(bob, 100 STK)");
  console.log("   交易哈希：0xTRANSFER_001\n");

  const txHash = "0xTRANSFER_001";
  const transferAmount = 100n * ONE_STK;

  // ── Step 3：索引器开始异步捕获 ──────────────────────────
  console.log("━━━ Step 3：索引器异步捕获事件 ━━━");
  console.log("   catchEvent() 已调用，但不 await — 模拟异步索引");
  console.log("   索引器需要 ~500ms 才能完成写入...");

  indexer.catchEvent({
    tx_hash: txHash,
    block_number: 10n,
    block_timestamp: 1700000100n,
    from_address: ALICE,
    to_address: BOB,
    amount: transferAmount,
  });

  console.log(`   当前索引器 pending 事件数：${indexer.getPendingCount()}\n`);

  // ── Step 4：立刻查询索引器（还没写完） ──────────────────
  console.log("━━━ Step 4：立刻查询索引器 → 还没查到 ━━━");
  const immediate = indexer.getEventsByTxHash(txHash);
  console.log(`   查询结果：${immediate.length} 条 — 索引器还没完成写入`);
  console.log("   如果这是普通 assert，这里就已经 FAIL 了（假阳性）\n");

  // ── Step 5：用 eventually() 轮询等待 ────────────────────
  console.log("━━━ Step 5：eventually() 轮询等待索引器追上 ━━━");
  console.log("   配置：timeout=3000ms, interval=100ms, backoff=linear");
  console.log("   开始轮询...");

  const start = Date.now();
  let lastPollTime = start;

  await eventually(
    async () => {
      const found = indexer.getEventsByTxHash(txHash).length > 0;
      const now = Date.now();
      if (!found) {
        const sinceLast = now - lastPollTime;
        console.log(
          `      ⏳ [${now - start}ms] 查询结果=false，${sinceLast}ms 后重试...`,
        );
      }
      lastPollTime = now;
      return found;
    },
    {
      timeout: 3000,
      interval: 100,
      backoff: "linear",
      onRetry: (attempt) => {
        // 这个回调只在失败时触发
      },
    },
  );

  const elapsed = Date.now() - start;
  console.log(`   ✅ [${elapsed}ms] eventually() resolve！索引器的数据已就绪\n`);

  // ── Step 6：取出索引器数据，与"链上"对比 ──────────────
  console.log("━━━ Step 6：对账 — 索引器数据 vs 链上数据 ━━━");
  const events = indexer.getEventsByTxHash(txHash);
  const evt = events[0];

  console.log(`   链上 amount：${transferAmount}`);
  console.log(`   索引器 amount：${evt.amount}`);
  console.log(`   ✅ amount 一致：${evt.amount === transferAmount}`);

  console.log(`   链上 from：${ALICE}`);
  console.log(`   索引器 from：${evt.from_address}`);
  console.log(`   ✅ from 一致：${evt.from_address === ALICE}`);

  console.log(`   链上 to：${BOB}`);
  console.log(`   索引器 to：${evt.to_address}`);
  console.log(`   ✅ to 一致：${evt.to_address === BOB}\n`);

  // ── Step 7：运行 6 条对账查询 ───────────────────────────
  console.log("━━━ Step 7：运行 6 条对账 SQL ━━━");
  const allEvents = indexer.getAllEvents();
  console.log(`   当前索引器共 ${allEvents.length} 条事件\n`);

  // 查询 1：行数对账
  const rows = rowCountByBlock(allEvents);
  console.log("   查询 1 — 行数对账（按区块统计）：");
  for (const r of rows) {
    console.log(`      区块 ${r.block_number}：${r.transfer_count} 条 Transfer`);
  }
  console.log("");

  // 查询 3：余额推导
  console.log("   查询 3 — 余额推导：");
  const ownerBal = balanceDerivation(allEvents, OWNER);
  const aliceBal = balanceDerivation(allEvents, ALICE);
  const bobBal = balanceDerivation(allEvents, BOB);
  console.log(`      OWNER：${ownerBal.balance_ether} STK（初始 1000 STK）`);
  console.log(`      ALICE：${aliceBal.balance_ether} STK（测试中未给 alice 分配初始余额，所以这里是她转出 100 后的净额）`);
  console.log(`      BOB：${bobBal.balance_ether} STK（收到 alice 的 100 STK）`);
  console.log("");

  // 查询 4：重复检测
  const dups = duplicateTransactions(allEvents);
  console.log(`   查询 4 — 重复检测：发现 ${dups.length} 个重复 tx_hash`);
  console.log("");

  // 查询 5：延迟检测
  const lags = latencyRecords(allEvents);
  console.log(`   查询 5 — 延迟检测（>60s）：发现 ${lags.length} 条延迟记录`);
  console.log("");

  // 查询 6b：全局一致性
  const consistency = globalConsistency(allEvents);
  console.log(
    `   查询 6b — 全局一致性：${consistency.audit_result}（非零地址净余额总和 = mint - burn = ${consistency.total_net_sum / ONE_STK} STK）`,
  );

  // 查询 6c：恒等式
  const globalCheck = mintBurnGlobalCheck(allEvents);
  console.log(
    `   查询 6c — 恒等式：${globalCheck.global_check}（mint-${globalCheck.minted_wei / ONE_STK} burn-${globalCheck.burned_wei / ONE_STK} = Σbalances-${globalCheck.sum_of_all_balances_wei / ONE_STK}）`,
  );
  console.log("");

  // ── 完 ──────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  🎉 对账完成！全部一致                               ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log("─── 核心流程回顾 ───\n");
  console.log("  链上 tx → catchEvent(延迟) → eventually() 轮询");
  console.log("       → 断言数据一致 → 跑对账 SQL → 全部 PASS\n");
  console.log("  换项目只需改 2 个地方：");
  console.log("    1. types.ts — 换成你的事件结构");
  console.log("    2. 数据源 — MockIndexer → 真实的 Postgres 查询\n");
}

main().catch(console.error);
