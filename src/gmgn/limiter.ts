// Process-wide weighted leaky bucket in front of GMGN. Every request takes
// `weight` units; the bucket drains at `ratePerSec` and holds `capacity`.
// Waiters are served by priority (higher first), then FIFO, so the live feed
// never queues behind a discovery batch. A 429 pauses everything until the
// server's reset time and halves the rate; it recovers slowly afterwards.

export interface LimiterOptions {
  ratePerSec: number;
  capacity: number;
  minRatePerSec?: number;
  /** Rate recovers by this factor every `recoverEveryMs` without a 429. */
  recoverFactor?: number;
  recoverEveryMs?: number;
  /** Bucket level at start; a full bucket makes a fresh process wait first. */
  initialLevel?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
  weight: number;
  priority: number;
  /** Units that must stay free after this grant (headroom for higher priorities). */
  reserve: number;
  seq: number;
  resolve: () => void;
}

export class WeightedLimiter {
  readonly maxRate: number;
  rate: number;
  readonly capacity: number;
  private readonly minRate: number;
  private readonly recoverFactor: number;
  private readonly recoverEveryMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private level = 0;
  private lastLeak: number;
  private pausedUntil = 0;
  private lastRecoverAt = 0;
  private queue: Waiter[] = [];
  private seq = 0;
  private pumping = false;
  /** Total weight granted, for stats. */
  granted = 0;

  constructor(options: LimiterOptions) {
    this.maxRate = options.ratePerSec;
    this.rate = options.ratePerSec;
    this.capacity = options.capacity;
    this.minRate = options.minRatePerSec ?? options.ratePerSec / 4;
    this.recoverFactor = options.recoverFactor ?? 1.25;
    this.recoverEveryMs = options.recoverEveryMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.lastLeak = this.now();
    this.level = options.initialLevel ?? 0;
  }

  acquire(weight: number, priority = 0, reserve = 0): Promise<void> {
    if (weight + reserve > this.capacity) throw new Error(`weight ${weight} + reserve ${reserve} exceeds bucket capacity ${this.capacity}`);
    return new Promise((resolve) => {
      this.queue.push({ weight, priority, reserve, seq: this.seq++, resolve });
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      void this.pump();
    });
  }

  /** Stop all requests until `untilMs`; with `slowDown` also halve the rate. */
  penalize(untilMs: number, slowDown = true): void {
    this.pausedUntil = Math.max(this.pausedUntil, untilMs);
    if (!slowDown) return;
    this.rate = Math.max(this.minRate, this.rate / 2);
    this.lastRecoverAt = this.now();
  }

  get paused(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  get pending(): number {
    return this.queue.length;
  }

  private leak(): void {
    const now = this.now();
    this.level = Math.max(0, this.level - ((now - this.lastLeak) / 1000) * this.rate);
    this.lastLeak = now;
    if (this.rate < this.maxRate && now - this.lastRecoverAt >= this.recoverEveryMs) {
      this.rate = Math.min(this.maxRate, this.rate * this.recoverFactor);
      this.lastRecoverAt = now;
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const pause = this.pausedUntil - this.now();
        if (pause > 0) {
          await this.sleep(pause);
          continue;
        }
        this.leak();
        const head = this.queue[0]!;
        const overflow = this.level + head.weight + head.reserve - this.capacity;
        if (overflow <= 0) {
          this.queue.shift();
          this.level += head.weight;
          this.granted += head.weight;
          head.resolve();
          continue;
        }
        await this.sleep(Math.ceil((overflow / this.rate) * 1000));
      }
    } finally {
      this.pumping = false;
    }
  }
}
