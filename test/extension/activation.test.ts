import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { EXTENSION_ID, getApi } from "./support";

describe("activation", () => {
  it("activates and exposes its services", async () => {
    const api = await getApi();
    assert.ok(api.analysis);
    assert.ok(api.dashboard);
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
  });

  it("registers every contributed command exactly once", async () => {
    await getApi();
    const contributed: { command: string }[] =
      vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.contributes
        .commands ?? [];
    assert.ok(contributed.length >= 30);
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed
      .map((entry) => entry.command)
      .filter((id) => !registered.has(id));
    assert.deepEqual(missing, []);
    const ids = contributed.map((entry) => entry.command);
    assert.equal(new Set(ids).size, ids.length, "command ids are unique");
  });

  it("declares limited support for untrusted workspaces", () => {
    const capabilities =
      vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.capabilities;
    assert.equal(capabilities.untrustedWorkspaces.supported, "limited");
    assert.ok(
      capabilities.untrustedWorkspaces.restrictedConfigurations.includes(
        "manifestLens.registry"
      )
    );
  });
});
