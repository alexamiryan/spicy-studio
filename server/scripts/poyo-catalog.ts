/**
 * Builds the PoYo model catalog (`src/providers/poyo-catalog.json`).
 *
 * PoYo has no catalog endpoint, so this reads what PoYo publishes:
 * - the pricing page, which embeds every product (name, vendor, category, model ids, doc link, price tiers);
 * - each product's API doc page, which embeds an OpenAPI spec with the JSON Schema of `input`.
 *
 * Run `npm run poyo:catalog -w server` to pick up new PoYo models, then review the diff and commit.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const PRICING_URL = 'https://poyo.ai/pricing';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/providers/poyo-catalog.json');
const CATEGORIES = new Set(['Image', 'Video']);

interface Product {
  id: string; name: string; provider?: string; category?: string; tasks?: string[]; models?: string[]; doc?: string;
  pricingTiers?: Record<string, unknown>[];
}

/** Parse the JSON object that starts at `start` (string-aware brace matching). */
function objectAt(text: string, start: number): unknown {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated object');
}

async function products(): Promise<Product[]> {
  const html = await (await fetch(PRICING_URL)).text();
  // The page data is embedded as an escaped JS string.
  const text = html.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  const found = new Map<string, Product>();
  for (const m of text.matchAll(/\{"id":"([a-z0-9.\-]+)","name":/g)) {
    try {
      const obj = objectAt(text, m.index!) as Product;
      if (obj.pricingTiers && !found.has(obj.id)) found.set(obj.id, obj);
    } catch { /* not a product object */ }
  }
  return [...found.values()].filter(p => CATEGORIES.has(p.category || '') && p.doc);
}

/** Inline local `$ref`s so the schema is self-contained. */
function resolve(node: any, root: any, seen = new Set<string>()): any {
  if (Array.isArray(node)) return node.map(n => resolve(n, root, seen));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (seen.has(node.$ref)) return {};
    const target = node.$ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k], root);
    return resolve(target, root, new Set([...seen, node.$ref]));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolve(v, root, seen)]));
}

async function docSchema(doc: string) {
  const md = await (await fetch(`${doc.replace(/\.md$/, '')}.md`)).text();
  const block = /````yaml[^\n]*\n([\s\S]*?)\n````/.exec(md)?.[1];
  if (!block) throw new Error('no OpenAPI block');
  const spec: any = loadYaml(block);
  const post = spec?.paths?.['/api/generate/submit']?.post;
  const schema = resolve(post?.requestBody?.content?.['application/json']?.schema, spec);
  const input = schema?.properties?.input;
  if (!input?.properties) throw new Error('no input schema');
  const modelProp = schema.properties.model || {};
  const models: string[] = modelProp.enum || (modelProp.default ? [modelProp.default] : modelProp.example ? [modelProp.example] : []);
  // Descriptions mention which variant needs what ("Required for seedream-4.5-edit"); keep them.
  return { models, input, modelDescription: modelProp.description as string | undefined };
}

const list = await products();
const catalog = [];
for (const p of list) {
  try {
    const { models, input, modelDescription } = await docSchema(p.doc!);
    const ids = models.length ? models : p.models || [];
    if (!ids.length) throw new Error('no model ids');
    catalog.push({
      id: p.id, name: p.name, vendor: p.provider, modality: p.category === 'Video' ? 'video' : 'image',
      tasks: p.tasks || [], doc: p.doc, models: ids, modelDescription, input,
      pricing: (p.pricingTiers || []).map(t => Object.fromEntries(Object.entries(t).filter(([k]) => !/comparison|priceUSD/.test(k)))),
    });
    console.log(`ok   ${p.id} (${ids.join(', ')})`);
  } catch (error) {
    console.warn(`skip ${p.id}: ${(error as Error).message}`);
  }
}
catalog.sort((a, b) => a.modality.localeCompare(b.modality) || a.name.localeCompare(b.name));
await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: PRICING_URL, products: catalog }, null, 1) + '\n');
console.log(`wrote ${catalog.length} products to ${path.relative(process.cwd(), OUT)}`);
