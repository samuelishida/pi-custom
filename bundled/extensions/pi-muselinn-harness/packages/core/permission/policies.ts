// ============================================================
// 18-Level Policy Chain — Kimi Code-style permission policies
// ============================================================

import type { Policy, PolicyContext, PolicyResult } from './types.ts';
import { READ_ONLY_TOOLS, SENSITIVE_PATTERNS, GIT_CONTROL_PATTERNS, sessionApprovals } from './types.ts';
import { loadUserConfig, matchesPattern } from './config.ts';
import * as path from 'node:path';

// Destructive bash command patterns — these always require an explicit ask
// and are never short-circuited by session approval history.
const DESTRUCTIVE_BASH_RE =
  /(rm\s+-rf|--force|--no-verify|git\s+push\b[^\n]*--force|drop\s+(table|database)|truncate\b|git\s+reset\s+--hard|git\s+clean\s+-fd)/i;

/**
 * Detect destructive operations:
 *  - bash commands containing rm -rf / --force / git push --force / drop table / truncate / git reset --hard / git clean -fd etc.
 *  - edit/write targeting sensitive files (.env, id_rsa, *.key, ...)
 */
export function isDestructive(ctx: PolicyContext): boolean {
  const tool = ctx.toolName;
  if (tool === 'bash') {
    const command = typeof ctx.input.command === 'string' ? ctx.input.command : '';
    if (command && DESTRUCTIVE_BASH_RE.test(command)) return true;
    return false;
  }
  if (tool === 'edit' || tool === 'write') {
    const filePath = (ctx.input.path as string) || (ctx.input.file_path as string) || '';
    if (!filePath) return false;
    const resolved = path.resolve(ctx.cwd, filePath);
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(resolved) || pattern.test(filePath)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Compute a per-input fingerprint used for session-approval short-circuit.
 * Format: `${toolName}:${command[0..200] || JSON(input).slice(0,200)}`.
 * Same fingerprint => same logical action may be auto-approved within a session.
 */
export function inputFingerprint(toolName: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command.slice(0, 200) : '';
  if (command) return `${toolName}:${command}`;
  return `${toolName}:${JSON.stringify(input).slice(0, 200)}`;
}

// ── 01: agent-swarm-exclusive-deny ──────────────────────────────────────
// Swarm 约束：swarm 模式下只允许 swarm 相关工具
export const policy01SwarmDeny: Policy = {
  id: 1,
  name: 'agent-swarm-exclusive-deny',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    // In swarm mode, block tools that conflict with swarm execution
    // (This is a placeholder — actual swarm constraints depend on module state)
    return null;
  },
};

// ── 02: auto-mode-ask-user-question-deny ────────────────────────────────
// auto 模式禁用 ask_user_question
export const policy02AutoAskDeny: Policy = {
  id: 2,
  name: 'auto-mode-ask-user-question-deny',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (ctx.mode !== 'auto') return null;
    if (ctx.toolName === 'ask_user_question') {
      return { kind: 'deny', reason: 'AskUserQuestion is disabled in auto mode' };
    }
    return null;
  },
};

// ── 03: plan-mode-guard-deny ────────────────────────────────────────────
// plan 模式只允许只读工具 + plan 文件
export const policy03PlanGuard: Policy = {
  id: 3,
  name: 'plan-mode-guard-deny',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    // Plan mode check is handled by plan module's shouldBlockTool
    // This policy is a pass-through — actual logic in plan/index.ts
    return null;
  },
};

// ── 04: user-configured-deny ────────────────────────────────────────────
// 用户自定义 deny 规则
export const policy04UserDeny: Policy = {
  id: 4,
  name: 'user-configured-deny',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    const config = loadUserConfig(ctx.cwd);
    for (const pattern of config.deny) {
      if (matchesPattern(pattern, ctx.toolName, ctx.input, ctx.cwd)) {
        return { kind: 'deny', reason: `Blocked by permissions.deny: ${pattern.raw}` };
      }
    }
    return null;
  },
};

// ── 04b: destructive-command-ask ────────────────────────────────────────
// 破坏性命令（rm -rf / --force / git push --force / drop table / truncate /
// git reset --hard / git clean -fd，以及写敏感文件）在 auto/manual 下每次都要
// 重新裁定，不被 sessionApprovals 短路。必须排在 auto-approve / session-history
// 之前，保证破坏性命令无法被静默批准。
//
// True YOLO: yolo 模式完全退出这条内建护栏 —— approve 裁决由 yolo-mode-approve
// (#14) 给出，破坏性操作不再弹窗。AGENTS.md 的 `destructive-ask-always` 是用户
// 自己写下的策略而非内建护栏，因此在任何模式下依然生效。
export const policy04bDestructiveAsk: Policy = {
  id: 41,
  name: 'destructive-command-ask',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (!isDestructive(ctx)) return null;
    // AGENTS.md override: if 'destructive-ask-always' is present, upgrade ask -> deny.
    if (ctx.agentsMd?.includes('destructive-ask-always')) {
      return {
        kind: 'deny',
        reason: 'AGENTS.md directive "destructive-ask-always" forbids destructive actions',
      };
    }
    // True YOLO: destructive operations are approved without any dialog.
    if (ctx.mode === 'yolo') return null;
    return {
      kind: 'ask',
      message: `Destructive action detected (${ctx.toolName}).\n\nThis operation is irreversible or touches sensitive data and requires explicit approval every time. Allow?`,
    };
  },
};

// ── 05: auto-mode-approve ───────────────────────────────────────────────
// auto 模式：批准一切（短路；因此在 auto 下破坏性/敏感文件/.git 护栏不会执行）
export const policy05AutoApprove: Policy = {
  id: 5,
  name: 'auto-mode-approve',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (ctx.mode === 'auto') {
      return { kind: 'approve', reason: 'Auto mode: auto-approved' };
    }
    return null;
  },
};

// ── 06: session-approval-history ────────────────────────────────────────
// 会话中已批准过的操作（按输入指纹记录，避免一次性永久许可）
export const policy06SessionHistory: Policy = {
  id: 6,
  name: 'session-approval-history',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    // Destructive commands are never short-circuited by session history.
    if (isDestructive(ctx)) return null;
    const sessionId = ctx.sessionId || 'default';
    const approvals = sessionApprovals.get(sessionId);
    if (!approvals) return null;
    const fp = inputFingerprint(ctx.toolName, ctx.input);
    if (approvals.has(fp)) {
      return { kind: 'approve', reason: 'Previously approved in this session' };
    }
    return null;
  },
};

// ── 07: user-configured-ask ─────────────────────────────────────────────
// 用户自定义 ask 规则。True YOLO 下不再询问：yolo 的契约就是"不弹窗"，
// 配置的 ask 规则在 yolo 下等同于预先回答"允许"。deny 规则照旧拦截（快速失败，
// 不是等待输入），所以不会静默放过用户明确禁止的操作。
export const policy07UserAsk: Policy = {
  id: 7,
  name: 'user-configured-ask',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    // True YOLO: a prompt here would stall an unattended run. deny still blocks.
    if (ctx.mode === 'yolo') return null;

    const config = loadUserConfig(ctx.cwd);
    for (const pattern of config.ask) {
      if (matchesPattern(pattern, ctx.toolName, ctx.input, ctx.cwd)) {
        return {
          kind: 'ask',
          message: `Rule: ${pattern.raw}\n\nAction: ${ctx.toolName}\n\nAllow this action?`,
        };
      }
    }
    return null;
  },
};

// ── 08: user-configured-allow ───────────────────────────────────────────
// 用户自定义 allow 规则
export const policy08UserAllow: Policy = {
  id: 8,
  name: 'user-configured-allow',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    const config = loadUserConfig(ctx.cwd);
    for (const pattern of config.allow) {
      if (matchesPattern(pattern, ctx.toolName, ctx.input, ctx.cwd)) {
        return { kind: 'approve', reason: `Allowed by permissions.allow: ${pattern.raw}` };
      }
    }
    return null;
  },
};

// ── 09: exit-plan-mode-review-ask ───────────────────────────────────────
// plan 模式退出审查
export const policy09ExitPlanReview: Policy = {
  id: 9,
  name: 'exit-plan-mode-review-ask',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    // Handled by exit_plan_mode tool's own confirm dialog
    return null;
  },
};

// ── 10: goal-start-review-ask ───────────────────────────────────────────
// goal 创建时模式切换审查
export const policy10GoalStartReview: Policy = {
  id: 10,
  name: 'goal-start-review-ask',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    // When create_goal is called, check if mode should switch
    if (ctx.toolName === 'create_goal' && ctx.mode === 'auto') {
      return {
        kind: 'ask',
        message: 'Creating a goal in auto mode. Switch to manual mode for goal tracking?',
      };
    }
    return null;
  },
};

// ── 11: plan-mode-tool-approve ──────────────────────────────────────────
// plan 模式允许的工具
export const policy11PlanToolApprove: Policy = {
  id: 11,
  name: 'plan-mode-tool-approve',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    // Handled by plan module's shouldBlockTool
    return null;
  },
};

// ── 12: sensitive-file-access-ask ───────────────────────────────────────
// 敏感文件路径（.env 等）。True YOLO 下不再询问。
export const policy12SensitiveFile: Policy = {
  id: 12,
  name: 'sensitive-file-access-ask',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (ctx.toolName !== 'write' && ctx.toolName !== 'edit' && ctx.toolName !== 'bash' && ctx.toolName !== 'read') return null;

    // True YOLO: no sensitive-file dialog.
    if (ctx.mode === 'yolo') return null;

    const filePath = (ctx.input.path as string) || (ctx.input.file_path as string) || '';
    if (!filePath) return null;
    const resolved = path.resolve(ctx.cwd, filePath);
    
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(resolved) || pattern.test(filePath)) {
        return {
          kind: 'ask',
          message: `Sensitive file detected: ${filePath}\n\nThis file may contain secrets. Allow access?`,
        };
      }
    }
    return null;
  },
};

// ── 13: git-control-path-access-ask ─────────────────────────────────────
// .git 目录访问。True YOLO 下不再询问。
export const policy13GitControl: Policy = {
  id: 13,
  name: 'git-control-path-access-ask',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (ctx.toolName !== 'write' && ctx.toolName !== 'edit' && ctx.toolName !== 'bash') return null;

    // True YOLO: no .git dialog.
    if (ctx.mode === 'yolo') return null;

    const filePath = (ctx.input.path as string) || (ctx.input.file_path as string) || '';
    if (!filePath) return null;
    const resolved = path.resolve(ctx.cwd, filePath);
    
    for (const pattern of GIT_CONTROL_PATTERNS) {
      if (pattern.test(resolved) || pattern.test(filePath)) {
        return {
          kind: 'ask',
          message: `Git control path detected: ${filePath}\n\nAllow access to .git directory?`,
        };
      }
    }
    return null;
  },
};

// ── 14: yolo-mode-approve ───────────────────────────────────────────────
// yolo 模式：批准一切。True yolo —— 内建安全护栏（破坏性命令、敏感文件、
// .git 路径）在 yolo 下直接让路，因此这里就是最终裁决。
// 仍然优先于它的只有显式用户策略：permissions.json 的 deny/ask 规则、
// tool policy 禁用，以及 AGENTS.md 的 destructive-ask-always。
export const policy14YoloApprove: Policy = {
  id: 14,
  name: 'yolo-mode-approve',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (ctx.mode === 'yolo') {
      return { kind: 'approve', reason: 'Yolo mode: true yolo, approved unconditionally' };
    }
    return null;
  },
};

// ── 15: swarm-mode-agent-swarm-approve ──────────────────────────────────
// swarm 工具批准
export const policy15SwarmApprove: Policy = {
  id: 15,
  name: 'swarm-mode-agent-swarm-approve',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (ctx.toolName === 'agent_swarm' || ctx.toolName === 'agent') {
      return { kind: 'approve', reason: 'Swarm tool approved' };
    }
    return null;
  },
};

// ── 16: default-tool-approve ────────────────────────────────────────────
// 只读/安全工具（Read, Grep, WebSearch...）
export const policy16DefaultApprove: Policy = {
  id: 16,
  name: 'default-tool-approve',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (READ_ONLY_TOOLS.has(ctx.toolName)) {
      return { kind: 'approve', reason: `Read-only tool: ${ctx.toolName}` };
    }
    return null;
  },
};

// ── 17: git-cwd-write-approve ───────────────────────────────────────────
// 工作区内 git 写操作
export const policy17GitCwdWrite: Policy = {
  id: 17,
  name: 'git-cwd-write-approve',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    if (ctx.toolName !== 'bash') return null;
    const command = (ctx.input.command as string) || '';
    if (/git\s+(add|commit|push|pull|merge|rebase|checkout|stash)/i.test(command)) {
      return { kind: 'approve', reason: 'Git command in working directory' };
    }
    return null;
  },
};

// ── 18: fallback-ask ────────────────────────────────────────────────────
// 兜底：始终弹出审批面板
export const policy18FallbackAsk: Policy = {
  id: 18,
  name: 'fallback-ask',
  evaluate(ctx: PolicyContext): PolicyResult | null {
    return {
      kind: 'ask',
      message: `Tool: ${ctx.toolName}\n\nAction requires approval. Allow?`,
    };
  },
};

// ── Policy Chain ─────────────────────────────────────────────────────────
// Array order == evaluation order.
//
// AUTO mode:  AskUserQuestion denied (#2) → UserDeny (#4) → AutoApprove (#5).
//             AutoApprove fires BEFORE destructive/sensitive/git safety checks,
//             so auto mode is truly automatic — no dialogs. User-configured
//             deny rules are still respected.
//
// YOLO mode:  TRUE YOLO. Nothing in this chain can produce an `ask` verdict,
//             so no tool call can ever wait on a human. The safety policies
//             (#41 destructive, #12 sensitive file, #13 .git control) and the
//             user ask rules (#7) opt out when mode === 'yolo', leaving
//             YoloApprove (#14) to approve every call.
//             AskUserQuestion is allowed (unlike auto).
//             Only fail-fast verdicts survive: permissions.json `deny` rules,
//             tool-policy disabling, and the AGENTS.md `destructive-ask-always`
//             directive all still block loudly instead of stalling.
//
// MANUAL mode: Runs through the entire chain; fallback-ask catches anything
//              not explicitly allowed or denied.
export const policyChain: Policy[] = [
  policy01SwarmDeny,
  policy02AutoAskDeny,
  policy03PlanGuard,
  policy04UserDeny,
  // AutoApprove fires early — auto mode is fully automatic
  policy05AutoApprove,
  // Safety checks — skipped entirely in yolo mode (true yolo)
  policy04bDestructiveAsk,
  policy12SensitiveFile,
  policy13GitControl,
  // Session and user policies
  policy06SessionHistory,
  policy07UserAsk,
  policy08UserAllow,
  policy09ExitPlanReview,
  policy10GoalStartReview,
  policy11PlanToolApprove,
  // YoloApprove is now the final verdict for yolo mode
  policy14YoloApprove,
  policy15SwarmApprove,
  policy16DefaultApprove,
  policy17GitCwdWrite,
  policy18FallbackAsk,
];
