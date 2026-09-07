// ============================================================
// Tool Builder — builds pi SDK Tool arrays from profile definitions
//
// Maps ProfileToolName to the corresponding pi SDK tool creation
// function. For tools without a pi SDK factory (webSearch,
// fetchURL, etc.), creates lightweight inline ToolDefinitions.
// ============================================================

import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import type { ProfileToolName, SubAgentProfile } from "./types.ts";

// ── Create a single SDK tool from a ProfileToolName ──────────────────

function createOneTool(toolName: ProfileToolName, cwd: string): any {
  switch (toolName) {
    case "read":  return createReadTool(cwd);
    case "bash":  return createBashTool(cwd);
    case "edit":  return createEditTool(cwd);
    case "write": return createWriteTool(cwd);
    case "grep":  return createGrepTool(cwd);
    case "find":  return createFindTool(cwd);
    case "ls":    return createLsTool(cwd);
    default:      return undefined;
  }
}

// ── Build tools from profile ───────────────────────────────────────────

/**
 * Build the tool array for a subagent session from its profile.
 *
 * Built-in SDK tools (read, bash, edit, write, grep, find, ls) are
 * created via the individual `createXxxTool()` functions.
 * Web-search and other extension-hosted tools are skipped — they
 * require extension registration through the resource loader.
 */
export function buildProfileTools(profile: SubAgentProfile, cwd: string): any[] {
  const tools: any[] = [];
  for (const toolName of profile.tools) {
    if (isExtensionTool(toolName)) continue;
    const tool = createOneTool(toolName, cwd);
    if (tool) tools.push(tool);
  }
  return tools;
}

/**
 * Returns true for tool names that are not standalone SDK tools but
 * are provided by pi extensions registered through the resource loader.
 *
 * These become available in the subagent session when the resource
 * loader's getExtensions() includes them. Currently the subagent RL
 * returns no extensions, so these are intentionally omitted.
 */
function isExtensionTool(name: ProfileToolName): boolean {
  switch (name) {
    case "webSearch":
    case "fetchURL":
    case "sourceCheck":
    case "getSearchContent":
    case "readMediaFile":
    case "taskList":
    case "taskOutput":
    case "taskStop":
    case "cronCreate":
    case "cronDelete":
    case "cronList":
    case "todoList":
    case "enterPlanMode":
    case "exitPlanMode":
    case "createGoal":
    case "getGoal":
    case "updateGoal":
    case "setGoalBudget":
    case "askUserQuestion":
    case "skill":
    case "agent":
    case "agentSwarm":
    case "mcp__*":
      return true;
    default:
      return false;
  }
}

/** Get profile role additional prompt text. */
export function getProfilePrompt(profile: SubAgentProfile): string {
  return profile.roleAdditional;
}

/** Format profile tool list for display. */
export function formatProfileTools(profile: SubAgentProfile): string {
  return profile.tools.join(", ");
}
