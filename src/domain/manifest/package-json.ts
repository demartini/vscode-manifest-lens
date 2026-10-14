import { parseTree } from "jsonc-parser";
import type { Node, ParseError } from "jsonc-parser";

import { overrideTargetName, isValidPackageName } from "./package-name";
import type {
  DependencyDeclaration,
  DependencySection,
  ParsedManifest,
  SectionInfo,
} from "./types";

const DIRECT_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface Collector {
  readonly text: string;
  readonly declarations: DependencyDeclaration[];
  readonly sections: SectionInfo[];
  readonly issues: string[];
}

const propertyOf = (
  object: Node | undefined,
  key: string
): Node | undefined => {
  if (object?.type !== "object") {
    return undefined;
  }
  return object.children?.find(
    (property) => property.children?.[0]?.value === key
  );
};

const valueOf = (object: Node | undefined, key: string): Node | undefined =>
  propertyOf(object, key)?.children?.[1];

const stringValue = (node: Node | undefined): string | undefined =>
  node?.type === "string" && typeof node.value === "string"
    ? node.value
    : undefined;

interface SectionTarget {
  readonly section: DependencySection;
  readonly catalog?: string;
  readonly idPrefix: string;
  readonly direct: boolean;
  readonly keyNode: Node;
  readonly object: Node;
  readonly resolveName: (key: string) => string | undefined;
}

const collectSection = (collector: Collector, target: SectionTarget): void => {
  const ids: string[] = [];
  for (const property of target.object.children ?? []) {
    const [keyNode, valueNode] = property.children ?? [];
    const key = stringValue(keyNode);
    const specifier = stringValue(valueNode);
    if (
      !(keyNode && valueNode) ||
      key === undefined ||
      specifier === undefined
    ) {
      continue;
    }
    const name = target.resolveName(key);
    if (name === undefined || specifier.startsWith("$")) {
      continue;
    }
    const id = `${target.idPrefix}/${key}`;
    ids.push(id);
    collector.declarations.push({
      ...(target.catalog === undefined ? {} : { catalog: target.catalog }),
      direct: target.direct,
      id,
      name,
      nameSpan: { end: keyNode.offset + keyNode.length, start: keyNode.offset },
      quote: "json",
      rawValue: collector.text.slice(
        valueNode.offset,
        valueNode.offset + valueNode.length
      ),
      section: target.section,
      specifier,
      valueSpan: {
        end: valueNode.offset + valueNode.length,
        start: valueNode.offset,
      },
    });
  }
  const section: SectionInfo = {
    ...(target.catalog === undefined ? {} : { catalog: target.catalog }),
    declarationIds: ids,
    id: target.idPrefix,
    keySpan: {
      end: target.keyNode.offset + target.keyNode.length,
      start: target.keyNode.offset,
    },
    section: target.section,
  };
  collector.sections.push(section);
};

const collectNamed = (
  collector: Collector,
  property: Node | undefined,
  base: Omit<SectionTarget, "keyNode" | "object">
): void => {
  const keyNode = property?.children?.[0];
  const object = property?.children?.[1];
  if (keyNode && object?.type === "object") {
    collectSection(collector, { ...base, keyNode, object });
  }
};

const collectCatalogs = (
  collector: Collector,
  container: Node | undefined,
  prefix: string
): void => {
  collectNamed(collector, propertyOf(container, "catalog"), {
    catalog: "",
    direct: true,
    idPrefix: `${prefix}catalog`,
    resolveName: (key) => (isValidPackageName(key) ? key : undefined),
    section: "catalog",
  });
  const catalogs = valueOf(container, "catalogs");
  if (catalogs?.type !== "object") {
    return;
  }
  for (const entry of catalogs.children ?? []) {
    const catalogName = stringValue(entry.children?.[0]);
    if (catalogName !== undefined) {
      collectNamed(collector, entry, {
        catalog: catalogName,
        direct: true,
        idPrefix: `${prefix}catalogs.${catalogName}`,
        resolveName: (key) => (isValidPackageName(key) ? key : undefined),
        section: "catalog",
      });
    }
  }
};

const workspaceGlobs = (root: Node): string[] => {
  const workspaces = valueOf(root, "workspaces");
  const list =
    workspaces?.type === "array" ? workspaces : valueOf(workspaces, "packages");
  return (list?.children ?? [])
    .map((child) => stringValue(child))
    .filter((glob): glob is string => glob !== undefined);
};

/** Parses a `package.json` document, tolerating comments and malformed input. */
export function parsePackageJson(text: string): ParsedManifest {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  const issues: string[] = [];
  if (errors.length > 0) {
    issues.push(`The manifest contains ${errors.length} syntax error(s).`);
  }
  if (root?.type !== "object") {
    issues.push("The manifest root is not a JSON object.");
    return {
      declarations: [],
      format: "package-json",
      issues,
      sections: [],
      workspaces: [],
    };
  }
  const collector: Collector = { declarations: [], issues, sections: [], text };

  for (const section of DIRECT_SECTIONS) {
    collectNamed(collector, propertyOf(root, section), {
      direct: true,
      idPrefix: section,
      resolveName: (key) => (isValidPackageName(key) ? key : undefined),
      section,
    });
  }
  collectNamed(collector, propertyOf(root, "overrides"), {
    direct: false,
    idPrefix: "overrides",
    resolveName: overrideTargetName,
    section: "overrides",
  });
  collectNamed(collector, propertyOf(root, "resolutions"), {
    direct: false,
    idPrefix: "resolutions",
    resolveName: overrideTargetName,
    section: "resolutions",
  });
  collectNamed(collector, propertyOf(valueOf(root, "pnpm"), "overrides"), {
    direct: false,
    idPrefix: "pnpm.overrides",
    resolveName: overrideTargetName,
    section: "overrides",
  });
  collectCatalogs(collector, root, "");
  collectCatalogs(collector, valueOf(root, "workspaces"), "workspaces.");

  const name = stringValue(valueOf(root, "name"));
  const version = stringValue(valueOf(root, "version"));
  const packageManager = stringValue(valueOf(root, "packageManager"));
  const nodeEngine = stringValue(
    valueOf(valueOf(root, "engines"), "node")
  )?.trim();
  return {
    declarations: collector.declarations,
    format: "package-json",
    issues,
    ...(name === undefined ? {} : { name }),
    ...(nodeEngine === undefined || nodeEngine === "" ? {} : { nodeEngine }),
    ...(packageManager === undefined ? {} : { packageManager }),
    sections: collector.sections,
    ...(version === undefined ? {} : { version }),
    workspaces: workspaceGlobs(root),
  };
}
