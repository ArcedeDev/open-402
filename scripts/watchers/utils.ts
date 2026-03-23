/** Extract hostname from a URL, handling edge cases. */
export function extractDomain(url: string): string | null {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const hostname = new URL(normalized).hostname;
    if (!hostname || hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      return null;
    }
    return hostname.toLowerCase();
  } catch {
    return null;
  }
}
