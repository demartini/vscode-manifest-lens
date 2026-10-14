// Prepares a release: picks the next version from the Conventional Commits since the last
// tag, adds that version to CHANGELOG.md, commits both and tags the commit. Pushing the tag starts
// publish.yml.
//
// Usage: bun run release [x.y.z]   (without a version, semver is derived from the commits)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import semver from "semver";

const TAG_PREFIX = "v";
const RELEASE_TYPES: semver.ReleaseType[] = ["major", "minor", "patch"];

const fail = (message: string): never => {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: string[]): string =>
  execFileSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
const git = (...args: string[]): string => run("git", args);
const conventional = (command: string, ...args: string[]): string =>
  run("bunx", [
    command,
    "--preset",
    "conventionalcommits",
    "--tag-prefix",
    TAG_PREFIX,
    ...args,
  ]);

if (git("branch", "--show-current") !== "main") {
  fail("releases are cut from main");
}
if (git("status", "--porcelain") !== "") {
  fail("the working tree must be clean");
}

const manifest = readFileSync("package.json", "utf-8");
const [, current = ""] = /"version":\s*"([^"]+)"/u.exec(manifest) ?? [];
const [lastTag] = git(
  "tag",
  "--list",
  `${TAG_PREFIX}*`,
  "--sort=-v:refname"
).split("\n");

let version = process.argv[2] ?? "";
if (version === "") {
  // The first release ships the version already in package.json.
  const bump = lastTag ? conventional("conventional-recommended-bump") : "";
  version = lastTag
    ? (semver.inc(
        lastTag.slice(TAG_PREFIX.length),
        RELEASE_TYPES.find((type) => type === bump) ?? "patch"
      ) ?? "")
    : current;
}
if (!semver.valid(version)) {
  fail(`"${version}" is not a valid version`);
}
const tag = `${TAG_PREFIX}${version}`;
if (git("tag", "--list", tag) !== "") {
  fail(`tag ${tag} already exists`);
}

// Only the version line changes, so the rest of package.json keeps its formatting.
writeFileSync(
  "package.json",
  manifest.replace(/("version":\s*")[^"]+"/u, `$1${version}"`)
);

// A section already written for this version (e.g. the curated first release) is kept.
// Otherwise the commits since the last tag are labelled with package.json's version.
const changelog = readFileSync("CHANGELOG.md", "utf-8");
const hasSection = changelog
  .split("\n")
  .some((line) => /^## \[?([^\]\s(]+)/u.exec(line)?.[1] === version);
if (!hasSection) {
  const section = conventional(
    "conventional-changelog",
    "--infile",
    "/dev/null",
    "--release-count",
    "1",
    "--output-unreleased",
    "--stdout"
  );
  const [head = "", ...releases] = changelog.split(/^(?=## )/mu);
  writeFileSync("CHANGELOG.md", `${head}${section}\n\n${releases.join("")}`);
}

git("add", "package.json", "CHANGELOG.md");
// Nothing to commit when the version and its changelog section were already in place.
if (git("diff", "--cached", "--name-only") !== "") {
  git("commit", "-m", `chore(release): ${tag}`);
}
git("tag", "-a", tag, "-m", tag);

process.stdout.write(
  `Prepared ${tag}. Review the commit, then publish with:\n  git push origin main ${tag}\n`
);
