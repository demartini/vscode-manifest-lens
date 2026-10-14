import { access, readFile } from "node:fs/promises";

import type { FileProbe } from "../package-manager/detect";

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
};

export const nodeFileProbe: FileProbe = { exists, readText };
