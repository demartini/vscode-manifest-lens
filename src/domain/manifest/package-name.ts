const PACKAGE_NAME =
  /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u;

export const isValidPackageName = (name: string): boolean =>
  name.length > 0 && name.length <= 214 && PACKAGE_NAME.test(name);

/** Extracts the package name from an `overrides`/`resolutions` key. */
export const overrideTargetName = (key: string): string | undefined => {
  if (key.includes(">")) {
    return undefined;
  }
  const stripped = key.startsWith("**/") ? key.slice(3) : key;
  const versionAt = stripped.startsWith("@")
    ? stripped.indexOf("@", 1)
    : stripped.indexOf("@");
  const name = versionAt > 0 ? stripped.slice(0, versionAt) : stripped;
  return isValidPackageName(name) ? name : undefined;
};
