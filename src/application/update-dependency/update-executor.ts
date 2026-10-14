import {
  applyManifestEdits,
  createSpecifierEdit,
  relocateDeclaration,
} from "../../domain/manifest/edits";
import { parseManifestText } from "../../domain/manifest/parse";
import type { ManifestEdit } from "../../domain/manifest/types";
import type {
  InstallFlag,
  InstallResult,
  PackageManagerName,
  PackageManagerDetection,
} from "../../domain/package-manager/types";
import type { PlannedUpdate } from "../../domain/update-plan/plan";
import { ManifestLensError, normalizeError } from "../../shared/errors";
import { type Logger, silentLogger } from "../../shared/logger";
import { type Result, err, ok } from "../../shared/result";
import type { ManifestEditorPort } from "../ports";

export interface UpdateExecutorDependencies {
  readonly editor: ManifestEditorPort;
  readonly detect: (manifestDir: string) => Promise<PackageManagerDetection>;
  readonly install: (request: {
    manager: PackageManagerName;
    root: string;
    flag?: InstallFlag;
    signal?: AbortSignal;
    onOutput?: (line: string) => void;
  }) => Promise<InstallResult>;
  readonly logger?: Logger;
}

export interface ApplyOptions {
  readonly install: boolean;
  readonly installFlag?: InstallFlag;
  readonly signal?: AbortSignal;
  readonly onOutput?: (line: string) => void;
  readonly onProgress?: (message: string) => void;
}

export interface InstallOutcome {
  readonly root: string;
  readonly manager: PackageManagerName;
  readonly result: InstallResult;
}

export interface ApplyResult {
  /** Manifests that were modified and saved. */
  readonly changedManifests: readonly string[];
  readonly applied: readonly string[];
  readonly installs: readonly InstallOutcome[];
  readonly installError?: ManifestLensError;
}

interface Pending {
  readonly uri: string;
  readonly text: string;
  readonly version: number;
  readonly edits: ManifestEdit[];
  readonly keys: string[];
}

/**
 * Applies planned updates as one transaction: every target manifest is re-read
 * and validated before the first write, so a stale analysis aborts cleanly.
 */
export class UpdateExecutor {
  private readonly deps: UpdateExecutorDependencies;
  private readonly logger: Logger;

  constructor(deps: UpdateExecutorDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? silentLogger;
  }

  async apply(
    updates: readonly PlannedUpdate[],
    options: ApplyOptions
  ): Promise<Result<ApplyResult, ManifestLensError>> {
    const prepared = await this.prepare(updates);
    if (!prepared.ok) {
      return prepared;
    }
    const changed: string[] = [];
    const applied: string[] = [];
    for (const target of prepared.value) {
      options.onProgress?.(`Updating ${target.uri}`);
      const edited = applyManifestEdits(target.text, target.edits);
      if (!edited.ok) {
        return err(edited.error);
      }
      const written = await this.deps.editor.apply(
        target.uri,
        target.edits,
        target.version
      );
      if (!written.ok) {
        return err(written.error);
      }
      changed.push(target.uri);
      applied.push(...target.keys);
    }
    if (!options.install) {
      return ok({ applied, changedManifests: changed, installs: [] });
    }
    return ok(await this.runInstalls(changed, applied, options));
  }

  /** Runs the install step on its own (the "Run install" command). */
  async installFor(
    manifestUri: string,
    options: Omit<ApplyOptions, "install">
  ): Promise<Result<InstallOutcome, ManifestLensError>> {
    try {
      const outcome = await this.installOne(manifestUri, {
        ...options,
        install: true,
      });
      return ok(outcome);
    } catch (error) {
      return err(normalizeError(error));
    }
  }

  private async prepare(
    updates: readonly PlannedUpdate[]
  ): Promise<Result<Pending[], ManifestLensError>> {
    const byTarget = new Map<string, PlannedUpdate[]>();
    for (const update of updates) {
      const uri =
        update.analysis.catalogSource?.manifestUri ??
        update.analysis.manifestUri;
      byTarget.set(uri, [...(byTarget.get(uri) ?? []), update]);
    }
    const pending: Pending[] = [];
    for (const [uri, group] of byTarget) {
      const document = await this.deps.editor.read(uri);
      const parsed = parseManifestText(uri, document.text);
      if (!parsed) {
        return err(
          new ManifestLensError(
            "unsupported",
            `${uri} is not a supported manifest.`
          )
        );
      }
      const edits: ManifestEdit[] = [];
      for (const update of group) {
        const analyzed =
          update.analysis.catalogSource?.declaration ??
          update.analysis.declaration;
        const fresh = relocateDeclaration(analyzed, parsed);
        if (!fresh) {
          this.logger.warn(`Stale declaration ${analyzed.id} in ${uri}`);
          return err(
            new ManifestLensError(
              "stale",
              `${analyzed.name} changed in ${uri} since it was analyzed. Re-run the analysis and try again.`
            )
          );
        }
        edits.push(createSpecifierEdit(fresh, update.newSpecifier));
      }
      pending.push({
        edits,
        keys: group.map((update) => update.key),
        text: document.text,
        uri,
        version: document.version,
      });
    }
    return ok(pending);
  }

  private async runInstalls(
    changed: readonly string[],
    applied: readonly string[],
    options: ApplyOptions
  ): Promise<ApplyResult> {
    const installs: InstallOutcome[] = [];
    const seen = new Set<string>();
    for (const uri of changed) {
      try {
        const outcome = await this.installOne(uri, options, seen);
        installs.push(outcome);
        if (!outcome.result.success) {
          break;
        }
      } catch (error) {
        return {
          applied,
          changedManifests: changed,
          installError: normalizeError(error),
          installs,
        };
      }
    }
    return { applied, changedManifests: changed, installs };
  }

  private async installOne(
    uri: string,
    options: ApplyOptions,
    seen = new Set<string>()
  ): Promise<InstallOutcome> {
    const dir = this.deps.editor.fsPath(uri);
    if (dir === undefined) {
      throw new ManifestLensError(
        "unsupported",
        "Only local manifests can be installed."
      );
    }
    const detection = await this.deps.detect(dir.replace(/[\\/][^\\/]+$/u, ""));
    if (seen.has(detection.root)) {
      return {
        manager: detection.manager,
        result: { cancelled: false, exitCode: 0, success: true },
        root: detection.root,
      };
    }
    seen.add(detection.root);
    options.onProgress?.(
      `Running ${detection.manager} install in ${detection.root}`
    );
    const result = await this.deps.install({
      manager: detection.manager,
      onOutput: options.onOutput,
      root: detection.root,
      ...(options.installFlag ? { flag: options.installFlag } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { manager: detection.manager, result, root: detection.root };
  }
}
