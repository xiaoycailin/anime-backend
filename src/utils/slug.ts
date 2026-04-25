// utils/slug.ts
export function extractSlug(href: string): string {
  try {
    return (
      new URL(href).pathname
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .pop() ?? ""
    );
  } catch {
    return href;
  }
}

export function toAnimeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}
