import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

const marked = new Marked({ gfm: true, breaks: true });

// Allow the markdown subset GitHub renders, plus the few raw tags users
// commonly rely on in review comments.
const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "details",
  "summary",
  "input", // GFM task-list checkboxes
  "span",
  "sub",
  "sup",
  "kbd",
];

const ALLOWED_ATTRS: sanitizeHtml.IOptions["allowedAttributes"] = {
  a: ["href", "name", "target", "rel", "title"],
  img: ["src", "alt", "title", "width", "height"],
  input: ["type", "checked", "disabled"],
  code: ["class"],
  pre: ["class"],
  span: ["class"],
};

export function renderMarkdown(body: string): string {
  if (!body) return "";
  const rawHtml = marked.parse(body, { async: false }) as string;
  return sanitizeHtml(rawHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: "a",
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
    },
  });
}
