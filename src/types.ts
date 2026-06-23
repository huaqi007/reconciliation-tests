// ============================================================
// 共享类型：桥接 PostgreSQL transfer_events 表 ↔ TypeScript
// ============================================================

/** 零地址常量 — 用于 mint（from=零地址）和 burn（to=零地址）判断 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * 匹配 PostgreSQL transfer_events 表结构。
 * amount 使用 bigint，保持 NUMERIC(78,0) 精度。
 */
export interface TransferEvent {
  id: number;
  tx_hash: string;
  block_number: bigint;
  block_timestamp: bigint; // Unix timestamp（秒）
  from_address: string;
  to_address: string;
  amount: bigint; // wei 精度
  created_at: Date; // 对应 PostgreSQL TIMESTAMP
}

/** 输入参数 for MockIndexer.catchEvent() / forceIndexEvent() */
export interface CatchEventParams {
  tx_hash: string;
  block_number: bigint;
  block_timestamp: bigint;
  from_address: string;
  to_address: string;
  amount: bigint;
}

// ── 查询结果类型（与 SQL 输出一一对应）────────────────────

/** 查询 1：按区块统计 Transfer 事件数 */
export interface RowCountByBlock {
  block_number: bigint;
  transfer_count: number;
}

/** 查询 2：按 from_address 聚合总转出金额 */
export interface AmountByAddress {
  from_address: string;
  tx_count: number;
  total_out_wei: bigint;
  total_out_ether: string; // wei / 1e18，方便阅读
}

/** 查询 3：单个地址的余额推导 */
export interface BalanceDerivation {
  address: string;
  total_received_wei: bigint;
  total_sent_wei: bigint;
  balance_wei: bigint;
  balance_ether: string;
}

/** 查询 3 批量版：所有地址的余额 */
export interface AddressBalance {
  addr: string;
  balance_wei: bigint;
}

/** 查询 4：重复 tx_hash 检测 */
export interface DuplicateTx {
  tx_hash: string;
  occurrence_count: number;
  duplicate_ids: number[];
  first_block: bigint;
  total_amount_duplicated: bigint;
}

/** 查询 5：延迟记录 */
export interface LatencyRecord {
  id: number;
  tx_hash: string;
  block_number: bigint;
  block_timestamp: bigint;
  created_at: Date;
  delay_seconds: number;
}

/** 查询 6b：全局一致性 */
export interface GlobalConsistencyResult {
  total_net_sum: bigint;
  address_count: number;
  audit_result: "PASS" | "FAIL";
}

/** 查询 6c：mint - burn = Σ all balances */
export interface MintBurnGlobalCheck {
  minted_wei: bigint;
  burned_wei: bigint;
  net_supply_wei: bigint;
  sum_of_all_balances_wei: bigint;
  global_check: "PASS" | "FAIL";
}

/** 查询 6a：非零地址明细 */
export interface NonZeroBalance {
  addr: string;
  total_in_wei: bigint;
  total_out_wei: bigint;
  net_balance_wei: bigint;
}
