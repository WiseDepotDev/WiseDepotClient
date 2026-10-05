import { app } from 'electron';

/**
 * 桌面壳的**本地环境证据**（人机验证用）。
 *
 * ## 它是什么
 *
 * 桥会通过 stdout 发一条 `evidence-request`，主进程用这个函数回答。这些是
 * **只有 Electron 主进程看得见**的事实：页面里既没有 `app.isPackaged`，也看不到启动开关。
 *
 * ## 它不是什么（重要）
 *
 * 这些字段**不是结论**。它们全部可以由本机上的攻击者伪造（改客户端、改启动参数），
 * 所以服务端可以完全不采信 —— 放行判据只能是"服务端票据 + 风险规则 + 计算量证明"
 * （见 `docs/superpowers/plans/2026-10-07-human-verification.md` §3）。
 * 它们的作用只有两个：让服务端把难度调高、给审计留线索。
 *
 * ## 为什么只回两个字段
 *
 * `shellPackaged`：是不是我们打包发布的产物（开发态 `electron .` 是 false）。
 * `debugAttached`：启动参数里有没有开远程调试/检查端口 —— 那是自动化脚本最常用的入口。
 *
 * 刻意**不回**可执行文件路径、用户名、机器名这类机器身份信息：证据只上传"环境与交互的统计量"，
 * 不做跨会话画像（同一条纪律写在方案的 §6 隐私边界里）。
 */
export function desktopEvidence(): Record<string, unknown> {
  try {
    return {
      shellPackaged: app.isPackaged,
      debugAttached: hasDebugSwitch(),
    };
  } catch (e) {
    // 读不到就**什么都不回**（而不是回 false）：写 false 与"不知道"是两件事，
    // 服务端据此判 R5，把"没读出来"说成"环境干净"是在帮攻击者。
    return { evidenceError: String(e instanceof Error ? e.message : e) };
  }
}

/** 启动参数里有没有调试/自动化相关的开关（Electron 的开关既在 argv 也在 commandLine 里）。 */
function hasDebugSwitch(): boolean {
  const switches = ['remote-debugging-port', 'inspect', 'inspect-brk', 'remote-debugging-pipe'];
  if (switches.some((name) => app.commandLine.hasSwitch(name))) {
    return true;
  }
  // `process.argv` 兜底：某些启动方式（例如直接塞进 argv 而不走 Chromium 解析）只在 argv 里
  return process.argv.some((arg) => switches.some((name) => arg.startsWith(`--${name}`)));
}
