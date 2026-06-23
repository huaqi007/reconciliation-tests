// ============================================================
// PgIndexer — 生产级链上索引器（对接真实 PostgreSQL）
//
// 职责：
//   1. 初始化 transfer_events 表
//   2. 轮询链上 Transfer 事件 → INSERT 到 PostgreSQL
//   3. 提供与 MockIndexer 一致的查询接口（内部跑真实 SQL）
//   4. 配合 eventually() 做对账
//
// 与 MockIndexer / ChainIndexer 的关系：
//
//   MockIndexer   → 内存假数据，毫秒级，教学/快速验证用
//   ChainIndexer  → 内存真数据，从链上拉但不持久化
//   PgIndexer     → PostgreSQL 真数据，生产环境用 ← 这就是你问的「真实情况」
//
// 用法：
//   const pool = new Pool({ connectionString: "postgres://..." });
//   const indexer = await PgIndexer.create(pool, { rpcUrl, pollingMs: 500 });
//   const token = indexer.token;
//
//   const txHash = await indexer.transfer(alice, bob, 100e18);
//
//   // eventually() 轮询 PostgreSQL，直到查到这笔记录
//   await eventually(async () => {
//     const { rows } = await indexer.getByTxHash(txHash);
//     return rows.length > 0;
//   }, { timeout: 10000, interval: 500, backoff: "linear" });
//
//   // 对账：直接跑 SQL
//   const { rows: [result] } = await indexer.mintBurnGlobalCheck();
//   console.log(result.global_check); // "PASS" or "FAIL"
//
//   await indexer.shutdown();
// ============================================================

import { EventEmitter } from "node:events";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { spawn, type ChildProcess } from "node:child_process";
import type { Pool, QueryResult } from "pg";
import {
  QUERIES,
  CREATE_TABLE,
  TRUNCATE_TABLE,
} from "./db-queries.js";
import type { DeployedToken } from "./chain-indexer.js";

// ═══════════════════════════════════════════════════════════
// SimpleToken ABI（精简）
// ═══════════════════════════════════════════════════════════

const SIMPLE_TOKEN_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ═══════════════════════════════════════════════════════════
// PgIndexer
// ═══════════════════════════════════════════════════════════

export interface PgIndexerOptions {
  rpcUrl: string;
  pollingIntervalMs: number;
  launchAnvil: boolean;
  anvilPort: number;
}

export class PgIndexer extends EventEmitter {
  public readonly publicClient: PublicClient;
  public readonly walletClient: WalletClient;
  public readonly token: DeployedToken;
  public readonly pool: Pool;

  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastBlockChecked = 0n;
  private anvilProcess: ChildProcess | null = null;
  private rpcUrl: string;

  private constructor(
    pool: Pool,
    publicClient: PublicClient,
    walletClient: WalletClient,
    token: DeployedToken,
    rpcUrl: string,
    anvilProcess: ChildProcess | null,
    pollingMs: number,
  ) {
    super();
    this.pool = pool;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.token = token;
    this.rpcUrl = rpcUrl;
    this.anvilProcess = anvilProcess;

    this.startPolling(pollingMs);
  }

  /**
   * 工厂：初始化 PostgreSQL 表 → 启动 anvil（可选）
   * → 部署 SimpleToken → 开始轮询链上事件写入 PG。
   */
  static async create(
    pool: Pool,
    options: Partial<PgIndexerOptions> = {},
  ): Promise<PgIndexer> {
    const port = options.anvilPort ?? 8545;
    const pollingMs = options.pollingIntervalMs ?? 500;
    const launchAnvil = options.launchAnvil ?? true;
    const rpcUrl = options.rpcUrl ?? `http://127.0.0.1:${port}`;

    // 1. 确保表存在
    await pool.query(CREATE_TABLE);
    console.log("[PgIndexer] transfer_events 表已就绪");

    let anvilProcess: ChildProcess | null = null;

    if (launchAnvil) {
      anvilProcess = spawn("anvil", ["--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForRpc(rpcUrl, 10000);
      console.log(`[PgIndexer] anvil 已启动：${rpcUrl}`);
    }

    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const deployerAddress =
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

    const walletClient = createWalletClient({
      account: deployerAddress,
      transport: http(rpcUrl),
    });

    // 2. 部署合约
    const token = await deploySimpleToken(publicClient, walletClient);
    console.log(`[PgIndexer] SimpleToken 已部署：${token.address}`);

    const indexer = new PgIndexer(
      pool,
      publicClient,
      walletClient,
      token,
      rpcUrl,
      anvilProcess,
      pollingMs,
    );

    // 3. 回溯已产生的 Transfer 事件
    await new Promise((r) => setTimeout(r, 300));
    await indexer.pollNow();

    return indexer;
  }

  // ── 事件轮询 → INSERT 到 PostgreSQL ───────────────────

  private startPolling(intervalMs: number): void {
    this.pollingTimer = setInterval(() => {
      this.pollNow().catch((err) => this.emit("error", err));
    }, intervalMs);
  }

  async pollNow(): Promise<void> {
    const latestBlock = await this.publicClient.getBlockNumber();
    const fromBlock =
      this.lastBlockChecked === 0n ? 0n : this.lastBlockChecked + 1n;
    const toBlock = latestBlock;

    if (fromBlock > toBlock) return;

    try {
      const logs = await this.publicClient.getLogs({
        address: this.token.address,
        event: {
          type: "event",
          name: "Transfer",
          inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
          ],
        },
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        const block = await this.publicClient.getBlock({
          blockNumber: log.blockNumber,
        });

        // INSERT 到 PostgreSQL（ON CONFLICT 防重复）
        await this.pool.query(
          `INSERT INTO transfer_events (tx_hash, block_number, block_timestamp, from_address, to_address, amount)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            log.transactionHash,
            log.blockNumber,
            block.timestamp,
            (log.args.from as string).toLowerCase(),
            (log.args.to as string).toLowerCase(),
            log.args.value as bigint,
          ],
        );

        this.emit("indexed", log.transactionHash);
      }
    } catch (err) {
      this.emit("warn", err);
    }

    this.lastBlockChecked = toBlock;
  }

  // ── 链上操作 ────────────────────────────────────────────

  async transfer(from: Address, to: Address, amount: bigint): Promise<string> {
    const hash = await this.walletClient.writeContract({
      address: this.token.address,
      abi: SIMPLE_TOKEN_ABI,
      functionName: "transfer",
      args: [to, amount],
      account: from,
      chain: null as any,
    } as any);
    return hash;
  }

  async mint(to: Address, amount: bigint): Promise<string> {
    const hash = await this.walletClient.writeContract({
      address: this.token.address,
      abi: SIMPLE_TOKEN_ABI,
      functionName: "mint",
      args: [to, amount],
      account: this.token.owner,
      chain: null as any,
    } as any);
    return hash;
  }

  async balanceOf(address: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.token.address,
      abi: SIMPLE_TOKEN_ABI,
      functionName: "balanceOf",
      args: [address],
    }) as Promise<bigint>;
  }

  async totalSupply(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.token.address,
      abi: SIMPLE_TOKEN_ABI,
      functionName: "totalSupply",
    }) as Promise<bigint>;
  }

  // ── 对账查询（真实 SQL → PostgreSQL）──────────────────

  /** 按 tx_hash 查事件（配合 eventually() 轮询用） */
  async getByTxHash(txHash: string) {
    return this.pool.query(QUERIES.getByTxHash, [txHash]);
  }

  /** 查询 1：行数对账 */
  async rowCountByBlock() {
    return this.pool.query(QUERIES.rowCountByBlock);
  }

  /** 查询 2：金额对账 */
  async amountByAddress() {
    return this.pool.query(QUERIES.amountByAddress);
  }

  /** 查询 3：余额推导 */
  async balanceDerivation(address: string) {
    return this.pool.query(QUERIES.balanceDerivation, [address]);
  }

  /** 查询 3b：批量余额 */
  async allBalances() {
    return this.pool.query(QUERIES.allBalances);
  }

  /** 查询 4：重复检测 */
  async duplicateTransactions() {
    return this.pool.query(QUERIES.duplicateTransactions);
  }

  /** 查询 5：延迟检测 */
  async latencyRecords(thresholdSeconds: number = 60) {
    return this.pool.query(QUERIES.latencyRecords, [thresholdSeconds]);
  }

  /** 查询 6：全局恒等式 */
  async mintBurnGlobalCheck() {
    return this.pool.query(QUERIES.mintBurnGlobalCheck);
  }

  /** 表总行数 */
  async countAll() {
    return this.pool.query(QUERIES.countAll);
  }

  // ── 生命周期 ────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.anvilProcess) {
      this.anvilProcess.kill("SIGTERM");
      this.anvilProcess = null;
    }
    this.removeAllListeners();
  }
}

// ═══════════════════════════════════════════════════════════
// 内部工具
// ═══════════════════════════════════════════════════════════

async function waitForRpc(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id: 1,
        }),
      });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`RPC ${rpcUrl} 未就绪`);
}

async function deploySimpleToken(
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<DeployedToken> {
  const fs = await import("node:fs");
  const artifactPath = new URL(
    "../../out/SimpleToken.sol/SimpleToken.json",
    import.meta.url,
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const bytecode = artifact.bytecode.object as `0x${string}`;

  const deployerAddress =
    walletClient.account?.address ??
    ("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address);

  const hash = await walletClient.deployContract({
    abi: SIMPLE_TOKEN_ABI,
    bytecode,
    account: deployerAddress,
    chain: null as any,
  } as any);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress!, owner: deployerAddress };
}
