// ============================================================
// 对账集成测试
//
// 场景来自 day8-对账测试.md 第 5 步：
//   链上 transfer → 索引器异步捕获 → eventually() 轮询等待
//   → 断言索引器数据与链上一致 → 运行 6 条对账 SQL
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { MockIndexer } from "../src/mock-indexer.js";
import { eventually } from "../src/eventually.js";
import {
  rowCountByBlock,
  amountByAddress,
  balanceDerivation,
  allBalances,
  duplicateTransactions,
  latencyRecords,
  nonZeroAddressBalances,
  globalConsistency,
  mintBurnGlobalCheck,
} from "../src/reconciliation-queries.js";
import type { CatchEventParams } from "../src/types.js";
import { ZERO_ADDRESS } from "../src/types.js";

// ── 测试角色 ──────────────────────────────────────────────
const OWNER = "0x0000000000000000000000000000000000000001";
const ALICE = "0x0000000000000000000000000000000000000002";
const BOB = "0x0000000000000000000000000000000000000003";
const CHARLIE = "0x0000000000000000000000000000000000000004";

// 精度常量
const ONE_STK = 10n ** 18n;

// ── 工具 ──────────────────────────────────────────────────

/** 快速构造一个 CatchEventParams */
function transferParams(overrides: Partial<CatchEventParams> = {}) {
  return {
    tx_hash:
      overrides.tx_hash ??
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    block_number: overrides.block_number ?? 1n,
    block_timestamp: overrides.block_timestamp ?? 1700000000n,
    from_address: overrides.from_address ?? ALICE,
    to_address: overrides.to_address ?? BOB,
    amount: overrides.amount ?? 100n * ONE_STK,
  };
}

// ═══════════════════════════════════════════════════════════
// 场景 A：基础对账 — 模拟 alice transfer(bob, 100 STK)
// ═══════════════════════════════════════════════════════════

describe("场景 A：基础对账 — alice transfer(bob, 100 STK)", () => {
  let indexer: MockIndexer;

  beforeEach(() => {
    indexer = new MockIndexer(300); // 300ms 索引延迟
  });

  it("正确流程：索引器捕获事件 → eventually 轮询 → 数据一致", async () => {
    // ── Step 1: 初始化已索引的历史数据 ──
    // owner = 1000 STK（合约部署时的 mint）
    indexer.forceIndexEvent({
      tx_hash:
        "0xdeploy0000000000000000000000000000000000000000000000000000000000",
      block_number: 0n,
      block_timestamp: 1700000000n,
      from_address: ZERO_ADDRESS, // mint
      to_address: OWNER,
      amount: 1000n * ONE_STK,
    });

    // ── Step 2: 模拟链上交易 — alice transfer(bob, 100 STK) ──
    const txHash =
      "0xdeadbeef00000000000000000000000000000000000000000000000000000001";
    const transferAmount = 100n * ONE_STK;
    const blockNumber = 10n;

    // 链上操作完成（但索引器还没捕获）
    // ... 此时如果查索引器，是查不到这笔交易的

    // ── Step 3: 索引器异步捕获 ──
    // catchEvent 不 await — 让它后台跑，模拟异步索引
    const catchPromise = indexer.catchEvent({
      tx_hash: txHash,
      block_number: blockNumber,
      block_timestamp: 1700000100n,
      from_address: ALICE,
      to_address: BOB,
      amount: transferAmount,
    });

    // 索引器还没写完（300ms 延迟）
    expect(indexer.getEventsByTxHash(txHash)).toHaveLength(0);

    // ── Step 4: eventually() 轮询等待索引器 ──
    const start = Date.now();
    await eventually(
      async () => indexer.getEventsByTxHash(txHash).length > 0,
      { timeout: 3000, interval: 50, backoff: "linear" },
    );
    const elapsed = Date.now() - start;

    // 应在大约 300ms 后成功
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(600);

    // 确保 catchEvent 已完成
    await catchPromise;

    // ── Step 5: 断言索引器数据与链上一致 ──
    const events = indexer.getEventsByTxHash(txHash);
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.amount).toBe(transferAmount);
    expect(evt.from_address).toBe(ALICE);
    expect(evt.to_address).toBe(BOB);
    expect(evt.block_number).toBe(blockNumber);

    // ── Step 6: 运行对账查询 ──
    const allEvents = indexer.getAllEvents();

    // 查询 1 — 行数对账
    const rowsByBlock = rowCountByBlock(allEvents);
    const block10Row = rowsByBlock.find((r) => r.block_number === 10n);
    expect(block10Row?.transfer_count).toBe(1);

    // 查询 2 — 金额对账
    const amountsByAddr = amountByAddress(allEvents);
    const aliceOut = amountsByAddr.find(
      (a) => a.from_address === ALICE,
    );
    expect(aliceOut?.total_out_wei).toBe(transferAmount);

    // 查询 3 — 余额推导
    const bobBal = balanceDerivation(allEvents, BOB);
    expect(bobBal.balance_wei).toBe(transferAmount); // bob 收到 100

    const ownerBal = balanceDerivation(allEvents, OWNER);
    expect(ownerBal.balance_wei).toBe(1000n * ONE_STK); // owner 初始 1000

    // 查询 4 — 重复检测：无重复
    const dups = duplicateTransactions(allEvents);
    expect(dups).toHaveLength(0);

    // 查询 6b — 全局一致性（net sum = mint - burn）
    const consistency = globalConsistency(allEvents);
    expect(consistency.audit_result).toBe("PASS");
    // mint(1000) - burn(0) = 1000，非零地址净余额总和也应为 1000
    expect(consistency.total_net_sum).toBe(1000n * ONE_STK);

    // 查询 6c — mint - burn = Σ all balances
    const globalCheck = mintBurnGlobalCheck(allEvents);
    expect(globalCheck.global_check).toBe("PASS");
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 B：索引器超时 → eventually() reject
// ═══════════════════════════════════════════════════════════

describe("场景 B：索引器超时 → eventually() reject", () => {
  it("索引器延迟过长 → eventually 超时并报告详细错误", async () => {
    const indexer = new MockIndexer(5000); // 5 秒延迟…太慢了

    // 触发一次索引（不 await）
    indexer.catchEvent(
      transferParams({
        tx_hash:
          "0xslow0000000000000000000000000000000000000000000000000000000001",
      }),
    );

    const start = Date.now();
    try {
      await eventually(
        async () =>
          indexer.getEventsByTxHash(
            "0xslow0000000000000000000000000000000000000000000000000000000001",
          ).length > 0,
        { timeout: 150, interval: 30, backoff: "linear" },
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      const elapsed = Date.now() - start;
      // 硬超时应在 ~150ms 触发，而非等待 5 秒
      expect(elapsed).toBeLessThan(400);

      // 错误信息完整性
      expect(err.message).toMatch(/timed out after \d+ms/);
      expect(err.message).toMatch(/and \d+ attempts/);
      expect(err.message).toContain("Last return value: false");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 C：重复事件检测
// ═══════════════════════════════════════════════════════════

describe("场景 C：重复事件检测", () => {
  let indexer: MockIndexer;

  beforeEach(() => {
    indexer = new MockIndexer(0); // 同步模式
  });

  it("同一 tx_hash 写入两次 → duplicateTransactions 检测到", async () => {
    const txHash =
      "0xdup00000000000000000000000000000000000000000000000000000000000001";

    // 写入两次（模拟索引器重复处理）
    indexer.forceIndexEvent(
      transferParams({ tx_hash: txHash, amount: 50n * ONE_STK }),
    );
    indexer.forceIndexEvent(
      transferParams({ tx_hash: txHash, amount: 50n * ONE_STK }),
    );

    const dups = indexer.duplicateTransactions();
    expect(dups).toHaveLength(1);
    expect(dups[0].tx_hash).toBe(txHash);
    expect(dups[0].occurrence_count).toBe(2);
    expect(dups[0].duplicate_ids).toHaveLength(2);
  });

  it("无重复时 duplicateTransactions 返回空数组", () => {
    indexer.forceIndexEvent(transferParams());
    indexer.forceIndexEvent(
      transferParams({
        tx_hash:
          "0xunique000000000000000000000000000000000000000000000000000000002",
      }),
    );

    const dups = indexer.duplicateTransactions();
    expect(dups).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 D：延迟检测
// ═══════════════════════════════════════════════════════════

describe("场景 D：延迟检测", () => {
  it("block_timestamp 与 created_at 差距 > 60s → 被检测到", async () => {
    // 手动构造一个"迟到"事件，直接测纯函数
    const lateEvents = [
      {
        id: 1,
        tx_hash:
          "0xlate00000000000000000000000000000000000000000000000000000000001",
        block_number: 10n,
        block_timestamp: 1700000000n,
        from_address: ALICE,
        to_address: BOB,
        amount: 100n * ONE_STK,
        // created_at 比 block_timestamp 晚 120 秒
        created_at: new Date((1700000000 + 120) * 1000),
      },
    ];

    const records = latencyRecords(lateEvents);
    expect(records).toHaveLength(1);
    expect(records[0].tx_hash).toBe(lateEvents[0].tx_hash);
    expect(records[0].delay_seconds).toBe(120);
  });

  it("延迟在阈值内 → 不出现", async () => {
    // block_timestamp 与 created_at 差距 30s（< 60s 阈值）
    const onTimeEvents = [
      {
        id: 1,
        tx_hash:
          "0xontime0000000000000000000000000000000000000000000000000000000001",
        block_number: 10n,
        block_timestamp: 1700000000n,
        from_address: ALICE,
        to_address: BOB,
        amount: 100n * ONE_STK,
        created_at: new Date((1700000000 + 30) * 1000),
      },
    ];

    const records = latencyRecords(onTimeEvents);
    expect(records).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 E：批量余额对账
// ═══════════════════════════════════════════════════════════

describe("场景 E：批量余额对账", () => {
  let indexer: MockIndexer;

  beforeEach(() => {
    indexer = new MockIndexer(0);
  });

  it("多笔转账后，allBalances + mintBurnGlobalCheck 全量一致", () => {
    // 模拟完整生命周期
    // 1. 合约部署：mint 1000 STK 给 owner
    indexer.forceIndexEvent({
      tx_hash:
        "0xmint000000000000000000000000000000000000000000000000000000000001",
      block_number: 0n,
      block_timestamp: 1700000000n,
      from_address: ZERO_ADDRESS,
      to_address: OWNER,
      amount: 1000n * ONE_STK,
    });

    // 2. owner mint 500 给 alice
    indexer.forceIndexEvent({
      tx_hash:
        "0xmint000000000000000000000000000000000000000000000000000000000002",
      block_number: 1n,
      block_timestamp: 1700000100n,
      from_address: ZERO_ADDRESS,
      to_address: ALICE,
      amount: 500n * ONE_STK,
    });

    // 3. alice transfer 200 给 bob
    indexer.forceIndexEvent({
      tx_hash:
        "0xtransfer00000000000000000000000000000000000000000000000000000001",
      block_number: 2n,
      block_timestamp: 1700000200n,
      from_address: ALICE,
      to_address: BOB,
      amount: 200n * ONE_STK,
    });

    // 4. alice transfer 50 给 charlie
    indexer.forceIndexEvent({
      tx_hash:
        "0xtransfer00000000000000000000000000000000000000000000000000000002",
      block_number: 3n,
      block_timestamp: 1700000300n,
      from_address: ALICE,
      to_address: CHARLIE,
      amount: 50n * ONE_STK,
    });

    // 5. bob burn 30
    indexer.forceIndexEvent({
      tx_hash:
        "0xburn000000000000000000000000000000000000000000000000000000000001",
      block_number: 4n,
      block_timestamp: 1700000400n,
      from_address: BOB,
      to_address: ZERO_ADDRESS,
      amount: 30n * ONE_STK,
    });

    // ── 验证每个地址的余额 ──
    const allBal = indexer.allBalances();
    const byAddr = new Map(allBal.map((b) => [b.addr, b.balance_wei]));

    // owner: 1000 (mint) → 1000
    expect(byAddr.get(OWNER)).toBe(1000n * ONE_STK);
    // alice: 500 (mint) - 200 - 50 = 250
    expect(byAddr.get(ALICE)).toBe(250n * ONE_STK);
    // bob: 200 (from alice) - 30 (burn) = 170
    expect(byAddr.get(BOB)).toBe(170n * ONE_STK);
    // charlie: 50
    expect(byAddr.get(CHARLIE)).toBe(50n * ONE_STK);
    // 零地址不应在 allBalances 中出现（因为 forceIndexEvent 不区分，但 allBalances 会包含它）
    // 零地址：from 了 1000+500 = 1500（mint），to 了 30（burn）
    // 所以零地址的"余额"= 0 - 1500 + 30 = -1470...但这个不在我们关心范围
    // 真正重要的是非零地址

    // ── 全局一致性：非零地址净余额总和 = mint - burn ──
    const nonZeroBals = nonZeroAddressBalances(indexer.getAllEvents());
    const nonZeroSum = nonZeroBals.reduce(
      (sum, b) => sum + b.net_balance_wei,
      0n,
    );
    // mint(1500) - burn(30) = 1470
    expect(nonZeroSum).toBe(1470n * ONE_STK);

    const consistency = indexer.globalConsistency();
    expect(consistency.audit_result).toBe("PASS");

    // ── mint - burn = Σ all balances ──
    const globalCheck = indexer.mintBurnGlobalCheck();
    // minted = 1000 + 500 = 1500
    expect(globalCheck.minted_wei).toBe(1500n * ONE_STK);
    // burned = 30
    expect(globalCheck.burned_wei).toBe(30n * ONE_STK);
    // net_supply = 1500 - 30 = 1470
    expect(globalCheck.net_supply_wei).toBe(1470n * ONE_STK);
    // sum_of_all_balances = Σ non-zero net balances = 1000+250+170+50 = 1470
    expect(globalCheck.global_check).toBe("PASS");
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 F：eventually + onRetry 回调在索引器场景的使用
// ═══════════════════════════════════════════════════════════

describe("场景 F：eventually() + onRetry 调试回调", () => {
  it("每次轮询失败触发 onRetry，可记录索引器当前状态", async () => {
    const indexer = new MockIndexer(400); // 400ms 延迟

    const txHash =
      "0xretry00000000000000000000000000000000000000000000000000000000001";
    indexer.catchEvent(transferParams({ tx_hash: txHash }));

    const retryLog: string[] = [];

    await eventually(
      async () => indexer.getEventsByTxHash(txHash).length > 0,
      {
        timeout: 3000,
        interval: 80,
        backoff: "linear",
        onRetry: (attempt, lastResult) => {
          retryLog.push(
            `[retry #${attempt}] indexed=${lastResult}, pending=${indexer.getPendingCount()}`,
          );
        },
      },
    );

    // 至少触发了几次重试
    expect(retryLog.length).toBeGreaterThanOrEqual(3);
    // 每次重试时 indexed 都是 false
    retryLog.forEach((log) => {
      expect(log).toContain("indexed=false");
      expect(log).toContain("pending=1"); // 有一个事件在等待索引
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 场景 G：exponential backoff 在索引器场景
// ═══════════════════════════════════════════════════════════

describe("场景 G：exponential backoff 减少早期轮询频率", () => {
  it("backoff=exponential → 等待间隔逐步增大", async () => {
    const indexer = new MockIndexer(200); // 200ms 延迟

    const txHash =
      "0xexp00000000000000000000000000000000000000000000000000000000000001";
    indexer.catchEvent(transferParams({ tx_hash: txHash }));

    const start = Date.now();
    await eventually(
      async () => indexer.getEventsByTxHash(txHash).length > 0,
      { timeout: 5000, interval: 30, backoff: "exponential" },
    );
    const elapsed = Date.now() - start;

    // 200ms 延迟，第一次等待 30ms，第二次 60ms...在第 4 次左右成功
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(400);
  });
});
