const SITE_ALIASES: Record<string, string> = {
  youtube: "https://www.youtube.com/",
  "you tube": "https://www.youtube.com/",
};

export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value) return value;
  const alias = SITE_ALIASES[value.toLowerCase()];
  if (alias) return alias;
  if (/^about:blank$/i.test(value)) return "about:blank";
  // Local file URLs are served over localhost by the backend but keep their
  // file:// form here so they are never mistaken for a search query.
  if (/^file:\/\//i.test(value)) return `file://${value.slice("file://".length)}`;
  // An absolute POSIX path is a local file the user meant to open.
  if (value.startsWith("/")) return `file://${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/\S*)?$/i.test(value)) {
    return `http://${value}`;
  }
  if (/^[\w-]+(?:\.[\w.-]+)+(?:\/\S*)?$/i.test(value)) {
    return `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
