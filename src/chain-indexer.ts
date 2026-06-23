// ============================================================
// ChainIndexer — 真实链上事件监听 + 索引
//
// 连接 anvil 本地节点，部署 SimpleToken，监听 Transfer 事件，
// 写入内存存储，对外暴露与 MockIndexer 完全相同的查询接口。
//
// MockIndexer：测试用（无外网依赖，快）
// ChainIndexer：真实链上数据（需要 anvil）
//
// 两者实现同一套查询接口，可以互换。
// ============================================================

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { TransferEvent, CatchEventParams } from "./types.js";
import { ZERO_ADDRESS } from "./types.js";

// ═══════════════════════════════════════════════════════════
// SimpleToken ABI — 精简版，只取 Transfer 事件签名
// ═══════════════════════════════════════════════════════════

const SIMPLE_TOKEN_ABI = [
  {
    type: "constructor",
    inputs: [],
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
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

export interface DeployedToken {
  address: Address;
  /** 部署者地址（owner） */
  owner: Address;
}

// ═══════════════════════════════════════════════════════════
// ChainIndexer
// ═══════════════════════════════════════════════════════════

/**
 * 真实链上索引器。
 *
 * 启动时会部署 SimpleToken 并开始轮询 Transfer 事件。
 * 所有查询方法返回与 MockIndexer 一致的结果类型。
 *
 * 用法：
 * ```ts
 * const indexer = await ChainIndexer.create({ pollingIntervalMs: 500 });
 * const token = indexer.token;
 *
 * // 发交易
 * const txHash = await indexer.transfer(alice, bob, 100n * 10n**18n);
 *
 * // 等待索引器追上
 * await eventually(() => indexer.getEventsByTxHash(txHash).length > 0, {...});
 *
 * // 对账
 * const result = indexer.globalConsistency();
 *
 * await indexer.shutdown();
 * ```
 */
export class ChainIndexer extends EventEmitter {
  private events: TransferEvent[] = [];
  private nextId = 1;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastBlockChecked = 0n;
  private anvilProcess: ChildProcess | null = null;

  public readonly publicClient: PublicClient;
  public readonly walletClient: WalletClient;
  public readonly token!: DeployedToken;
  public readonly rpcUrl: string;

  private constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    token: DeployedToken,
    rpcUrl: string,
    anvilProcess: ChildProcess | null,
    pollingIntervalMs: number,
  ) {
    super();
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.token = token;
    this.rpcUrl = rpcUrl;
    this.anvilProcess = anvilProcess;

    // 开始轮询链上事件
    this.startPolling(pollingIntervalMs);
  }

  /**
   * 工厂：启动 anvil → 部署 SimpleToken → 返回就绪的 ChainIndexer。
   *
   * @param options.anvilPort    anvil 端口（默认 8545）
   * @param options.pollingIntervalMs 轮询间隔（默认 500ms）
   * @param options.launchAnvil  是否自己启动 anvil（默认 true，设为 false 则连接已有实例）
   */
  static async create(options: {
    anvilPort?: number;
    pollingIntervalMs?: number;
    launchAnvil?: boolean;
  } = {}): Promise<ChainIndexer> {
    const port = options.anvilPort ?? 8545;
    const pollingMs = options.pollingIntervalMs ?? 500;
    const launchAnvil = options.launchAnvil ?? true;
    const rpcUrl = `http://127.0.0.1:${port}`;

    let anvilProcess: ChildProcess | null = null;

    if (launchAnvil) {
      anvilProcess = spawn("anvil", ["--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // 等 anvil 就绪
      await waitForRpc(rpcUrl, 10000);
    }

    const publicClient = createPublicClient({
      transport: http(rpcUrl),
    });

    // anvil 默认第一个账户（有 10000 ETH）
    const deployerAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

    const walletClient = createWalletClient({
      account: deployerAddress,
      transport: http(rpcUrl),
    });

    // 部署 SimpleToken
    const token = await deploySimpleToken(publicClient, walletClient);

    const indexer = new ChainIndexer(
      publicClient,
      walletClient,
      token,
      rpcUrl,
      anvilProcess,
      pollingMs,
    );

    // 等待部署确认后回溯已经产生的 Transfer 事件（mint to owner）
    await new Promise((r) => setTimeout(r, 500));
    await indexer.pollNow();

    return indexer;
  }

  // ── 事件轮询 ────────────────────────────────────────────

  private startPolling(intervalMs: number): void {
    this.pollingTimer = setInterval(() => {
      this.pollNow().catch((err) => {
        this.emit("error", err);
      });
    }, intervalMs);
  }

  /** 手动触发一次轮询（测试用） */
  async pollNow(): Promise<void> {
    const latestBlock = await this.publicClient.getBlockNumber();
    const fromBlock = this.lastBlockChecked === 0n
      ? 0n
      : this.lastBlockChecked + 1n;
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

        const event: TransferEvent = {
          id: this.nextId++,
          tx_hash: log.transactionHash,
          block_number: log.blockNumber,
          block_timestamp: block.timestamp,
          from_address: (log.args.from as string).toLowerCase(),
          to_address: (log.args.to as string).toLowerCase(),
          amount: log.args.value as bigint,
          created_at: new Date(), // 索引器写入时间
        };

        // 去重
        if (!this.events.some((e) => e.tx_hash === event.tx_hash)) {
          this.events.push(event);
          this.emit("indexed", event);
        }
      }
    } catch (err) {
      // getLogs 可能因为 block range 太大失败，忽略继续
      this.emit("warn", err);
    }

    this.lastBlockChecked = toBlock;
  }

  // ── 链上操作 ────────────────────────────────────────────

  /** 发送 transfer 交易，返回 txHash */
  async transfer(
    from: Address,
    to: Address,
    amount: bigint,
  ): Promise<`0x${string}`> {
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

  /** 发送 mint 交易（onlyOwner） */
  async mint(
    to: Address,
    amount: bigint,
  ): Promise<`0x${string}`> {
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

  /** 查询链上余额 */
  async balanceOf(address: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.token.address,
      abi: SIMPLE_TOKEN_ABI,
      functionName: "balanceOf",
      args: [address],
    }) as Promise<bigint>;
  }

  /** 查询链上 totalSupply */
  async totalSupply(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.token.address,
      abi: SIMPLE_TOKEN_ABI,
      functionName: "totalSupply",
    }) as Promise<bigint>;
  }

  // ── 查询接口（与 MockIndexer 一致）──────────────────────

  getAllEvents(): TransferEvent[] {
    return [...this.events];
  }

  getEventsByTxHash(txHash: string): TransferEvent[] {
    return this.events.filter((e) => e.tx_hash === txHash);
  }

  getEventsByBlock(blockNumber: bigint): TransferEvent[] {
    return this.events.filter((e) => e.block_number === blockNumber);
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

/** 轮询等待 RPC 就绪 */
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
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`RPC at ${rpcUrl} did not become ready within ${timeoutMs}ms`);
}

/** 部署 SimpleToken 并返回合约信息 */
async function deploySimpleToken(
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<DeployedToken> {
  // 从 Foundry 编译产物读取 bytecode
  const fs = await import("node:fs");
  const artifactPath = new URL(
    "../../out/SimpleToken.sol/SimpleToken.json",
    import.meta.url,
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  const bytecode = artifact.bytecode.object as `0x${string}`;

  const deployerAddress = walletClient.account?.address ??
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

  const hash = await walletClient.deployContract({
    abi: SIMPLE_TOKEN_ABI,
    bytecode,
    account: deployerAddress,
    chain: null as any,
  } as any);

  // 等待部署确认
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const contractAddress = receipt.contractAddress!;

  return {
    address: contractAddress,
    owner: deployerAddress,
  };
}
