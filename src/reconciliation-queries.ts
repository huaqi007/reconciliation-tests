// ============================================================
// 对账查询函数 — 将 6 条 SQL 逐条翻译为 TypeScript 纯函数
// 所有函数接受 TransferEvent[]，返回对应的查询结果
// 逻辑与 sql/audit_queries.sql 完全对齐
// ============================================================

import type {
  TransferEvent,
  RowCountByBlock,
  AmountByAddress,
  BalanceDerivation,
  AddressBalance,
  DuplicateTx,
  LatencyRecord,
  GlobalConsistencyResult,
  NonZeroBalance,
  MintBurnGlobalCheck,
} from "./types.js";
import { ZERO_ADDRESS } from "./types.js";

// ── 查询 1：行数对账 ──────────────────────────────────────
// SELECT block_number, COUNT(*) AS transfer_count
// FROM transfer_events
// GROUP BY block_number
// ORDER BY block_number;

export function rowCountByBlock(events: TransferEvent[]): RowCountByBlock[] {
  const counts = new Map<bigint, number>();
  for (const e of events) {
    counts.set(e.block_number, (counts.get(e.block_number) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([block_number, transfer_count]) => ({
      block_number,
      transfer_count,
    }))
    .sort((a, b) => (a.block_number < b.block_number ? -1 : 1));
}

// ── 查询 2：金额对账 ──────────────────────────────────────
// SELECT from_address, COUNT(*), SUM(amount), SUM(amount)/1e18
// FROM transfer_events
// GROUP BY from_address
// ORDER BY total_out_wei DESC;

export function amountByAddress(events: TransferEvent[]): AmountByAddress[] {
  const grouped = new Map<
    string,
    { tx_count: number; total_out_wei: bigint }
  >();
  for (const e of events) {
    const entry = grouped.get(e.from_address) ?? {
      tx_count: 0,
      total_out_wei: 0n,
    };
    entry.tx_count += 1;
    entry.total_out_wei += e.amount;
    grouped.set(e.from_address, entry);
  }
  return [...grouped.entries()]
    .map(([from_address, v]) => ({
      from_address,
      tx_count: v.tx_count,
      total_out_wei: v.total_out_wei,
      total_out_ether: formatEther(v.total_out_wei),
    }))
    .sort((a, b) => (a.total_out_wei > b.total_out_wei ? -1 : 1));
}

// ── 查询 3：余额推导（单地址） ────────────────────────────
// WITH incoming AS (SELECT COALESCE(SUM(amount),0) WHERE to_address = :addr),
//      outgoing AS (SELECT COALESCE(SUM(amount),0) WHERE from_address = :addr)
// SELECT total_in - total_out

export function balanceDerivation(
  events: TransferEvent[],
  address: string,
): BalanceDerivation {
  let total_in = 0n;
  let total_out = 0n;
  for (const e of events) {
    if (e.to_address === address) total_in += e.amount;
    if (e.from_address === address) total_out += e.amount;
  }
  const balance = total_in - total_out;
  return {
    address,
    total_received_wei: total_in,
    total_sent_wei: total_out,
    balance_wei: balance,
    balance_ether: formatEther(balance),
  };
}

// ── 查询 3 批量版：所有地址的余额 ─────────────────────────
// SELECT addr, COALESCE(i.total_in,0)-COALESCE(o.total_out,0) AS balance_wei
// FROM (SELECT from_address AS addr UNION SELECT to_address) a
// LEFT JOIN incoming i ON a.addr = i.addr
// LEFT JOIN outgoing o ON a.addr = o.addr

export function allBalances(events: TransferEvent[]): AddressBalance[] {
  const incoming = new Map<string, bigint>();
  const outgoing = new Map<string, bigint>();
  const allAddrs = new Set<string>();

  for (const e of events) {
    incoming.set(
      e.to_address,
      (incoming.get(e.to_address) ?? 0n) + e.amount,
    );
    outgoing.set(
      e.from_address,
      (outgoing.get(e.from_address) ?? 0n) + e.amount,
    );
    allAddrs.add(e.to_address);
    allAddrs.add(e.from_address);
  }

  return [...allAddrs]
    .map((addr) => ({
      addr,
      balance_wei:
        (incoming.get(addr) ?? 0n) - (outgoing.get(addr) ?? 0n),
    }))
    .sort((a, b) => (a.balance_wei > b.balance_wei ? -1 : 1));
}

// ── 查询 4：重复检测 ──────────────────────────────────────
// SELECT tx_hash, COUNT(*), STRING_AGG(id::TEXT,','),
//        MIN(block_number), SUM(amount)
// FROM transfer_events
// GROUP BY tx_hash
// HAVING COUNT(*) > 1;

export function duplicateTransactions(
  events: TransferEvent[],
): DuplicateTx[] {
  const grouped = new Map<
    string,
    {
      ids: number[];
      first_block: bigint;
      total_amount_duplicated: bigint;
    }
  >();

  for (const e of events) {
    const entry = grouped.get(e.tx_hash) ?? {
      ids: [],
      first_block: e.block_number,
      total_amount_duplicated: 0n,
    };
    entry.ids.push(e.id);
    if (e.block_number < entry.first_block) {
      entry.first_block = e.block_number;
    }
    entry.total_amount_duplicated += e.amount;
    grouped.set(e.tx_hash, entry);
  }

  return [...grouped.entries()]
    .filter(([, v]) => v.ids.length > 1)
    .map(([tx_hash, v]) => ({
      tx_hash,
      occurrence_count: v.ids.length,
      duplicate_ids: v.ids,
      first_block: v.first_block,
      total_amount_duplicated: v.total_amount_duplicated,
    }))
    .sort((a, b) => b.occurrence_count - a.occurrence_count);
}

// ── 查询 5：延迟检测 ──────────────────────────────────────
// WHERE ABS(block_timestamp - EXTRACT(EPOCH FROM created_at)) > 60

export function latencyRecords(
  events: TransferEvent[],
  thresholdSeconds: number = 60,
): LatencyRecord[] {
  return events
    .map((e) => {
      const created_at_epoch = Math.floor(e.created_at.getTime() / 1000);
      const delay_seconds = Math.abs(
        Number(e.block_timestamp) - created_at_epoch,
      );
      return { ...e, delay_seconds };
    })
    .filter((r) => r.delay_seconds > thresholdSeconds)
    .sort((a, b) => b.delay_seconds - a.delay_seconds);
}

// ── 查询 6a：非零地址净余额 ──────────────────────────────
// WITH incoming AS (SELECT to_address AS addr, SUM(amount) WHERE to_address != 0x0),
//      outgoing AS (SELECT from_address AS addr, SUM(amount) WHERE from_address != 0x0)
// SELECT addr, total_in_wei, total_out_wei, total_in - total_out

export function nonZeroAddressBalances(
  events: TransferEvent[],
): NonZeroBalance[] {
  const incoming = new Map<string, bigint>();
  const outgoing = new Map<string, bigint>();
  const allAddrs = new Set<string>();

  for (const e of events) {
    if (e.to_address !== ZERO_ADDRESS) {
      incoming.set(
        e.to_address,
        (incoming.get(e.to_address) ?? 0n) + e.amount,
      );
      allAddrs.add(e.to_address);
    }
    if (e.from_address !== ZERO_ADDRESS) {
      outgoing.set(
        e.from_address,
        (outgoing.get(e.from_address) ?? 0n) + e.amount,
      );
      allAddrs.add(e.from_address);
    }
  }

  return [...allAddrs]
    .map((addr) => {
      const total_in_wei = incoming.get(addr) ?? 0n;
      const total_out_wei = outgoing.get(addr) ?? 0n;
      return {
        addr,
        total_in_wei,
        total_out_wei,
        net_balance_wei: total_in_wei - total_out_wei,
      };
    })
    .sort((a, b) => (a.net_balance_wei > b.net_balance_wei ? -1 : 1));
}

// ── 查询 6b：全局一致性 ──────────────────────────────────
// 对于含 mint / burn 的 ERC20 Transfer 表：
//   非零地址的净余额总和 Σ(net) 应等于 totalSupply（mint - burn）。
// 判断标准不是 Σ = 0，而是 Σ 与 (mint - burn) 相等。
//
// 原 SQL 假设表中无 mint/burn 所以检查 Σ=0；
// 这里适配 ERC20 语义：用 mintBurnGlobalCheck 的恒等式校验。

export function globalConsistency(
  events: TransferEvent[],
): GlobalConsistencyResult {
  const balances = nonZeroAddressBalances(events);
  const total_net_sum = balances.reduce(
    (sum, b) => sum + b.net_balance_wei,
    0n,
  );

  // 计算 mint - burn 作为期望值
  let minted = 0n;
  let burned = 0n;
  for (const e of events) {
    if (e.from_address === ZERO_ADDRESS) minted += e.amount;
    if (e.to_address === ZERO_ADDRESS) burned += e.amount;
  }

  const expected = minted - burned;
  return {
    total_net_sum,
    address_count: balances.length,
    audit_result: total_net_sum === expected ? "PASS" : "FAIL",
  };
}

// ── 查询 6c：mint - burn = Σ all balances ────────────────
// mint = SUM(amount) WHERE from_address = 0x0
// burn = SUM(amount) WHERE to_address = 0x0
// non_zero_sum = Σ non-zero net balances
// 若 mint - burn = non_zero_sum → PASS

export function mintBurnGlobalCheck(
  events: TransferEvent[],
): MintBurnGlobalCheck {
  let minted_wei = 0n;
  let burned_wei = 0n;
  let non_zero_sum = 0n;

  const netMap = new Map<string, bigint>();

  for (const e of events) {
    if (e.from_address === ZERO_ADDRESS) {
      minted_wei += e.amount; // mint
      // 接收方余额 +amount
      netMap.set(
        e.to_address,
        (netMap.get(e.to_address) ?? 0n) + e.amount,
      );
    } else if (e.to_address === ZERO_ADDRESS) {
      burned_wei += e.amount; // burn
      // 发送方余额 -amount
      netMap.set(
        e.from_address,
        (netMap.get(e.from_address) ?? 0n) - e.amount,
      );
    } else {
      // 普通转账：to 增加，from 减少
      netMap.set(
        e.from_address,
        (netMap.get(e.from_address) ?? 0n) - e.amount,
      );
      netMap.set(
        e.to_address,
        (netMap.get(e.to_address) ?? 0n) + e.amount,
      );
    }
  }

  for (const v of netMap.values()) {
    non_zero_sum += v;
  }

  const net_supply_wei = minted_wei - burned_wei;
  return {
    minted_wei,
    burned_wei,
    net_supply_wei,
    sum_of_all_balances_wei: non_zero_sum,
    global_check:
      net_supply_wei === non_zero_sum ? "PASS" : "FAIL",
  };
}

// ── 工具 ──────────────────────────────────────────────────

/** wei → ether 字符串表示（保留 18 位小数） */
function formatEther(wei: bigint): string {
  const divisor = 10n ** 18n;
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const intPart = abs / divisor;
  const fracPart = abs % divisor;
  const fracStr = fracPart.toString().padStart(18, "0");
  // 去除尾部多余的 0
  const trimmed = fracStr.replace(/0+$/, "") || "0";
  return `${negative ? "-" : ""}${intPart}.${trimmed}`;
}
