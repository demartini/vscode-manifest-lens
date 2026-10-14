export interface LinePosition {
  readonly line: number;
  readonly character: number;
}

/** Builds an offset → (line, character) converter for a text snapshot. */
export function createPositionMapper(
  text: string
): (offset: number) => LinePosition {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return (offset) => {
    const clamped = Math.min(Math.max(offset, 0), text.length);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] ?? 0) <= clamped) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return { character: clamped - (starts[low] ?? 0), line: low };
  };
}
