// ============================================================
// MockIndexer — 模拟链下索引器
//
// 功能：
//   1. 存储 TransferEvent（模拟 PostgreSQL transfer_events 表）
//   2. catchEvent() — 模拟索引器监听到链上事件后的异步写入（带延迟）
//   3. forceIndexEvent() — 同步写入（for 测试 setup）
//   4. 暴露所有对账查询方法（委托 reconciliation-queries.ts）
// ============================================================

import { EventEmitter } from "node:events";
import type {
  TransferEvent,
  CatchEventParams,
  RowCountByBlock,
  AmountByAddress,
  BalanceDerivation,
  AddressBalance,
  DuplicateTx,
  LatencyRecord,
  GlobalConsistencyResult,
  MintBurnGlobalCheck,
  NonZeroBalance,
} from "./types.js";
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
} from "./reconciliation-queries.js";

export class MockIndexer extends EventEmitter {
  private events: TransferEvent[] = [];
  private nextId = 1;
  private autoIndexDelay: number;
  private pendingCount = 0;

  /**
   * @param autoIndexDelayMs 模拟索引延迟（毫秒），默认 500ms。
   *                         设为 0 即同步索引（立刻写入）。
   */
  constructor(autoIndexDelayMs: number = 500) {
    super();
    this.autoIndexDelay = autoIndexDelayMs;
  }

  // ── 索引入口 ────────────────────────────────────────────

  /**
   * 模拟索引器异步捕获链上 Transfer 事件。
   * 在 autoIndexDelay 毫秒后将事件写入内部存储。
   * 通过 `'indexed'` 事件通知外部。
   */
  async catchEvent(params: CatchEventParams): Promise<TransferEvent> {
    this.pendingCount++;
    const id = this.nextId++;

    this.emit("catching", { ...params, id });

    await delay(this.autoIndexDelay);

    const event: TransferEvent = {
      id,
      tx_hash: params.tx_hash,
      block_number: params.block_number,
      block_timestamp: params.block_timestamp,
      from_address: params.from_address,
      to_address: params.to_address,
      amount: params.amount,
      created_at: new Date(),
    };

    this.events.push(event);
    this.pendingCount--;

    this.emit("indexed", event);
    return event;
  }

  /**
   * 同步强制写入事件（无延迟）。
   * 用于测试 setup — 先准备好"已索引的历史数据"。
   */
  forceIndexEvent(params: CatchEventParams): TransferEvent {
    const id = this.nextId++;
    const event: TransferEvent = {
      id,
      tx_hash: params.tx_hash,
      block_number: params.block_number,
      block_timestamp: params.block_timestamp,
      from_address: params.from_address,
      to_address: params.to_address,
      amount: params.amount,
      created_at: new Date(),
    };
    this.events.push(event);
    this.emit("indexed", event);
    return event;
  }

  // ── 查询接口（委托 reconciliation-queries）──────────────

  getAllEvents(): TransferEvent[] {
    return [...this.events];
  }

  getEventById(id: number): TransferEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  getEventsByTxHash(txHash: string): TransferEvent[] {
    return this.events.filter((e) => e.tx_hash === txHash);
  }

  getEventsByBlock(blockNumber: bigint): TransferEvent[] {
    return this.events.filter((e) => e.block_number === blockNumber);
  }

  /** 尚未完成索引的待处理事件数 */
  getPendingCount(): number {
    return this.pendingCount;
  }

  // ── 对账查询 — 委托纯函数 ──────────────────────────────

  rowCountByBlock(): RowCountByBlock[] {
    return rowCountByBlock(this.events);
  }

  amountByAddress(): AmountByAddress[] {
    return amountByAddress(this.events);
  }

  balanceDerivation(address: string): BalanceDerivation {
    return balanceDerivation(this.events, address);
  }

  allBalances(): AddressBalance[] {
    return allBalances(this.events);
  }

  duplicateTransactions(): DuplicateTx[] {
    return duplicateTransactions(this.events);
  }

  latencyRecords(thresholdSeconds?: number): LatencyRecord[] {
    return latencyRecords(this.events, thresholdSeconds);
  }

  nonZeroAddressBalances(): NonZeroBalance[] {
    return nonZeroAddressBalances(this.events);
  }

  globalConsistency(): GlobalConsistencyResult {
    return globalConsistency(this.events);
  }

  mintBurnGlobalCheck(): MintBurnGlobalCheck {
    return mintBurnGlobalCheck(this.events);
  }

  // ── 工具 ────────────────────────────────────────────────

  /** 清空存储 + 重置 ID 计数器 */
  reset(): void {
    this.events = [];
    this.nextId = 1;
    this.pendingCount = 0;
    this.removeAllListeners();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
