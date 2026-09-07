#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AGENT_DIR=$(mktemp -d /tmp/pi-e2e-agent.XXXXXX)
WORK_DIR=$(mktemp -d /tmp/pi-e2e-work.XXXXXX)
trap 'rm -rf "$AGENT_DIR" "$WORK_DIR"' EXIT

PI_CODING_AGENT_DIR="$AGENT_DIR" bash "$ROOT_DIR/scripts/preinstall-bundle.sh" > "$ROOT_DIR/.e2e-preinstall.log" 2>&1

cd "$WORK_DIR"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
"$HOME/.local/bin/pi-custom" --help > "$ROOT_DIR/.e2e-startup.log" 2>&1
if rg -n -i 'failed to load extension|extension load error|uncaught exception' "$ROOT_DIR/.e2e-startup.log"; then
	echo "pi-custom startup reported extension failure" >&2
	exit 1
fi

ROOT_DIR="$ROOT_DIR" node --input-type=module - <<'NODE'
import { existsSync, lstatSync, readFileSync } from "node:fs";
const { DefaultResourceLoader, getAgentDir } = await import(`${process.env.ROOT_DIR}/packages/coding-agent/dist/index.js`);

const expectedExtensions = [
	"browser/index.ts", "custom-header.ts",
	"guardrail.ts", "pi-dictate/src/index.ts", "pi-interactive-subagents/pi-extension/subagents/index.ts",
	"pi-observational-memory/src/index.ts", "pi-undo-redo/src/extension.ts", "prompt-snippets/index.ts",
	"pi-diff/dist/index.js", "web-fetch/index.ts", "web-search/index.ts",
	"pi-mcp-adapter/index.ts", "pi-hermes-memory/src/index.ts",
	"pi-background-tasks/extensions/background-tasks.ts", "pi-muselinn-harness/index.ts",
];
const expectedSkills = [
	"autoresearch", "cap", "code-audit", "code-audit-hardcore", "coding-process", "compound",
	"deep-research", "design-master", "fix-bug", "implement-plan", "implement-plan-audited",
	"init-phoenix", "learn-system", "plan-large", "plan-small", "refactor", "remove-code",
	"review-large-pr", "review-plan",
];
const expectedAgents = [
	"audit-architecture", "audit-logic", "audit-research", "audit-security",
	"audit-simplification", "audit-triage", "plan-reviewer", "researcher",
	"verifier", "reviewer",
];
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir() });
await loader.reload();
function requireResourceFile(path, label) {
	if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`missing or non-regular ${label}: ${path}`);
	const content = readFileSync(path, "utf8");
	if (!content.startsWith("---\n") || !content.includes("\n---")) throw new Error(`invalid frontmatter: ${label}`);
}
const loaded = loader.getExtensions();
if (loaded.errors.length > 0) throw new Error(`extension errors: ${JSON.stringify(loaded.errors)}`);
const extensionPaths = loaded.extensions.map((extension) => extension.path);
const missingExtensions = expectedExtensions.filter((name) => !extensionPaths.some((path) => path.endsWith(`/extensions/${name}`)));
if (missingExtensions.length) throw new Error(`missing extensions: ${missingExtensions.join(", ")}`);
const toolNames = new Set(loaded.extensions.flatMap((extension) => [...extension.tools.keys()]));
for (const name of ["web_search", "web_fetch"]) {
	if (!toolNames.has(name)) throw new Error(`missing tool: ${name}`);
}
const skillNames = new Set(loader.getSkills().skills.map((skill) => skill.name));
const agentDir = getAgentDir();
for (const name of expectedSkills) requireResourceFile(`${agentDir}/skills/${name}/SKILL.md`, `skill ${name}`);
for (const name of expectedAgents) requireResourceFile(`${agentDir}/agents/${name}.md`, `agent ${name}`);
const promptNames = new Set(loader.getPrompts().prompts.map((prompt) => prompt.name));
for (const name of ["autoresearch", "deepresearch"]) {
	if (!promptNames.has(name)) {
		throw new Error(`missing prompt: ${name}`);
	}
	requireResourceFile(`${agentDir}/prompts/${name}.md`, `prompt ${name}`);
}
console.log(JSON.stringify({ extensions: extensionPaths.length, tools: [...toolNames].sort(), skills: expectedSkills.length, discoveredSkills: skillNames.size, agents: expectedAgents.length, prompts: [...promptNames].sort() }));
NODE

echo "structural E2E passed"
