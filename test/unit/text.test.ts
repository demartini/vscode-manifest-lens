import * as assert from "node:assert/strict";

import { createPositionMapper } from "../../src/shared/utilities/text";

describe("createPositionMapper", () => {
  const text = "ab\ncde\n\nf";
  const at = createPositionMapper(text);

  it("maps offsets to line and character", () => {
    assert.deepEqual(at(0), { character: 0, line: 0 });
    assert.deepEqual(at(2), { character: 2, line: 0 });
    assert.deepEqual(at(3), { character: 0, line: 1 });
    assert.deepEqual(at(5), { character: 2, line: 1 });
    assert.deepEqual(at(7), { character: 0, line: 2 });
    assert.deepEqual(at(8), { character: 0, line: 3 });
    assert.deepEqual(at(9), { character: 1, line: 3 });
  });

  it("clamps out-of-range offsets", () => {
    assert.deepEqual(at(-5), { character: 0, line: 0 });
    assert.deepEqual(at(999), { character: 1, line: 3 });
  });
});
