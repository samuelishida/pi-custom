// ============================================================
// Permission — RPC/limited-UI approval dialog (pure logic, zero pi imports).
//
// pi RPC mode (obsidian-pi & other embedding clients) exposes the extension
// UI protocol (select/confirm/input/notify) but not the TUI-only
// ctx.ui.custom that the full approval dialog renders through. Without this
// fallback every `ask` verdict in manual mode silently degrades to deny
// ("User denied: <policy>") and the user never sees a prompt.
//
// Mirrors the TUI flow over the extension UI primitives: three-way ask
// (once/always/deny) with an optional deny reason; cancelling the reason
// input returns to the options. select() itself failing (older host)
// degrades to a boolean confirm, and that failing degrades to a fail-safe
// deny.
// ============================================================

import type { ApprovalDialogResult } from './index.ts';

/** Minimal extension UI surface the fallback needs (subset of pi's
 * ExtensionUIContext — the full ctx type isn't part of the peer dep's
 * public API; see pi packages/coding-agent/src/core/extensions/types.ts). */
export interface ApprovalDialogCtx {
  mode?: string;
  signal?: AbortSignal;
  ui?: {
    select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
    confirm?: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
    input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  };
}

/**
 * Approval dialog for hosts without ctx.ui.custom (pi RPC mode). `title`
 * may already carry a composed prompt (e.g. the tool action title).
 */
export async function approvalViaRpcUi(
  dialogCtx: ApprovalDialogCtx,
  toolName: string,
  title: string,
  message: string,
): Promise<ApprovalDialogResult> {
  const ui = dialogCtx?.ui;
  const prompt = `${title}: ${message}`;

  // select() unavailable → boolean confirm as a last resort
  if (!ui || typeof ui.select !== 'function') {
    try {
      const ok = ui && typeof ui.confirm === 'function'
        ? await ui.confirm(prompt, `Tool: ${toolName}`, { signal: dialogCtx?.signal })
        : false;
      return ok ? { decision: 'once' } : { decision: 'deny' };
    } catch {
      return { decision: 'deny' };
    }
  }

  const options = [
    'Allow once',
    'Always allow (this session)',
    'Deny',
    'Deny with reason',
  ];
  while (true) {
    let choice: string | undefined;
    try {
      choice = await ui.select(prompt, options, { signal: dialogCtx?.signal });
    } catch {
      // select threw (host-side failure) — fail-safe deny
      return { decision: 'deny' };
    }
    if (choice === 'Allow once') return { decision: 'once' };
    if (choice === 'Always allow (this session)') return { decision: 'always' };
    if (choice === 'Deny with reason') {
      let reason: string | undefined;
      try {
        reason = (await ui.input?.('Reason for denying (optional)', "e.g. don't force-push to main", { signal: dialogCtx?.signal })) || undefined;
      } catch {
        // host input failure — fail-safe deny instead of re-asking forever
        return { decision: 'deny' };
      }
      if (reason === undefined) continue; // cancelled input → back to the options
      return { decision: 'deny', reason };
    }
    // undefined (cancelled) or "Deny" → deny
    return { decision: 'deny' };
  }
}
