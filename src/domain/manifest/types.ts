export type ManifestFormat = "package-json" | "pnpm-workspace";

export type DependencySection =
  | "catalog"
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "overrides"
  | "peerDependencies"
  | "resolutions";

/** A half-open range of UTF-16 offsets into the manifest text. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** How the specifier token is written, so replacements stay syntactically valid. */
export type QuoteStyle = "json" | "yaml-double" | "yaml-plain" | "yaml-single";

export interface DependencyDeclaration {
  /** Stable within one manifest text; unique per declaration. */
  readonly id: string;
  readonly name: string;
  readonly specifier: string;
  readonly section: DependencySection;
  /** Name of the catalog for `catalogs.<name>` entries; empty for the default one. */
  readonly catalog?: string;
  /** False for overrides/resolutions, which target transitive dependencies. */
  readonly direct: boolean;
  readonly nameSpan: TextSpan;
  /** The whole specifier token, including quotes. */
  readonly valueSpan: TextSpan;
  /** The exact source text of the specifier token. */
  readonly rawValue: string;
  readonly quote: QuoteStyle;
}

export interface SectionInfo {
  readonly id: string;
  readonly section: DependencySection;
  readonly catalog?: string;
  /** The span of the section's key, used to anchor summary lenses. */
  readonly keySpan: TextSpan;
  readonly declarationIds: readonly string[];
}

export interface ParsedManifest {
  readonly format: ManifestFormat;
  readonly name?: string;
  readonly version?: string;
  /** The `packageManager` field, e.g. `pnpm@9.0.0`. */
  readonly packageManager?: string;
  /** The Node range the project declares in `engines.node`. */
  readonly nodeEngine?: string;
  /** Workspace globs from the manifest or `pnpm-workspace.yaml`. */
  readonly workspaces: readonly string[];
  readonly declarations: readonly DependencyDeclaration[];
  readonly sections: readonly SectionInfo[];
  /** Human-readable parse problems; the manifest may still be partially usable. */
  readonly issues: readonly string[];
}

export interface ManifestEdit {
  readonly declarationId: string;
  readonly span: TextSpan;
  /** The text that must still be at `span` for the edit to apply. */
  readonly expected: string;
  readonly replacement: string;
}
