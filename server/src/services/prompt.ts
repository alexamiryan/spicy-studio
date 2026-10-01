export interface ElementDef { name: string; refIds: string[] }

export interface ResolvedPrompt {
  prompt: string;
  /** Final ordered ref ids for the primary reference field. */
  refs: string[];
  /** Elements that were mentioned (lower-case names). */
  usedElements: string[];
}

// `@name` not preceded by a word character (so e-mail addresses are left alone).
export const MENTION = /(^|[^\w@])@([A-Za-z][\w-]*)/g;
const IMAGE_TOKEN = /^(?:image|img|ref)(\d+)$/i;

function describe(positions: number[]) {
  return positions.map(n => `image ${n}`).join(', ');
}

/**
 * Expand `@Element` mentions into their reference images (appended after the manually attached
 * refs, deduplicated) and rewrite every mention into the positional wording models understand:
 * `@image2` → `image 2`, `@Mia` → `image 3, image 4`.
 */
export function resolvePrompt(prompt: string, attached: string[], elements: ElementDef[], native = false): ResolvedPrompt {
  const byName = new Map(elements.map(e => [e.name.toLowerCase(), e]));
  const refs = [...attached];
  const usedElements: string[] = [];
  const text = prompt.replace(MENTION, (match, lead: string, name: string) => {
    const image = IMAGE_TOKEN.exec(name);
    if (image) return `${lead}image ${Number(image[1])}`;
    const element = byName.get(name.toLowerCase());
    if (!element) return match;
    if (!usedElements.includes(name.toLowerCase())) usedElements.push(name.toLowerCase());
    // Providers that take elements themselves get the mention as written (in the element's own spelling).
    if (native) return `${lead}@${element.name}`;
    const positions = element.refIds.map(id => {
      let index = refs.indexOf(id);
      if (index < 0) { refs.push(id); index = refs.length - 1; }
      return index + 1;
    });
    return positions.length ? `${lead}${describe(positions)}` : match;
  });
  return { prompt: text, refs, usedElements };
}
