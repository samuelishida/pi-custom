#!/usr/bin/env node
"use strict";

// research-skills installer
// Copies tool-agnostic skills and agents into supported AI coding tools:
// Claude Code, Codex, pi, Cline, Roo Code, Windsurf, Cursor, and Copilot.
//
// Usage:
//   research-install                  # auto-detect or install to all found
//   research-install --claude         # install to ~/.claude
//   research-install --codex          # install to ~/.codex
//   research-install --pi             # install to ~/.pi/agent
//   research-install --cline          # install to ~/.cline
//   research-install --roo            # install to ~/.roo
//   research-install --windsurf       # install to ~/.codeium/windsurf
//   research-install --cursor         # install to ~/.cursor
//   research-install --copilot        # install to ~/.github/prompts
//   research-install --all            # install to all supported tools
//   research-install --dry-run        # show what would be copied
//   research-install --uninstall      # remove installed files

const fs = require("fs");
const path = require("path");
const os = require("os");

const PKG_ROOT = path.resolve(__dirname, "..");
const HOME = os.homedir();

const piHome = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(HOME, ".pi", "agent");

// Target tool layouts. Some tools read skills from a skills/ dir; others only
// support flat markdown. "agents" is null when the tool does not use agent
// files (or does not read them from that location), so agents are skipped.
const TARGETS = {
  claude: {
    label: "Claude Code",
    home: path.join(HOME, ".claude"),
    skills: path.join(HOME, ".claude", "skills"),
    agents: path.join(HOME, ".claude", "agents"),
    autoDetectHome: path.join(HOME, ".claude"),
  },
  codex: {
    label: "Codex",
    home: path.join(HOME, ".codex"),
    skills: path.join(HOME, ".codex", "skills"),
    agents: path.join(HOME, ".codex", "agents"),
    autoDetectHome: path.join(HOME, ".codex"),
  },
  pi: {
    label: "pi",
    home: piHome,
    skills: path.join(piHome, "skills"),
    agents: path.join(piHome, "agents"),
    autoDetectHome: piHome,
  },
  cline: {
    label: "Cline",
    home: path.join(HOME, ".cline"),
    skills: path.join(HOME, ".cline", "skills"),
    agents: null,
    autoDetectHome: path.join(HOME, ".cline"),
  },
  roo: {
    label: "Roo Code",
    home: path.join(HOME, ".roo"),
    skills: path.join(HOME, ".roo", "skills"),
    agents: null,
    autoDetectHome: path.join(HOME, ".roo"),
  },
  windsurf: {
    label: "Windsurf",
    home: path.join(HOME, ".codeium", "windsurf"),
    skills: path.join(HOME, ".codeium", "windsurf", "skills"),
    agents: null,
    autoDetectHome: path.join(HOME, ".codeium", "windsurf"),
  },
  cursor: {
    label: "Cursor",
    home: path.join(HOME, ".cursor"),
    skills: path.join(HOME, ".cursor", "skills"),
    agents: path.join(HOME, ".cursor", "agents"),
    autoDetectHome: path.join(HOME, ".cursor"),
  },
  copilot: {
    label: "Copilot",
    home: path.join(HOME, ".github", "prompts"),
    skills: path.join(HOME, ".github", "prompts"),
    agents: null,
    autoDetectHome: path.join(HOME, ".github", "prompts"),
  },
};

// Ordered list of tool keys used for --all and auto-detect.
const TOOL_ORDER = Object.keys(TARGETS);

const SKILLS = ["autoresearch", "deep-research"];
const AGENTS = ["researcher", "verifier", "reviewer"];

function log(msg) {
  console.log(msg);
}

function warn(msg) {
  console.error("warning: " + msg);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function backupExisting(dest) {
  if (!fs.existsSync(dest)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = dest + ".bak-" + stamp;
  fs.copyFileSync(dest, backup);
  return backup;
}

function installTarget(name, dryRun) {
  const t = TARGETS[name];
  if (!t) return;
  log(`\n[${t.label}] -> ${t.home}`);

  let copied = 0;
  for (const skill of SKILLS) {
    const src = path.join(PKG_ROOT, "skills", skill, "SKILL.md");
    const dest = path.join(t.skills, skill, "SKILL.md");
    if (!fs.existsSync(src)) {
      warn(`missing source ${src}`);
      continue;
    }
    if (dryRun) {
      log(`  would copy skill ${skill} -> ${dest}`);
    } else {
      backupExisting(dest);
      copyFile(src, dest);
      log(`  skill ${skill} -> ${dest}`);
    }
    copied++;
  }

  if (t.agents) {
    for (const agent of AGENTS) {
      const src = path.join(PKG_ROOT, "agents", agent + ".md");
      const dest = path.join(t.agents, agent + ".md");
      if (!fs.existsSync(src)) {
        warn(`missing source ${src}`);
        continue;
      }
      if (dryRun) {
        log(`  would copy agent ${agent} -> ${dest}`);
      } else {
        backupExisting(dest);
        copyFile(src, dest);
        log(`  agent ${agent} -> ${dest}`);
      }
      copied++;
    }
  }

  return copied;
}

function uninstallTarget(name) {
  const t = TARGETS[name];
  if (!t) return;
  log(`\n[${t.label}] removing installed files`);

  for (const skill of SKILLS) {
    const dest = path.join(t.skills, skill, "SKILL.md");
    if (fs.existsSync(dest)) {
      fs.rmSync(path.dirname(dest), { recursive: true, force: true });
      log(`  removed skill ${skill}`);
    }
  }
  if (t.agents) {
    for (const agent of AGENTS) {
      const dest = path.join(t.agents, agent + ".md");
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { force: true });
        log(`  removed agent ${agent}`);
      }
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");

  const requested = [];
  for (const key of TOOL_ORDER) {
    if (args.includes("--" + key)) requested.push(key);
  }
  if (args.includes("--all")) requested.push(...TOOL_ORDER);

  // Auto-detect: install to whichever target dirs exist.
  const targets = requested.length
    ? requested
    : TOOL_ORDER.filter((k) => fs.existsSync(TARGETS[k].autoDetectHome));

  if (!targets.length) {
    log("No supported tool directories found. Use --claude, --codex, --pi, --cline, --roo, --windsurf, --cursor, --copilot, or --all.");
    process.exit(1);
  }

  if (uninstall) {
    for (const t of targets) uninstallTarget(t);
    log("\nUninstall complete.");
    return;
  }

  for (const t of targets) installTarget(t, dryRun);
  log("\nDone. Restart your agent session to pick up the new skills and agents.");
}

main();
