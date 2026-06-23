// Sepolia 对账验证
// 用法：SEPOLIA_RPC_URL=https://... npx tsx verify-sepolia.ts
import { Pool } from "pg";
import { createPublicClient, http, type Address } from "viem";

const CONTRACT = "0x841e5B95e401a17eDb5e051C792154e6f0AD8c28" as Address;
const RPC = process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY";
const DB = process.env.DATABASE_URL || "postgres://indexer:indexer123@localhost:5432/indexer_db";

const { QUERIES } = await import("./src/db-queries.js");

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Sepolia 对账验证                         ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const pool = new Pool({ connectionString: DB });
  await pool.query("DELETE FROM transfer_events");

  const pc = createPublicClient({ transport: http(RPC) });

  // ── 1. 读链上状态 ──
  const latestBlock = await pc.getBlockNumber();
  const supply = (await pc.readContract({
    address: CONTRACT,
    abi: [{ type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }],
    functionName: "totalSupply",
  })) as bigint;

  console.log(`1. 链上状态:`);
  console.log(`   当前块高: ${latestBlock}`);
  console.log(`   totalSupply: ${supply / 10n ** 18n} STK`);

  // Alchemy 免费版限制每次 10 个区块
  const DEPLOY_BLOCK = 11121796n;
  const BATCH = 10n;
  let totalLogs = 0;

  console.log(`\n2. 分批扫描 Transfer 事件 (${DEPLOY_BLOCK}→${latestBlock})...`);

  for (let from = DEPLOY_BLOCK; from <= latestBlock; from += BATCH) {
    const to = from + BATCH - 1n > latestBlock ? latestBlock : from + BATCH - 1n;
    try {
      const logs = await pc.getLogs({
        address: CONTRACT,
        event: {
          type: "event", name: "Transfer",
          inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
          ],
        },
        fromBlock: from,
        toBlock: to,
      });

      for (const log of logs) {
        const block = await pc.getBlock({ blockNumber: log.blockNumber });
        await pool.query(
          `INSERT INTO transfer_events (tx_hash, block_number, block_timestamp, from_address, to_address, amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            log.transactionHash,
            log.blockNumber,
            block.timestamp,
            (log.args.from as string).toLowerCase(),
            (log.args.to as string).toLowerCase(),
            (log.args.value as bigint).toString(),
          ],
        );
        totalLogs++;
      }
    } catch (e: any) {
      // 有些 block range 可能被限，跳过
    }
  }

  const { rows: [cnt] } = await pool.query("SELECT COUNT(*) as c FROM transfer_events");
  console.log(`   共写入 ${totalLogs} 条, PG 共 ${cnt.c} 条\n`);

  // ── 3. 对账 ──
  console.log("3. 对账 SQL:");
  const { rows: blocks } = await pool.query(QUERIES.rowCountByBlock);
  console.log(`   查询1 行数：${blocks.length} 个区块`);

  const { rows: dups } = await pool.query(QUERIES.duplicateTransactions);
  console.log(`   查询4 重复：${dups.length ? "❌ " + dups.length : "✅ 无"}`);

  const { rows: [chk] } = await pool.query(QUERIES.mintBurnGlobalCheck);
  console.log(`   查询6 恒等式：${chk.global_check === "PASS" ? "✅" : "❌"} mint=${chk.minted_wei} burn=${chk.burned_wei} Σ=${chk.sum_of_all_balances_wei}`);

  // ── 4. 详情 ──
  const { rows: all } = await pool.query("SELECT * FROM transfer_events ORDER BY id");
  console.log(`\n4. PG 事件 (${all.length} 条):`);
  for (const r of all.slice(0, 10)) {
    console.log(`   #${r.id} blk=${r.block_number} ${r.from_address.slice(0,10)}→${r.to_address.slice(0,10)} ${BigInt(r.amount)/10n**18n} STK`);
  }

  await pool.end();
  console.log(`\n✅ Sepolia 对账完成。`);
}

main().catch(e => { console.error(e); process.exit(1); });
