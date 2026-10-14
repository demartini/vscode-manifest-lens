import * as vscode from "vscode";

import type {
  AnalysisSettings,
  ManifestAnalyzer,
} from "../../application/analyze-manifest/analyze-manifest";
import type { ManifestLensConfig } from "../../config/configuration-schema";
import type {
  DependencyAnalysis,
  ManifestAnalysis,
} from "../../domain/dependency/analysis";
import { parseManifestText } from "../../domain/manifest/parse";
import type { ParsedManifest } from "../../domain/manifest/types";
import type { ManifestLensError } from "../../shared/errors";
import { isCancellation, normalizeError } from "../../shared/errors";
import type { Logger } from "../../shared/logger";
import { dirOf, fsPathOf } from "./uri";
import type { WorkspaceIndex } from "./workspace-index";

export type ManifestStatus = "error" | "loading" | "ready";

export interface ManifestState {
  readonly uri: string;
  readonly status: ManifestStatus;
  /** The latest successful analysis; kept (stale) while a refresh runs or fails. */
  readonly analysis?: ManifestAnalysis;
  readonly parsed?: ParsedManifest;
  /** Text the analysis refers to, used to place ranges for unopened manifests. */
  readonly text?: string;
  readonly error?: ManifestLensError;
  /** True when `analysis` predates the latest request. */
  readonly stale: boolean;
}

export interface AnalysisChange {
  readonly uri: string;
}

interface Slot {
  generation: number;
  controller?: AbortController;
  timer?: NodeJS.Timeout;
  state: ManifestState;
}

const DEBOUNCE_MS = 400;
const MAX_PARALLEL_MANIFESTS = 2;

/**
 * Owns analysis results for every manifest. Requests are debounced, a newer
 * request supersedes (and aborts) an older one, and results computed for text
 * that has since changed are discarded so they can never overwrite fresher data.
 */
export class AnalysisService implements vscode.Disposable {
  private readonly slots = new Map<string, Slot>();
  private readonly itemsByKey = new Map<string, DependencyAnalysis>();
  private readonly emitter = new vscode.EventEmitter<AnalysisChange>();
  private readonly busyEmitter = new vscode.EventEmitter<boolean>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private disposed = false;
  readonly onDidChange = this.emitter.event;
  readonly onDidChangeBusy = this.busyEmitter.event;

  constructor(
    private readonly deps: {
      analyzer: ManifestAnalyzer;
      index: WorkspaceIndex;
      config: () => ManifestLensConfig;
      logger: Logger;
      now: () => number;
    }
  ) {}

  get isBusy(): boolean {
    return this.running > 0 || this.waiting.length > 0;
  }

  get(uri: string): ManifestState | undefined {
    return this.slots.get(uri)?.state;
  }

  states(): ManifestState[] {
    return [...this.slots.values()].map((slot) => slot.state);
  }

  findItem(key: string): DependencyAnalysis | undefined {
    return this.itemsByKey.get(key);
  }

  /** Schedules an analysis. Rapid calls are coalesced. */
  request(uri: string, options: { immediate?: boolean } = {}): void {
    if (this.disposed) {
      return;
    }
    const slot = this.slotFor(uri);
    if (slot.timer) {
      clearTimeout(slot.timer);
    }
    slot.generation += 1;
    slot.controller?.abort();
    this.setState(slot, {
      ...slot.state,
      stale: slot.state.analysis !== undefined,
      status: "loading",
    });
    slot.timer = setTimeout(
      () => {
        slot.timer = undefined;
        void this.run(slot, uri);
      },
      options.immediate === true ? 0 : DEBOUNCE_MS
    );
  }

  /** Runs an analysis now and resolves with its outcome. */
  async analyzeNow(uri: string): Promise<ManifestAnalysis | undefined> {
    const slot = this.slotFor(uri);
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    slot.generation += 1;
    slot.controller?.abort();
    return await this.run(slot, uri);
  }

  /**
   * Analyzes every indexed manifest. Without `force`, manifests that already
   * have a result are left alone so showing the dashboard stays cheap.
   */
  async analyzeWorkspace(
    options: { force?: boolean; rescan?: boolean } = {}
  ): Promise<void> {
    if (options.rescan === true || !this.deps.index.hasScanned) {
      await this.deps.index.scan();
    }
    const targets = this.deps.index
      .all()
      .filter(
        (entry) =>
          entry.parsed.declarations.length > 0 ||
          entry.parsed.format === "package-json"
      )
      .filter(
        (entry) =>
          options.force === true ||
          this.slots.get(entry.uri)?.state.analysis === undefined
      );
    await Promise.all(
      targets.map(async (entry) => await this.analyzeNow(entry.uri))
    );
  }

  /** Re-analyzes everything already tracked, e.g. after a configuration change. */
  requestAll(options: { immediate?: boolean } = {}): void {
    for (const uri of this.slots.keys()) {
      this.request(uri, options);
    }
  }

  forget(uri: string): void {
    const slot = this.slots.get(uri);
    if (!slot) {
      return;
    }
    slot.controller?.abort();
    if (slot.timer) {
      clearTimeout(slot.timer);
    }
    this.slots.delete(uri);
    for (const key of [...this.itemsByKey.keys()]) {
      if (key.startsWith(`${uri}#`)) {
        this.itemsByKey.delete(key);
      }
    }
    this.emitter.fire({ uri });
  }

  cancelAll(): void {
    for (const slot of this.slots.values()) {
      slot.generation += 1;
      slot.controller?.abort();
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = undefined;
      }
      if (slot.state.status === "loading") {
        this.setState(slot, {
          ...slot.state,
          stale: slot.state.analysis !== undefined,
          status: slot.state.analysis ? "ready" : "error",
        });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    this.emitter.dispose();
    this.busyEmitter.dispose();
  }

  private slotFor(uri: string): Slot {
    let slot = this.slots.get(uri);
    if (!slot) {
      slot = { generation: 0, state: { stale: false, status: "loading", uri } };
      this.slots.set(uri, slot);
    }
    return slot;
  }

  private setState(slot: Slot, state: ManifestState): void {
    slot.state = state;
    this.emitter.fire({ uri: state.uri });
  }

  private async acquire(): Promise<void> {
    if (this.running >= MAX_PARALLEL_MANIFESTS) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.running += 1;
    if (this.running === 1) {
      this.busyEmitter.fire(true);
    }
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
    if (!this.isBusy) {
      this.busyEmitter.fire(false);
    }
  }

  private buildSettings(config: ManifestLensConfig): AnalysisSettings {
    return {
      concurrency: config.analysis.concurrency,
      peerEnabled: config.peerDependencies.enabled,
      prerelease: {
        enabled: config.prerelease.enabled,
        tags: config.prerelease.tags,
      },
      securityEnabled: config.security.enabled,
    };
  }

  private async run(
    slot: Slot,
    uri: string
  ): Promise<ManifestAnalysis | undefined> {
    const { generation } = slot;
    const controller = new AbortController();
    slot.controller = controller;
    await this.acquire();
    try {
      if (generation !== slot.generation) {
        return undefined;
      }
      const read = await this.deps.index.read(uri);
      const parsed = read ? parseManifestText(uri, read.text) : undefined;
      if (!(read && parsed)) {
        this.forget(uri);
        return undefined;
      }
      await this.deps.index.refreshOne(uri, false);
      const config = this.deps.config();
      const analysis = await this.deps.analyzer.analyze({
        documentVersion: read.version,
        localPackageNames: config.workspace.enabled
          ? this.deps.index.localPackageNames()
          : new Set(),
        manifestDir: dirOf(uri),
        manifestUri: uri,
        parsed,
        resolveCatalog: (catalog, name) =>
          this.deps.index.resolveCatalog(uri, catalog, name),
        settings: this.buildSettings(config),
        signal: controller.signal,
        workspaceDependencyNames: config.workspace.enabled
          ? this.deps.index.siblingDependencyNames(uri)
          : [],
      });
      if (generation !== slot.generation || this.disposed) {
        return undefined;
      }
      const current = await this.deps.index.read(uri);
      if (current && current.version !== read.version) {
        this.deps.logger.debug(`Discarding stale analysis for ${uri}`);
        return undefined;
      }
      this.store(slot, uri, { analysis, parsed, text: read.text });
      return analysis;
    } catch (error) {
      if (generation === slot.generation && !isCancellation(error)) {
        const failure = normalizeError(error);
        this.deps.logger.warn(`Analysis failed for ${uri}: ${failure.message}`);
        this.setState(slot, {
          ...slot.state,
          error: failure,
          stale: slot.state.analysis !== undefined,
          status: "error",
        });
      }
      return undefined;
    } finally {
      this.release();
    }
  }

  private store(
    slot: Slot,
    uri: string,
    data: { analysis: ManifestAnalysis; parsed: ParsedManifest; text: string }
  ): void {
    for (const key of [...this.itemsByKey.keys()]) {
      if (key.startsWith(`${uri}#`)) {
        this.itemsByKey.delete(key);
      }
    }
    for (const item of data.analysis.items) {
      this.itemsByKey.set(item.key, item);
    }
    this.setState(slot, {
      analysis: data.analysis,
      parsed: data.parsed,
      stale: false,
      status: "ready",
      text: data.text,
      uri,
    });
  }
}

export const isLocalManifest = (uri: string): boolean =>
  fsPathOf(uri) !== undefined;
