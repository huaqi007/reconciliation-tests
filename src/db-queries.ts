// ============================================================
// 对账 SQL 查询 — 生产环境直接对 PostgreSQL 执行
//
// 这些是与 audit_queries.sql 完全一致的 SQL 语句。
// 类型定义在 types.ts 中。
//
// 用法：
//   const rows = await pool.query(QUERIES.rowCountByBlock);
//   const bal  = await pool.query(QUERIES.balanceDerivation, ["0xAlice"]);
// ============================================================

/** 对账 SQL 查询集 — 参数化，可直接传给 pg Pool.query() */
export const QUERIES = {
  // ── 1. 行数对账 ──────────────────────────────────────
  rowCountByBlock: `
    SELECT
        block_number,
        COUNT(*) AS transfer_count
    FROM transfer_events
    GROUP BY block_number
    ORDER BY block_number
  `,

  // ── 2. 金额对账 ──────────────────────────────────────
  amountByAddress: `
    SELECT
        from_address,
        COUNT(*)                         AS tx_count,
        SUM(amount)                      AS total_out_wei,
        SUM(amount) / 1e18               AS total_out_ether
    FROM transfer_events
    GROUP BY from_address
    ORDER BY total_out_wei DESC
  `,

  // ── 3. 余额推导（参数：$1 = target_address）──────────
  balanceDerivation: `
    WITH incoming AS (
        SELECT COALESCE(SUM(amount), 0) AS total_in
        FROM transfer_events
        WHERE to_address = $1
    ),
    outgoing AS (
        SELECT COALESCE(SUM(amount), 0) AS total_out
        FROM transfer_events
        WHERE from_address = $1
    )
    SELECT
        $1::TEXT                                     AS address,
        i.total_in                                   AS total_received_wei,
        o.total_out                                  AS total_sent_wei,
        i.total_in - o.total_out                     AS balance_wei,
        (i.total_in - o.total_out) / 1e18            AS balance_ether
    FROM incoming i, outgoing o
  `,

  // ── 3b. 批量余额推导 ────────────────────────────────
  allBalances: `
    WITH all_addresses AS (
        SELECT from_address AS addr FROM transfer_events
        UNION
        SELECT to_address   AS addr FROM transfer_events
    ),
    incoming AS (
        SELECT to_address AS addr, COALESCE(SUM(amount), 0) AS total_in
        FROM transfer_events
        GROUP BY to_address
    ),
    outgoing AS (
        SELECT from_address AS addr, COALESCE(SUM(amount), 0) AS total_out
        FROM transfer_events
        GROUP BY from_address
    )
    SELECT
        a.addr,
        COALESCE(i.total_in, 0) - COALESCE(o.total_out, 0) AS balance_wei
    FROM all_addresses a
    LEFT JOIN incoming i ON a.addr = i.addr
    LEFT JOIN outgoing o ON a.addr = o.addr
    ORDER BY balance_wei DESC
  `,

  // ── 4. 重复检测 ──────────────────────────────────────
  duplicateTransactions: `
    SELECT
        tx_hash,
        COUNT(*)                         AS occurrence_count,
        STRING_AGG(id::TEXT, ',')        AS duplicate_ids,
        MIN(block_number)                AS first_block,
        SUM(amount)                      AS total_amount_duplicated
    FROM transfer_events
    GROUP BY tx_hash
    HAVING COUNT(*) > 1
    ORDER BY occurrence_count DESC
  `,

  // ── 5. 延迟检测（参数：$1 = threshold_seconds）─────
  latencyRecords: `
    SELECT
        id,
        tx_hash,
        block_number,
        block_timestamp,
        created_at,
        EXTRACT(EPOCH FROM created_at)::BIGINT                     AS created_at_epoch,
        ABS(
            block_timestamp - EXTRACT(EPOCH FROM created_at)::BIGINT
        )                                                          AS delay_seconds
    FROM transfer_events
    WHERE ABS(
        block_timestamp - EXTRACT(EPOCH FROM created_at)::BIGINT
    ) > $1
    ORDER BY delay_seconds DESC
  `,

  // ── 6. 全局一致性（mint - burn = Σ balances）───────
  mintBurnGlobalCheck: `
    WITH mint_amount AS (
        SELECT COALESCE(SUM(amount), 0) AS total_minted
        FROM transfer_events
        WHERE from_address = '0x0000000000000000000000000000000000000000'
    ),
    burn_amount AS (
        SELECT COALESCE(SUM(amount), 0) AS total_burned
        FROM transfer_events
        WHERE to_address = '0x0000000000000000000000000000000000000000'
    ),
    non_zero_net AS (
        SELECT COALESCE(SUM(net), 0) AS non_zero_sum
        FROM (
            SELECT
                COALESCE(
                    (SELECT SUM(amount) FROM transfer_events te2 WHERE te2.to_address = a.addr), 0
                ) -
                COALESCE(
                    (SELECT SUM(amount) FROM transfer_events te2 WHERE te2.from_address = a.addr), 0
                ) AS net
            FROM (
                SELECT from_address AS addr FROM transfer_events
                WHERE from_address != '0x0000000000000000000000000000000000000000'
                UNION
                SELECT to_address AS addr FROM transfer_events
                WHERE to_address != '0x0000000000000000000000000000000000000000'
            ) a
        ) sub
    )
    SELECT
        m.total_minted                AS minted_wei,
        b.total_burned                AS burned_wei,
        m.total_minted - b.total_burned AS net_supply_wei,
        n.non_zero_sum                AS sum_of_all_balances_wei,
        CASE
            WHEN m.total_minted - b.total_burned = n.non_zero_sum
            THEN 'PASS'
            ELSE 'FAIL'
        END                           AS global_check
    FROM mint_amount m, burn_amount b, non_zero_net n
  `,

  // ── 工具：查询指定 tx_hash ───────────────────────────
  getByTxHash: `
    SELECT * FROM transfer_events WHERE tx_hash = $1
  `,

  // ── 工具：总行数 ─────────────────────────────────────
  countAll: `
    SELECT COUNT(*) AS total FROM transfer_events
  `,
} as const;

/** 创建 transfer_events 表（幂等） */
export const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS transfer_events (
      id SERIAL PRIMARY KEY,
      tx_hash VARCHAR(66) NOT NULL,
      block_number BIGINT NOT NULL,
      block_timestamp BIGINT NOT NULL,
      from_address VARCHAR(42) NOT NULL,
      to_address VARCHAR(42) NOT NULL,
      amount NUMERIC(78, 0) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_transfer_tx_hash ON transfer_events(tx_hash);
  CREATE INDEX IF NOT EXISTS idx_transfer_block ON transfer_events(block_number);
  CREATE INDEX IF NOT EXISTS idx_transfer_from ON transfer_events(from_address);
  CREATE INDEX IF NOT EXISTS idx_transfer_to ON transfer_events(to_address);
  CREATE INDEX IF NOT EXISTS idx_transfer_created ON transfer_events(created_at);
`;

/** 清空表（测试用） */
export const TRUNCATE_TABLE = `TRUNCATE TABLE transfer_events RESTART IDENTITY`;
