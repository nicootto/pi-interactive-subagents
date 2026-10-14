import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeSurface, createSurface, createSurfaceSplit, getMuxBackend,
  readScreen, readScreenAsync, renameCurrentTab, renameWorkspace, sendCommand, sendEscape,
} from "../pi-extension/subagents/cmux.ts";
import { herdrCommand } from "../pi-extension/subagents/herdr.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-herdr-test-"));
const commandLog = join(directory, "commands.jsonl");
const originalEnvironment = { ...process.env };

before(() => {
  writeFileSync(join(directory, "herdr"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const arguments_ = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(arguments_) + "\\n");
if (arguments_[0] === "pane" && arguments_[1] === "read") {
  process.stdout.write("__SUBAGENT_DONE_0__\\n\\n\\n");
} else {
  const workspace = { workspace_id: "w-test", label: "migration" };
  const pane = { pane_id: "w-test:p-child", tab_id: "w-test:t-child", workspace_id: "w-test", scroll: { viewport_rows: 80 } };
  const tab = { tab_id: pane.tab_id, label: "existing-tab" };
  console.log(JSON.stringify({ result: { workspace, workspaces: [workspace], pane, panes: [pane], root_pane: pane, tab, tabs: [tab] } }));
}
`, { mode: 0o755 });
  process.env.PATH = `${directory}:${originalEnvironment.PATH}`;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w-parent:p-parent";
  delete process.env.PI_SUBAGENT_MUX;
});

after(() => {
  process.env = originalEnvironment;
  rmSync(directory, { recursive: true, force: true });
});

it("detects Herdr before an outer multiplexer and refuses control outside Herdr", () => {
  process.env.TMUX = "/outer/tmux";
  assert.equal(getMuxBackend(), "herdr");
  process.env.PI_SUBAGENT_MUX = "herdr";
  process.env.HERDR_ENV = "0";
  assert.equal(getMuxBackend(), null);
  assert.throws(() => herdrCommand(["workspace", "list"]), /HERDR_ENV=1/);
  process.env.HERDR_ENV = "1";
  delete process.env.HERDR_PANE_ID;
  assert.equal(getMuxBackend(), null);
  process.env.HERDR_PANE_ID = "w-parent:p-parent";
});

it("splits the caller pane without focus and uses explicit IDs for the complete mux contract", async () => {
  const name = "Scout: quotes ' and $(not-a-command)";
  const first = createSurface(name);
  const second = createSurface("Second");
  assert.equal(first, "w-test:p-child");
  assert.equal(second, "w-test:p-child");
  sendCommand(first, "printf '%s' 'hello world'");
  sendEscape(first);
  assert.equal(readScreen(first, 7), "__SUBAGENT_DONE_0__");
  assert.equal(await readScreenAsync(first, 8), "__SUBAGENT_DONE_0__");
  renameCurrentTab("Plan");
  renameWorkspace("Project");
  assert.throws(() => createSurfaceSplit("Left", "left", first), /background splits only/);
  createSurfaceSplit("Right", "right", first);
  closeSurface(first);

  const commands = readFileSync(commandLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(commands, [
    ["pane", "split", "--pane", "w-parent:p-parent", "--direction", "right", "--cwd", process.cwd(), "--no-focus"],
    ["pane", "rename", first, name],
    ["pane", "split", "--pane", "w-parent:p-parent", "--direction", "right", "--cwd", process.cwd(), "--no-focus"],
    ["pane", "rename", second, "Second"],
    ["pane", "run", first, "printf '%s' 'hello world'"],
    ["pane", "send-keys", first, "esc"],
    ["pane", "get", first],
    ["pane", "read", first, "--source", "recent-unwrapped", "--lines", "87"],
    ["pane", "read", first, "--source", "visible"],
    ["pane", "get", "w-parent:p-parent"],
    ["tab", "rename", "w-test:t-child", "Plan"],
    ["pane", "get", "w-parent:p-parent"],
    ["workspace", "rename", "w-test", "Project"],
    ["pane", "split", "--pane", first, "--direction", "right", "--cwd", process.cwd(), "--no-focus"],
    ["pane", "rename", first, "Right"],
    ["pane", "close", first],
  ]);
});

it("places subagents in named workspaces and tabs, reusing existing ones", () => {
  writeFileSync(commandLog, "");
  assert.equal(createSurface("Worker", { workspace: "migration", tab: "new-tab" }), "w-test:p-child");
  assert.equal(createSurface("Resume", { workspace: "migration", tab: "existing-tab" }), "w-test:p-child");
  assert.equal(createSurface("Validator", { workspace: "migration-validation", tab: "order-dimension-backfill" }), "w-test:p-child");

  const commands = readFileSync(commandLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(commands, [
    ["workspace", "list"],
    ["tab", "list", "--workspace", "w-test"],
    ["tab", "create", "--workspace", "w-test", "--cwd", process.cwd(), "--label", "new-tab", "--no-focus"],
    ["pane", "rename", "w-test:p-child", "Worker"],
    ["workspace", "list"],
    ["tab", "list", "--workspace", "w-test"],
    ["pane", "list", "--workspace", "w-test"],
    ["pane", "split", "--pane", "w-test:p-child", "--direction", "right", "--cwd", process.cwd(), "--no-focus"],
    ["pane", "rename", "w-test:p-child", "Resume"],
    ["workspace", "list"],
    ["workspace", "create", "--cwd", process.cwd(), "--label", "migration-validation", "--no-focus"],
    ["tab", "rename", "w-test:t-child", "order-dimension-backfill"],
    ["pane", "rename", "w-test:p-child", "Validator"],
  ]);
});
