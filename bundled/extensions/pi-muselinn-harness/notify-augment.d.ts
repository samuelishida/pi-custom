/**
 * pi 0.83 type gap: `ExtensionUIContext.notify` only declares
 * "info" | "warning" | "error", but the runtime (interactive-mode
 * showExtensionNotify) special-cases only "error"/"warning" and routes
 * every other level — including "success" — through the default status
 * path. The harness uses "success" to convey completion; add the
 * overload so those call sites typecheck without lying about the level.
 */
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionUIContext {
    notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
  }
}

// File must be a module (not ambient script) so `declare module` MERGES
// with the real package types instead of replacing them.
export {};

