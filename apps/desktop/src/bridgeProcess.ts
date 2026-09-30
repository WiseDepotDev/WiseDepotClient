import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * 桥子进程的生命周期管理。
 *
 * **刻意不依赖 Electron**：这段逻辑是 W2 里最容易出错、也最值得单独验证的部分
 * （握手超时、子进程崩溃、僵尸进程、重复启动），把它放在一个纯 Node 模块里，
 * 就能用 `tools/bench/desktop-host.mjs` 直接对着真的 JVM 桥跑，不需要拉起 GUI。
 * main.ts 只负责把它接到窗口上。
 *
 * 三条硬约定：
 * 1. **token 从 stdout 读，不走 argv** —— argv 对本机其它用户可见；
 * 2. **stdin 是"父进程还活着"的信号** —— Electron 崩溃时子进程会因 stdin EOF 自行退出，
 *    不依赖父进程有机会执行清理代码（这点很关键：崩溃时没有 before-quit）；
 * 3. **异常退出才重启**，主动 stop 不算崩溃（否则退出时会自我复活）。
 */

export interface BridgeHandshake {
  readonly v: number;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly ver: string;
  readonly platform: string;
  /** 逗号分隔（宿主进程内是 Set，序列化时压成字符串） */
  readonly capabilities: string;
}

/** 子进程崩溃时的重启策略。 */
export interface RestartPolicy {
  /** 最多重启几次（之外的崩溃视为不可恢复，UI 要显示"桥已停止"）。 */
  readonly maxRestarts: number;
  /** 退避基数，实际等待 = base * 2^(n-1)，上限 maxBackoffMs。 */
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export interface BridgeProcessOptions {
  /** jlink 运行时自带的 java 可执行文件；缺省用 PATH 里的 java。 */
  readonly javaCommand?: string;
  /** 类路径（`…/lib/*` 或 jlink 的模块路径）。 */
  readonly classpath: string;
  readonly mainClass: string;
  readonly backendUrl: string;
  readonly version: string;
  /** 额外透传给宿主的参数（例如 `--capabilities`）。 */
  readonly extraArgs?: readonly string[];
  readonly handshakeTimeoutMs?: number;
  readonly restart?: Partial<RestartPolicy>;
  /** jlink 运行时的额外 JVM 参数（启动优化写在这里，不写死在宿主里）。 */
  readonly jvmArgs?: readonly string[];
}

export type BridgeProcessState = 'idle' | 'starting' | 'running' | 'restarting' | 'stopped' | 'failed';

const DEFAULT_RESTART: RestartPolicy = { maxRestarts: 3, baseBackoffMs: 400, maxBackoffMs: 5_000 };
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;

export class BridgeProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private currentState: BridgeProcessState = 'idle';
  private handshake: BridgeHandshake | null = null;
  private restarts = 0;
  /** 主动停止的标志：用来区分"崩溃"与"我们让它退出的"。 */
  private stopping = false;

  constructor(private readonly options: BridgeProcessOptions) {
    super();
  }

  get state(): BridgeProcessState {
    return this.currentState;
  }

  get lastHandshake(): BridgeHandshake | null {
    return this.handshake;
  }

  /** 启动并等到握手完成。失败抛异常（调用方决定是显示错误还是重试）。 */
  async start(): Promise<BridgeHandshake> {
    if (this.currentState === 'running') {
      return this.handshake!;
    }
    this.stopping = false;
    return await this.spawnOnce();
  }

  /** 优雅停止：先请它自己退，超时再强杀。返回退出码（或 null）。 */
  async stop(graceMs = 2_000): Promise<number | null> {
    this.stopping = true;
    this.setState('stopped');
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return child?.exitCode ?? null;
    }
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    try {
      child.stdin.write('shutdown\n');
    } catch {
      // stdin 可能已经关了，直接走强杀路径
    }
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), graceMs));
    const result = await Promise.race([exited, timeout]);
    if (result === 'timeout') {
      child.kill();
      return await exited;
    }
    return result;
  }

  // ------------------------------------------------------------ 内部

  private setState(s: BridgeProcessState): void {
    if (this.currentState === s) {
      return;
    }
    this.currentState = s;
    this.emit('state', s);
  }

  private spawnOnce(): Promise<BridgeHandshake> {
    this.setState('starting');
    const { javaCommand = 'java', classpath, mainClass, backendUrl, version, extraArgs = [], jvmArgs = [] } = this.options;
    const args = [
      ...jvmArgs,
      '-cp',
      classpath,
      mainClass,
      '--backend',
      backendUrl,
      '--ver',
      version,
      // 能力表由**宿主**声明，而不是让桥猜一个默认值 ——
      // 声明错了 UI 就会画出永远不工作的入口（见 BridgeCapabilities.common 的注释）。
      '--capabilities',
      'storage.secure,scan.gun.keyboard',
      ...extraArgs,
    ];

    const child = spawn(javaCommand, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      this.emit('log', d.toString());
    });

    return new Promise<BridgeHandshake>((resolve, reject) => {
      let buffer = '';
      const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`桥握手超时（${timeoutMs}ms）\n${stderr.slice(-800)}`));
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        if (this.handshake) {
          return;
        }
        buffer += d.toString();
        const line = buffer.split('\n').find((l) => l.trim().startsWith('{'));
        if (!line) {
          return;
        }
        try {
          const hs = JSON.parse(line) as BridgeHandshake;
          this.handshake = hs;
          this.restarts = 0;
          clearTimeout(timer);
          this.setState('running');
          this.emit('ready', hs);
          resolve(hs);
        } catch (e) {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`握手不是合法 JSON：${line.slice(0, 200)}`));
        }
      });

      child.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`无法启动桥进程：${e.message}`));
      });

      child.once('exit', (code, signal) => {
        this.child = null;
        this.handshake = null;
        if (this.stopping) {
          this.emit('exit', { code, signal, intentional: true });
          return;
        }
        this.emit('exit', { code, signal, intentional: false });
        void this.handleCrash(code, signal, stderr, resolve, reject, timer);
      });
    });
  }

  /** 崩溃后的退避重启；超过次数就进入 failed（UI 应显示"桥已停止"并提供手动重开）。 */
  private async handleCrash(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
    resolve: (hs: BridgeHandshake) => void,
    reject: (e: Error) => void,
    pendingTimer: NodeJS.Timeout,
  ): Promise<void> {
    const policy = { ...DEFAULT_RESTART, ...this.options.restart };
    this.restarts += 1;

    if (this.restarts > policy.maxRestarts) {
      clearTimeout(pendingTimer);
      this.setState('failed');
      reject(new Error(`桥进程连续退出 ${this.restarts} 次（最后一次 code=${code} signal=${signal}）\n${stderr.slice(-800)}`));
      return;
    }

    this.setState('restarting');
    const wait = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** (this.restarts - 1));
    await new Promise((r) => setTimeout(r, wait));
    if (this.stopping) {
      return;
    }

    try {
      const hs = await this.spawnOnce();
      resolve(hs);
    } catch (e) {
      reject(e as Error);
    }
  }
}
