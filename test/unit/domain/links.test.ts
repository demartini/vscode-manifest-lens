import * as assert from "node:assert/strict";

import {
  npmVersionsUrl,
  releasesUrl,
} from "../../../src/domain/dependency/links";

describe("releasesUrl", () => {
  it("links the releases page of GitHub and GitLab repositories", () => {
    assert.equal(
      releasesUrl("https://github.com/o/r"),
      "https://github.com/o/r/releases"
    );
    assert.equal(
      releasesUrl("https://gitlab.com/o/r"),
      "https://gitlab.com/o/r/-/releases"
    );
  });

  it("ignores a directory or branch the repository URL may carry", () => {
    assert.equal(
      releasesUrl("https://github.com/o/r/tree/main/packages/x"),
      "https://github.com/o/r/releases"
    );
  });

  it("does not guess for other hosts or invalid values", () => {
    for (const value of [
      "https://bitbucket.org/o/r",
      "https://example.com/o/r",
      "https://github.com/onlyowner",
      "not a url",
      undefined,
    ]) {
      assert.equal(releasesUrl(value), undefined, String(value));
    }
  });
});

describe("npmVersionsUrl", () => {
  it("points at the versions tab of the package page", () => {
    assert.equal(
      npmVersionsUrl("@scope/pkg"),
      "https://www.npmjs.com/package/@scope/pkg?activeTab=versions"
    );
  });
});
