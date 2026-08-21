const GERRIT_UI_PATH_MARKERS = ["/c/", "/q/", "/dashboard/", "/admin/", "/settings/", "/plugins/"];
const GERRIT_API_PATH_MARKERS = ["/changes/", "/accounts/", "/projects/"];

export function normalizeGerritServer(input: string) {
  const trimmed = input.trim();
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid Gerrit server URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP or HTTPS Gerrit server URL.");
  if (url.username || url.password) throw new Error("Do not include credentials in the Gerrit server URL.");

  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  const markerPositions = [...GERRIT_UI_PATH_MARKERS, ...GERRIT_API_PATH_MARKERS]
    .map((marker) => pathname.indexOf(marker))
    .filter((position) => position >= 0);
  const rootEnd = markerPositions.length > 0 ? Math.min(...markerPositions) : pathname.length;
  url.pathname = `${pathname.slice(0, rootEnd).replace(/\/+$/, "")}/`;
  return url;
}
