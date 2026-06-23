// ============================================================
// 真实链上对账集成测试
//
// 启动 anvil → 部署 SimpleToken → 发链上交易
// → ChainIndexer 轮询捕获 Transfer 事件
// → eventually() 等索引器追上
// → 跑对账 SQL 校验
//
// 运行：npm test
// 前提：需要 anvil 在 PATH 中（foundry 自带）
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChainIndexer } from "../src/chain-indexer.js";
import { eventually } from "../src/eventually.js";
import {
  rowCountByBlock,
  balanceDerivation,
  duplicateTransactions,
  globalConsistency,
  mintBurnGlobalCheck,
} from "../src/reconciliation-queries.js";
import type { Address } from "viem";

// ── 测试账户 ──────────────────────────────────────────────

// anvil 默认账户
const DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;
const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;
const BOB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as Address;

const ONE_STK = 10n ** 18n;

describe("真实链上对账（anvil + SimpleToken）", () => {
  let indexer: ChainIndexer;

  beforeAll(async () => {
    // 启动 anvil + 部署 SimpleToken + 开始轮询
    indexer = await ChainIndexer.create({
      anvilPort: 8555, // 用非默认端口，避免冲突
      pollingIntervalMs: 300,
    });
  }, 30000);

  afterAll(async () => {
    await indexer?.shutdown();
  });

  it("完整对账流程：链上发交易 → 索引器自动捕获 → eventually 等 → 对账通过", async () => {
    // ── Step 1: 确认初始状态（deployer 有 1000 STK）──
    const deployerBal = await indexer.balanceOf(DEPLOYER);
    expect(deployerBal).toBe(1000n * ONE_STK);

    const supply = await indexer.totalSupply();
    expect(supply).toBe(1000n * ONE_STK);

    // 给索引器一点时间捕获部署时的 mint 事件
    await new Promise((r) => setTimeout(r, 800));

    // ── Step 2: 链上发交易 — mint 500 STK 给 alice ──
    console.log("\n  [链上] mint(alice, 500 STK)...");
    const mintTxHash = await indexer.mint(ALICE, 500n * ONE_STK);
    console.log(`    tx: ${mintTxHash}`);

    // ── Step 3: 链上发交易 — alice transfer 200 STK 给 bob ──
    console.log("  [链上] alice.transfer(bob, 200 STK)...");
    const transferTxHash = await indexer.transfer(ALICE, BOB, 200n * ONE_STK);
    console.log(`    tx: ${transferTxHash}`);

    // ── Step 4: 查链上余额（即时可得）─
    const aliceBal = await indexer.balanceOf(ALICE);
    const bobBal = await indexer.balanceOf(BOB);
    console.log(`  [链上余额] alice=${aliceBal / ONE_STK} STK, bob=${bobBal / ONE_STK} STK`);
    expect(aliceBal).toBe(300n * ONE_STK); // 500 - 200
    expect(bobBal).toBe(200n * ONE_STK);

    // ── Step 5: eventually() 等索引器捕获 transfer ──
    console.log("  [eventually] 轮询等待索引器捕获 transfer...");
    const start = Date.now();
    let pollCount = 0;

    await eventually(
      async () => {
        pollCount++;
        return indexer.getEventsByTxHash(transferTxHash).length > 0;
      },
      { timeout: 10000, interval: 300, backoff: "linear" },
    );
    console.log(`  ✅ 轮询 ${pollCount} 次，耗时 ${Date.now() - start}ms`);

    // ── Step 6: 断言索引器数据 vs 链上数据 ──
    const events = indexer.getEventsByTxHash(transferTxHash);
    expect(events).toHaveLength(1);
    const evt = events[0];

    expect(evt.amount).toBe(200n * ONE_STK);
    expect(evt.from_address).toBe(ALICE.toLowerCase());
    expect(evt.to_address).toBe(BOB.toLowerCase());
    console.log(`  [对账] amount=${evt.amount / ONE_STK} STK ✅`);
    console.log(`  [对账] from=${evt.from_address} ✅`);
    console.log(`  [对账] to=${evt.to_address} ✅`);

    // ── Step 7: 跑对账查询 ──
    const allEvents = indexer.getAllEvents();
    console.log(`  [查询] 索引器共 ${allEvents.length} 条 Transfer 事件`);

    // 行数
    const byBlock = rowCountByBlock(allEvents);
    console.log(`  [查询1] 行数对账：${byBlock.length} 个区块`);

    // 余额推导
    const aliceDerived = balanceDerivation(allEvents, ALICE.toLowerCase());
    expect(aliceDerived.balance_wei).toBe(300n * ONE_STK);
    console.log(`  [查询3] alice 推导余额=${aliceDerived.balance_ether} STK ✅`);

    // 重复检测
    const dups = duplicateTransactions(allEvents);
    expect(dups).toHaveLength(0);
    console.log(`  [查询4] 重复检测：无重复 ✅`);

    // 全局一致性
    const consistency = globalConsistency(allEvents);
    expect(consistency.audit_result).toBe("PASS");
    console.log(`  [查询6b] 全局一致性：${consistency.audit_result} ✅`);

    // 恒等式
    const globalCheck = mintBurnGlobalCheck(allEvents);
    expect(globalCheck.global_check).toBe("PASS");
    console.log(
      `  [查询6c] mint(${globalCheck.minted_wei / ONE_STK}) - burn(${globalCheck.burned_wei / ONE_STK}) = Σ(${globalCheck.sum_of_all_balances_wei / ONE_STK}) ✅`,
    );

    console.log("\n  🎉 真实链上对账全部通过！\n");
  }, 30000);
});
