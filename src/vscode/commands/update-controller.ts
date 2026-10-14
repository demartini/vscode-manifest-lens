import * as vscode from "vscode";

import type {
  UpdateExecutor,
  ApplyResult,
} from "../../application/update-dependency/update-executor";
import type { ManifestLensConfig } from "../../config/configuration-schema";
import type { DependencyAnalysis } from "../../domain/dependency/analysis";
import { computeSortEdits } from "../../domain/manifest/sort";
import type { InstallFlag } from "../../domain/package-manager/types";
import {
  type PlanRisk,
  type PlannedUpdate,
  type SkippedUpdate,
  type UpdateScope,
  planBulkUpdate,
  planResolveToInstalled,
  planSingleUpdate,
} from "../../domain/update-plan/plan";
import type { Candidate } from "../../domain/version/candidates";
import {
  classifyUpdate,
  isPotentiallyBreaking,
} from "../../domain/version/classification";
import type { OutputChannelLogger } from "../../infrastructure/logging/output-channel-logger";
import type { Installer } from "../../infrastructure/package-manager/installer";
import { clip } from "../../presentation/markdown";
import { normalizeError } from "../../shared/errors";
import type { AnalysisService } from "../services/analysis-service";
import type { VsCodeManifestEditor } from "../services/manifest-editor";
import type { PackageManagerResolver } from "../services/package-manager-resolver";
import type { OperationRunner } from "./operation-runner";

export interface UpdateOptions {
  readonly install: boolean;
  /** Skip the blocked-update review (used by flows that already showed it). */
  readonly acknowledgedBlocked?: boolean;
  readonly installFlag?: InstallFlag;
}

interface PickItem extends vscode.QuickPickItem {
  readonly update?: PlannedUpdate;
}

const riskText = (risk: PlanRisk): string => {
  switch (risk.kind) {
    case "peer-blocked": {
      return `blocked by ${[...new Set(risk.conflicts.map((c) => c.blocker))].join(", ")}`;
    }
    case "peer-potential": {
      return "possible peer conflict";
    }
    case "introduces-advisory": {
      return `introduces ${risk.ids.join(", ")}`;
    }
    default: {
      return "may be breaking";
    }
  }
};

const describePlan = (update: PlannedUpdate): string =>
  `${update.analysis.declaration.specifier} → ${update.newSpecifier} (${update.candidate.severity})`;

/** Orchestrates update, resolve, install and sort commands with confirmations. */
export class UpdateController {
  constructor(
    private readonly deps: {
      analysis: AnalysisService;
      executor: UpdateExecutor;
      editor: VsCodeManifestEditor;
      installer: Installer;
      resolver: PackageManagerResolver;
      runner: OperationRunner;
      logger: OutputChannelLogger;
      config: () => ManifestLensConfig;
      onInstalled: () => void;
    }
  ) {}

  /** Finds the candidate for `version` (default: the target update). */
  candidateFor(
    item: DependencyAnalysis,
    version?: string
  ): Candidate | undefined {
    const { selection } = item;
    if (!selection) {
      return undefined;
    }
    if (version === undefined) {
      return selection.target;
    }
    const known = [
      selection.target,
      selection.major,
      selection.minor,
      selection.patch,
      selection.prerelease,
      item.compatibleCandidate,
      ...selection.stableCandidates,
    ].find((candidate) => candidate?.version === version);
    if (known) {
      return known;
    }
    const base = selection.baseVersion;
    return base === undefined
      ? undefined
      : {
          potentiallyBreaking: isPotentiallyBreaking(base, version),
          severity: classifyUpdate(base, version),
          version,
        };
  }

  async freshItem(key: string): Promise<DependencyAnalysis | undefined> {
    const item = this.deps.analysis.findItem(key);
    if (!item) {
      void vscode.window.showWarningMessage(
        "Manifest Lens: this dependency is no longer available. Re-run the analysis."
      );
      return undefined;
    }
    const state = this.deps.analysis.get(item.manifestUri);
    if (state?.stale === true || state?.status === "loading") {
      await this.deps.analysis.analyzeNow(item.manifestUri);
      const refreshed = this.deps.analysis.findItem(key);
      if (!refreshed) {
        void vscode.window.showWarningMessage(
          "Manifest Lens: the manifest changed; the update was cancelled."
        );
      }
      return refreshed;
    }
    return item;
  }

  async updateDependency(
    key: string,
    version: string | undefined,
    options: UpdateOptions
  ): Promise<void> {
    const item = await this.freshItem(key);
    if (!item) {
      return;
    }
    const candidate = this.candidateFor(item, version);
    if (!candidate) {
      void vscode.window.showInformationMessage(
        `Manifest Lens: no update is available for ${item.declaration.name}.`
      );
      return;
    }
    const peerStatus = item.peer[candidate.version]?.status;
    if (peerStatus === "blocked" && options.acknowledgedBlocked !== true) {
      await this.updateBlocked(key, candidate.version);
      return;
    }
    const { update, skipped } = planSingleUpdate(
      item,
      candidate,
      peerStatus === "blocked" ? "force" : "conservative"
    );
    if (!update) {
      this.reportSkipped(skipped);
      return;
    }
    if (!(await this.confirmRisks([update], { includeBlocked: false }))) {
      return;
    }
    await this.apply([update], options, `Updating ${item.declaration.name}`);
  }

  async updateBlocked(key: string, version?: string): Promise<void> {
    const item = await this.freshItem(key);
    const candidate = item ? this.candidateFor(item, version) : undefined;
    if (!(item && candidate)) {
      return;
    }
    const { update, skipped } = planSingleUpdate(item, candidate, "force");
    if (!update) {
      this.reportSkipped(skipped);
      return;
    }
    const conflicts = item.peer[candidate.version]?.conflicts ?? [];
    const lines = conflicts.map((conflict) => {
      const fix = conflict.resolution
        ? ` (fix: upgrade ${conflict.resolution.package} to ${conflict.resolution.version})`
        : "";
      return `• ${clip(conflict.note, 160)}${fix}`;
    });
    const detection = await this.deps.resolver.resolve(item.manifestUri);
    const canBypass = detection.manager === "npm";
    const buttons = [
      "Update and Install",
      ...(canBypass ? ["Install with --legacy-peer-deps"] : []),
      "Update Only",
    ];
    const choice = await vscode.window.showWarningMessage(
      `${item.declaration.name} ${candidate.version} conflicts with peer dependency requirements`,
      {
        detail: `${lines.join("\n")}\n\nProceeding may produce install errors or runtime incompatibilities. Peer checks are not bypassed unless you choose the explicit flag.`,
        modal: true,
      },
      ...buttons
    );
    if (choice === undefined) {
      return;
    }
    if (
      !(await this.confirmRisks([update], {
        includeBlocked: true,
        skipPeer: true,
      }))
    ) {
      return;
    }
    await this.apply(
      [update],
      {
        acknowledgedBlocked: true,
        install: choice !== "Update Only",
        ...(choice === "Install with --legacy-peer-deps"
          ? { installFlag: "--legacy-peer-deps" as const }
          : {}),
      },
      `Updating ${item.declaration.name}`
    );
  }

  async resolveToInstalled(key: string): Promise<void> {
    const item = await this.freshItem(key);
    if (!item) {
      return;
    }
    const { update, skipped } = planResolveToInstalled(item);
    if (!update) {
      this.reportSkipped(skipped);
      return;
    }
    await this.apply(
      [update],
      { install: false },
      `Resolving ${item.declaration.name}`
    );
  }

  async bulk(options: {
    uris: readonly string[];
    scope: UpdateScope;
    sectionId?: string;
  }): Promise<void> {
    const items: DependencyAnalysis[] = [];
    for (const uri of options.uris) {
      const state = this.deps.analysis.get(uri);
      const section = options.sectionId
        ? state?.parsed?.sections.find(
            (candidate) => candidate.id === options.sectionId
          )
        : undefined;
      for (const item of state?.analysis?.items ?? []) {
        if (!section || section.declarationIds.includes(item.declaration.id)) {
          items.push(item);
        }
      }
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        "Manifest Lens: no analyzed dependencies yet. Run the analysis first."
      );
      return;
    }
    const policy = this.deps.config().updatePolicy;
    const plan = planBulkUpdate(items, { policy, scope: options.scope });
    if (plan.eligible.length === 0) {
      void vscode.window.showInformationMessage(
        `Manifest Lens: nothing to update${plan.skipped.length > 0 ? ` (${plan.skipped.length} skipped, see output)` : ""}.`
      );
      this.reportPlan(plan.eligible, plan.skipped);
      return;
    }
    const selected = await this.pickUpdates(plan.eligible, plan.skipped);
    if (!selected || selected.length === 0) {
      return;
    }
    const mode = await vscode.window.showInformationMessage(
      `Update ${selected.length} ${selected.length === 1 ? "dependency" : "dependencies"}?`,
      {
        detail: [
          ...selected
            .slice(0, 12)
            .map(
              (update) =>
                `• ${update.analysis.declaration.name}: ${describePlan(update)}`
            ),
          ...(selected.length > 12
            ? [`…and ${selected.length - 12} more`]
            : []),
          ...(plan.skipped.length > 0
            ? [
                `\n${plan.skipped.length} skipped (blocked, unsupported or unavailable).`,
              ]
            : []),
        ].join("\n"),
        modal: true,
      },
      "Update",
      "Update and Install"
    );
    if (!mode) {
      return;
    }
    if (
      !(await this.confirmRisks(selected, {
        includeBlocked: policy === "force",
      }))
    ) {
      return;
    }
    this.reportPlan(selected, plan.skipped);
    await this.apply(
      selected,
      { install: mode === "Update and Install" },
      `Updating ${selected.length} dependencies`
    );
  }

  async installManifest(uri: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      const choice = await vscode.window.showWarningMessage(
        "Manifest Lens never runs package manager commands in an untrusted workspace.",
        "Manage Workspace Trust"
      );
      if (choice) {
        await vscode.commands.executeCommand("workbench.trust.manage");
      }
      return;
    }
    await this.deps.runner.run(
      "Installing dependencies",
      async (signal, report) => {
        const result = await this.deps.executor.installFor(uri, {
          onOutput: (line) => {
            this.deps.logger.report(line);
          },
          onProgress: report,
          signal,
        });
        this.deps.onInstalled();
        if (!result.ok) {
          this.reportFailure(result.error.message);
          return;
        }
        this.reportInstall(
          result.value.manager,
          result.value.root,
          result.value.result
        );
      }
    );
  }

  async sortDependencies(document: vscode.TextDocument): Promise<void> {
    const { edits, skipped } = computeSortEdits(document.getText());
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(
        `Manifest Lens: ${skipped.join(", ")} contain comments between entries and were not sorted.`
      );
    }
    if (edits.length === 0) {
      void vscode.window.showInformationMessage(
        "Manifest Lens: dependencies are already sorted."
      );
      return;
    }
    const result = await this.deps.editor.apply(
      document.uri.toString(),
      edits,
      document.version
    );
    if (!result.ok) {
      this.reportFailure(result.error.message);
    }
  }

  private async pickUpdates(
    eligible: readonly PlannedUpdate[],
    skipped: readonly SkippedUpdate[]
  ): Promise<PlannedUpdate[] | undefined> {
    const quickPick = vscode.window.createQuickPick<PickItem>();
    quickPick.canSelectMany = true;
    quickPick.title = `Manifest Lens: ${eligible.length} update${eligible.length === 1 ? "" : "s"} ready, ${skipped.length} skipped`;
    quickPick.placeholder = "Uncheck anything you do not want to update";
    quickPick.matchOnDescription = true;
    const items: PickItem[] = eligible.map((update) => ({
      description: describePlan(update),
      detail:
        update.risks.length > 0
          ? `⚠ ${update.risks.map(riskText).join("; ")}`
          : undefined,
      label: `$(arrow-up) ${update.analysis.declaration.name}`,
      picked: true,
      update,
    }));
    quickPick.items =
      skipped.length === 0
        ? items
        : [
            ...items,
            {
              kind: vscode.QuickPickItemKind.Separator,
              label: "Skipped (not selectable)",
            },
            ...skipped.map((entry) => ({
              alwaysShow: true,
              description: entry.reason,
              detail: clip(entry.detail, 160),
              label: `$(circle-slash) ${entry.name}`,
            })),
          ];
    quickPick.selectedItems = items;
    return await new Promise<PlannedUpdate[] | undefined>((resolve) => {
      quickPick.onDidAccept(() => {
        const chosen = quickPick.selectedItems.flatMap((item) =>
          item.update ? [item.update] : []
        );
        resolve(chosen);
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        resolve(undefined);
        quickPick.dispose();
      });
      quickPick.show();
    });
  }

  /** Returns false if the user declined a risk, an unsaved-buffer warning, or a force. */
  private async confirmRisks(
    updates: readonly PlannedUpdate[],
    options: { includeBlocked: boolean; skipPeer?: boolean }
  ): Promise<boolean> {
    const config = this.deps.config();
    const lines: string[] = [];
    for (const update of updates) {
      for (const risk of update.risks) {
        if (
          risk.kind === "introduces-advisory" &&
          config.security.warnBeforeAdvisoryUpgrade
        ) {
          lines.push(
            `• ${update.analysis.declaration.name}@${update.candidate.version} is affected by ${risk.ids.join(", ")}`
          );
        } else if (
          risk.kind === "peer-blocked" &&
          options.includeBlocked &&
          options.skipPeer !== true
        ) {
          lines.push(
            `• ${update.analysis.declaration.name}@${update.candidate.version} ${riskText(risk)}`
          );
        }
      }
    }
    if (lines.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        "Some updates carry known risks",
        { detail: lines.join("\n"), modal: true },
        "Update Anyway"
      );
      if (choice === undefined) {
        return false;
      }
    }
    return await this.confirmDirtyDocuments(updates);
  }

  private async confirmDirtyDocuments(
    updates: readonly PlannedUpdate[]
  ): Promise<boolean> {
    const uris = new Set(
      updates.map(
        (update) =>
          update.analysis.catalogSource?.manifestUri ??
          update.analysis.manifestUri
      )
    );
    const dirty = vscode.workspace.textDocuments.filter(
      (document) => document.isDirty && uris.has(document.uri.toString())
    );
    if (dirty.length === 0) {
      return true;
    }
    const names = dirty
      .map((document) => vscode.workspace.asRelativePath(document.uri))
      .join(", ");
    const choice = await vscode.window.showWarningMessage(
      `${names} ${dirty.length === 1 ? "has" : "have"} unsaved changes`,
      {
        detail:
          "Applying the update saves the file, including your unsaved edits.",
        modal: true,
      },
      "Save and Continue"
    );
    return choice !== undefined;
  }

  private async apply(
    updates: readonly PlannedUpdate[],
    options: UpdateOptions,
    title: string
  ): Promise<void> {
    if (options.install && !vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        "Manifest Lens: the manifest can be edited, but installation is disabled until you trust this workspace."
      );
      await this.runApply(updates, { ...options, install: false }, title);
      return;
    }
    await this.runApply(updates, options, title);
  }

  private async runApply(
    updates: readonly PlannedUpdate[],
    options: UpdateOptions,
    title: string
  ): Promise<void> {
    const outcome = await this.deps.runner.run(
      title,
      async (signal, report) => {
        try {
          return await this.deps.executor.apply(updates, {
            install: options.install,
            ...(options.installFlag
              ? { installFlag: options.installFlag }
              : {}),
            onOutput: (line) => {
              this.deps.logger.report(line);
            },
            onProgress: report,
            signal,
          });
        } catch (error) {
          return { error: normalizeError(error), ok: false as const };
        }
      }
    );
    if (!outcome) {
      return;
    }
    if (!outcome.ok) {
      this.reportFailure(outcome.error.message);
      return;
    }
    for (const uri of outcome.value.changedManifests) {
      this.deps.analysis.request(uri, { immediate: true });
    }
    if (options.install) {
      this.deps.onInstalled();
    }
    this.reportApplied(updates, outcome.value);
  }

  private reportApplied(
    updates: readonly PlannedUpdate[],
    result: ApplyResult
  ): void {
    const summary =
      updates.length === 1
        ? `Updated ${updates[0]?.analysis.declaration.name} to ${updates[0]?.newSpecifier}.`
        : `Updated ${updates.length} dependencies.`;
    for (const update of updates) {
      this.deps.logger.report(
        `updated ${update.analysis.declaration.name}: ${describePlan(update)}`
      );
    }
    if (result.installError) {
      this.reportFailure(
        `${summary} Installation could not run: ${result.installError.message}`
      );
      return;
    }
    const install = result.installs.at(-1);
    if (!install) {
      void vscode.window.showInformationMessage(
        `Manifest Lens: ${summary} Nothing was installed.`
      );
      return;
    }
    this.reportInstall(install.manager, install.root, install.result, summary);
  }

  private reportInstall(
    manager: string,
    root: string,
    result: {
      success: boolean;
      cancelled: boolean;
      exitCode: number | undefined;
    },
    prefix = ""
  ): void {
    if (result.cancelled) {
      void vscode.window.showWarningMessage(
        `Manifest Lens: ${prefix} Installation was cancelled.`.trim()
      );
    } else if (result.success) {
      void vscode.window.showInformationMessage(
        `Manifest Lens: ${prefix} ${manager} install finished in ${root}.`.trim()
      );
    } else {
      this.reportFailure(
        `${prefix} ${manager} install failed (exit code ${result.exitCode ?? "unknown"}).`.trim()
      );
    }
  }

  private reportSkipped(skipped: SkippedUpdate | undefined): void {
    if (skipped) {
      void vscode.window.showWarningMessage(
        `Manifest Lens: ${skipped.name} was not updated — ${skipped.detail}`
      );
    }
  }

  private reportPlan(
    eligible: readonly PlannedUpdate[],
    skipped: readonly SkippedUpdate[]
  ): void {
    for (const update of eligible) {
      this.deps.logger.report(
        `plan: update ${update.analysis.declaration.name} ${describePlan(update)}`
      );
    }
    for (const entry of skipped) {
      this.deps.logger.report(
        `plan: skip ${entry.name} [${entry.reason}] ${entry.detail}`
      );
    }
  }

  private reportFailure(message: string): void {
    this.deps.logger.report(`error: ${message}`);
    void vscode.window
      .showErrorMessage(`Manifest Lens: ${message}`, "Show Output")
      .then((choice) => {
        if (choice) {
          this.deps.logger.show();
        }
      });
  }
}
