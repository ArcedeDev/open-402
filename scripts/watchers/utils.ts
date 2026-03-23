/** Extract hostname from a URL, handling edge cases. Strips www. to normalize. */
export function extractDomain(url: string): string | null {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    let hostname = new URL(normalized).hostname.toLowerCase();
    if (!hostname || hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      return null;
    }
    // Normalize: strip www. prefix to avoid duplicates (www.example.com → example.com)
    if (hostname.startsWith("www.")) {
      hostname = hostname.slice(4);
    }
    return hostname;
  } catch {
    return null;
  }
}
