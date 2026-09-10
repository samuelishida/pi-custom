#!/usr/bin/env node
"use strict";

// pi-research-skills installer
// Copies tool-agnostic skills and agents into Claude Code, Codex, or pi.
//
// Usage:
//   pi-research-install                 # auto-detect or install to all
//   pi-research-install --claude        # install to ~/.claude
//   pi-research-install --codex         # install to ~/.codex
//   pi-research-install --pi            # install to ~/.pi/agent
//   pi-research-install --all           # install to all three
//   pi-research-install --dry-run       # show what would be copied
//   pi-research-install --uninstall     # remove installed files

const fs = require("fs");
const path = require("path");
const os = require("os");

const PKG_ROOT = path.resolve(__dirname, "..");

// Target agent layouts. Each maps a source dir to a destination dir.
const TARGETS = {
  claude: {
    label: "Claude Code",
    home: path.join(os.homedir(), ".claude"),
    skills: path.join(os.homedir(), ".claude", "skills"),
    agents: path.join(os.homedir(), ".claude", "agents"),
  },
  codex: {
    label: "Codex",
    home: path.join(os.homedir(), ".codex"),
    skills: path.join(os.homedir(), ".codex", "skills"),
    agents: path.join(os.homedir(), ".codex", "agents"),
  },
  pi: {
    label: "pi",
    home: process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
    skills: path.join(
      process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
      "skills"
    ),
    agents: path.join(
      process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
      "agents"
    ),
  },
};

const SKILLS = ["autoresearch", "deep-research"];
const AGENTS = [
  "researcher",
  "verifier",
  "reviewer",
  "audit-architecture",
  "audit-logic",
  "audit-research",
  "audit-security",
  "audit-simplification",
  "audit-triage",
  "plan-reviewer",
];

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
  for (const agent of AGENTS) {
    const dest = path.join(t.agents, agent + ".md");
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true });
      log(`  removed agent ${agent}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");

  const requested = [];
  if (args.includes("--claude")) requested.push("claude");
  if (args.includes("--codex")) requested.push("codex");
  if (args.includes("--pi")) requested.push("pi");
  if (args.includes("--all")) requested.push("claude", "codex", "pi");

  // Auto-detect: install to whichever target dirs exist.
  const targets = requested.length
    ? requested
    : Object.keys(TARGETS).filter((k) => fs.existsSync(TARGETS[k].home));

  if (!targets.length) {
    log("No target agent directories found. Use --claude, --codex, --pi, or --all.");
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
