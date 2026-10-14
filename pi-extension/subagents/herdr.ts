import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function requireHerdr(): void {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("Herdr subagents require a managed Herdr pane (HERDR_ENV=1).");
  }
}

export function herdrCommand(arguments_: string[]): string {
  requireHerdr();
  return execFileSync("herdr", arguments_, { encoding: "utf8", timeout: 10000 });
}

function screenArguments(surface: string, lines: number, paneOutput: string): string[] {
  // Herdr counts blank viewport rows toward --lines, including below the shell prompt.
  const viewportRows = JSON.parse(paneOutput).result.pane.scroll.viewport_rows;
  if (!Number.isInteger(viewportRows) || viewportRows < 0) {
    throw new Error(`Unexpected Herdr pane viewport: ${paneOutput}`);
  }
  return ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(viewportRows + lines)];
}

function lastScreenLines(output: string, lines: number): string {
  return output.trimEnd().split("\n").slice(-Math.max(1, lines)).join("\n");
}

export function readHerdrScreenSync(surface: string, lines: number): string {
  const paneOutput = herdrCommand(["pane", "get", surface]);
  return lastScreenLines(herdrCommand(screenArguments(surface, lines, paneOutput)), lines);
}

// Polled every second while a subagent runs. Herdr serves recent-source reads of a pane
// running a detected agent by injecting mouse-wheel events, which scrolls a fullscreen Pi.
export async function readHerdrScreen(surface: string, lines: number): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync("herdr", ["pane", "read", surface, "--source", "visible"], {
    encoding: "utf8",
    timeout: 10000,
  });
  return lastScreenLines(stdout, lines);
}

function resultId(output: string, resource: string, field: string): string {
  const value = JSON.parse(output)?.result?.[resource]?.[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Unexpected Herdr ${resource} response: ${output}`);
  }
  return value;
}

export function createHerdrSurface(name: string): string {
  return splitHerdrSurface(name, "right");
}

export function splitHerdrSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface = process.env.HERDR_PANE_ID,
): string {
  if (!fromSurface) throw new Error("HERDR_PANE_ID not set");
  if (direction === "left" || direction === "up") {
    throw new Error("Herdr supports background splits only to the right or down.");
  }
  const output = herdrCommand([
    "pane", "split", "--pane", fromSurface, "--direction", direction,
    "--cwd", process.cwd(), "--no-focus",
  ]);
  const surface = resultId(output, "pane", "pane_id");
  herdrCommand(["pane", "rename", surface, name]);
  return surface;
}

export interface HerdrPlacement {
  workspace?: string;
  tab?: string;
}

interface HerdrTarget {
  workspaceId: string;
  paneId?: string;
}

function callerWorkspaceId(): string {
  const surface = process.env.HERDR_PANE_ID;
  if (!surface) throw new Error("HERDR_PANE_ID not set");
  return resultId(herdrCommand(["pane", "get", surface]), "pane", "workspace_id");
}

function findOrCreateWorkspace(label: string, tabLabel: string): HerdrTarget {
  const workspaces = JSON.parse(herdrCommand(["workspace", "list"]))?.result?.workspaces ?? [];
  const existing = workspaces.find((workspace: { label?: string }) => workspace.label === label);
  if (existing) return { workspaceId: existing.workspace_id };

  const output = herdrCommand(["workspace", "create", "--cwd", process.cwd(), "--label", label, "--no-focus"]);
  herdrCommand(["tab", "rename", resultId(output, "tab", "tab_id"), tabLabel]);
  return {
    workspaceId: resultId(output, "workspace", "workspace_id"),
    paneId: resultId(output, "root_pane", "pane_id"),
  };
}

function paneInTab(workspaceId: string, tabLabel: string): string | undefined {
  const tabs = JSON.parse(herdrCommand(["tab", "list", "--workspace", workspaceId]))?.result?.tabs ?? [];
  const tab = tabs.find((candidate: { label?: string }) => candidate.label === tabLabel);
  if (!tab) return undefined;
  const panes = JSON.parse(herdrCommand(["pane", "list", "--workspace", workspaceId]))?.result?.panes ?? [];
  return panes.find((pane: { tab_id?: string }) => pane.tab_id === tab.tab_id)?.pane_id;
}

/**
 * Place a subagent in a named tab of a named workspace, creating either when missing.
 * An existing tab receives a right split, so resumed sessions return to their tab.
 */
export function createPlacedHerdrSurface(name: string, placement: HerdrPlacement): string {
  const tabLabel = placement.tab ?? name;
  const target = placement.workspace
    ? findOrCreateWorkspace(placement.workspace, tabLabel)
    : { workspaceId: callerWorkspaceId() };
  if (target.paneId) {
    herdrCommand(["pane", "rename", target.paneId, name]);
    return target.paneId;
  }

  const existingPane = paneInTab(target.workspaceId, tabLabel);
  if (existingPane) return splitHerdrSurface(name, "right", existingPane);

  const output = herdrCommand([
    "tab", "create", "--workspace", target.workspaceId,
    "--cwd", process.cwd(), "--label", tabLabel, "--no-focus",
  ]);
  const surface = resultId(output, "root_pane", "pane_id");
  herdrCommand(["pane", "rename", surface, name]);
  return surface;
}

export function renameHerdrTab(title: string): void {
  const surface = process.env.HERDR_PANE_ID;
  if (!surface) throw new Error("HERDR_PANE_ID not set");
  const output = herdrCommand(["pane", "get", surface]);
  herdrCommand(["tab", "rename", resultId(output, "pane", "tab_id"), title]);
}

export function renameHerdrWorkspace(title: string): void {
  const surface = process.env.HERDR_PANE_ID;
  if (!surface) throw new Error("HERDR_PANE_ID not set");
  const output = herdrCommand(["pane", "get", surface]);
  herdrCommand(["workspace", "rename", resultId(output, "pane", "workspace_id"), title]);
}
