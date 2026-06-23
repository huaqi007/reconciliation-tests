/**
 * 配置选项 for eventually().
 */
export interface EventuallyOptions {
  /** 超时时间（毫秒），超过此时间仍未成功则 reject */
  timeout: number;
  /** 初始轮询间隔（毫秒） */
  interval: number;
  /** 退避策略：linear 固定间隔，exponential 每次翻倍（上限 10 秒） */
  backoff: "linear" | "exponential";
  /**
   * 可选回调：每次 fn() 返回 false 后调用。
   * @param attempt - 当前重试次数（从 1 开始计数）
   * @param lastResult - fn() 的返回值（此时为 false）
   */
  onRetry?: (attempt: number, lastResult: boolean) => void;
}

/**
 * 异步轮询断言：反复调用 fn() 直到它返回 true，超时则 reject。
 *
 * 使用 Promise.race + AbortController 实现硬超时：
 * - 到点后不仅 reject，还会 abort 当前正在等待的 sleep，
 *   不会让 setTimeout 残留在事件队列里。
 * - 即使 fn() 卡死或退避间隔膨胀到 10 秒，超时照样准时触发。
 *
 * @param fn      — 返回 Promise<boolean> 的断言函数
 * @param options — 超时、间隔、退避策略等配置
 * @returns Promise<void> — 成功时 resolve，超时时 reject
 *
 * @example
 * ```ts
 * await eventually(() => fetchStatus(), {
 *   timeout: 5000,
 *   interval: 200,
 *   backoff: "exponential",
 *   onRetry: (n, v) => console.log(`retry #${n}, value=${v}`),
 * });
 * ```
 */
export async function eventually(
  fn: () => Promise<boolean>,
  options: EventuallyOptions,
): Promise<void> {
  const { timeout, interval, backoff, onRetry } = options;
  const deadline = Date.now() + timeout;
  let attempts = 0;
  let lastResult = false;
  let currentInterval = interval;

  // ── timeout = 0 特殊路径 ──────────────────────────────
  if (timeout === 0) {
    attempts = 1;
    lastResult = await fn();
    if (lastResult) return;
    throw buildTimeoutError(/* elapsed */ 0, attempts, lastResult);
  }

  // ── AbortController：统一取消 sleep 和超时计时器 ──────
  const abort = new AbortController();

  // ── 硬超时 Promise ──────────────────────────────────────
  // timer 封装在 Promise 内部，对外只暴露 cleanUp 回调，
  // 避免外部持有裸 timer 引用。
  let clearHardTimeout!: () => void; // 在下方 Promise executor 中同步赋值
  const hardTimeout = new Promise<never>((_, _reject) => {
    const timer = setTimeout(() => {
      abort.abort(); // 取消正在等待的 sleep
      const elapsed = Date.now() - deadline + timeout;
      _reject(buildTimeoutError(elapsed, attempts, lastResult));
    }, timeout);
    clearHardTimeout = () => clearTimeout(timer);
  });

  // ── 轮询循环 ────────────────────────────────────────────
  const poll = (async (): Promise<void> => {
    try {
      while (!abort.signal.aborted) {
        attempts++;
        lastResult = await fn();

        if (lastResult) {
          return; // ✅ resolve
        }

        onRetry?.(attempts, lastResult);

        // sleep 接受 AbortSignal：一旦超时触发 abort()，
        // sleep 立刻 resolve 而不是等到 interval 结束。
        await cancellableSleep(currentInterval, abort.signal);

        if (backoff === "exponential") {
          currentInterval = Math.min(currentInterval * 2, 10_000);
        }
      }
    } finally {
      clearHardTimeout();
      // 确保不管是成功、fn 抛异常还是超时先到，所有计时器都被清理。
      // 重复 abort 无副作用（AbortController 幂等）。
      abort.abort();
    }
  })();

  await Promise.race([poll, hardTimeout]);

  // 如果 poll 在超时前成功，上面这行会 resolve。
  // 如果 hardTimeout 先到 → reject，调用方拿到错误。
  // _不_ 需要在这里额外处理 timedOut 标志——
  // 错误信息早已在 hardTimeout 内部构造好了。
}

// ── 工具函数 ──────────────────────────────────────────────

/**
 * 可取消的 sleep：与普通 sleep 用法相同，
 * 但如果 signal 在等待期间被 abort，会立刻 resolve（不等满 ms）。
 * 这样既不会阻塞后续 finally 清理，也不会让 setTimeout 残留。
 */
function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  // 已经 aborted → 直接返回，不创建任何计时器
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** 构造统一的超时错误 */
function buildTimeoutError(
  elapsed: number,
  attempts: number,
  lastResult: boolean,
): Error {
  return new Error(
    `eventually timed out after ${elapsed}ms and ${attempts} attempts. ` +
      `Last return value: ${lastResult}`,
  );
}
