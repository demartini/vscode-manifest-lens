/** The releases page of a repository, only for hosts whose layout is known. */
export function releasesUrl(
  repositoryUrl: string | undefined
): string | undefined {
  if (repositoryUrl === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    return undefined;
  }
  const [owner, name] = url.pathname.split("/").filter(Boolean);
  if (owner === undefined || name === undefined) {
    return undefined;
  }
  if (url.hostname === "github.com") {
    return `https://github.com/${owner}/${name}/releases`;
  }
  return url.hostname === "gitlab.com"
    ? `https://gitlab.com/${owner}/${name}/-/releases`
    : undefined;
}

export const npmVersionsUrl = (name: string): string =>
  `https://www.npmjs.com/package/${name}?activeTab=versions`;
