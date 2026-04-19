export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function pluralize(
  n: number,
  singular: string,
  plural: string = singular + "s",
): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
