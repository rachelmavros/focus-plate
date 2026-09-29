// /api/parse-recipe.js
//
// Vercel Serverless Function — no build step needed, Vercel auto-detects
// anything in /api as a function on deploy.
//
// USAGE (once deployed):
//   GET /api/parse-recipe?url=https://example.com/some-recipe
//
// Returns JSON shaped like:
// {
//   title, sourceUrl, sourceName, image, meta: { prep, cook, total, yield },
//   ingredients: [{ id, amount, name, raw }],
//   steps: [{ text, parts: [string | {ing: id}], timer }]
// }

export default async function handler(req, res) {
  // Allow your frontend (same project or different origin) to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid ?url= parameter.' });
  }

  try {
    const pageResponse = await fetch(url, {
      headers: {
        // Some sites block requests with no user-agent
        'User-Agent': 'Mozilla/5.0 (compatible; FocusPlateBot/1.0; +https://example.com)'
      },
      redirect: 'follow'
    });

    if (!pageResponse.ok) {
      return res.status(502).json({ error: `Could not fetch that page (status ${pageResponse.status}).` });
    }

    const html = await pageResponse.text();
    const recipe = extractRecipeSchema(html);

    if (!recipe) {
      return res.status(422).json({
        error: "We couldn't find structured recipe data on that page. This site might not support auto-import yet — try a different recipe blog."
      });
    }

    const formatted = formatRecipe(recipe, url);
    return res.status(200).json(formatted);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong fetching or parsing that recipe.' });
  }
}

/* ============================================================
   STEP 1: Pull schema.org Recipe JSON-LD out of the raw HTML
   ============================================================ */
function extractRecipeSchema(html) {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  const candidates = [];

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1].trim());
      candidates.push(json);
    } catch (e) {
      // Some sites embed multiple JSON objects or malformed JSON — skip those blocks
      continue;
    }
  }

  // JSON-LD can be: a single object, an array, or wrapped in @graph
  for (const candidate of candidates) {
    const found = findRecipeNode(candidate);
    if (found) return found;
  }
  return null;
}

function findRecipeNode(node) {
  if (!node) return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof node === 'object') {
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('Recipe')) return node;

    if (node['@graph']) return findRecipeNode(node['@graph']);
  }

  return null;
}

/* ============================================================
   STEP 2: Normalize the raw schema into our app's shape
   ============================================================ */
function formatRecipe(recipe, sourceUrl) {
  const ingredients = normalizeIngredients(recipe.recipeIngredient || recipe.ingredients || []);
  const rawSteps = normalizeInstructions(recipe.recipeInstructions);
  const steps = rawSteps.map(step => buildStepParts(step.text, ingredients, step.image));

  return {
    title: decodeEntities(recipe.name || 'Untitled Recipe'),
    sourceUrl,
    sourceName: new URL(sourceUrl).hostname.replace('www.', ''),
    image: extractImage(recipe.image),
    rating: extractRating(recipe.aggregateRating),
    meta: {
      prep: isoDurationToText(recipe.prepTime),
      cook: isoDurationToText(recipe.cookTime),
      total: isoDurationToText(recipe.totalTime),
      yield: recipe.recipeYield ? String(recipe.recipeYield) : null,
    },
    ingredients,
    steps,
  };
}

// Sites often publish several sizes of the same photo in their schema.org
// data (a WordPress responsive-image srcset baked into the JSON-LD, for
// example) with no guaranteed ordering — picking the wrong one is what made
// some sites' photos (Sally's Baking Addiction in particular) come in
// blurry, since we were just grabbing whichever URL happened to be first,
// sometimes a ~150px thumbnail. This picks the highest-resolution one
// instead, using the ImageObject's width/height when present, or the
// WxH baked into the filename (a common WordPress pattern, e.g.
// "photo-1024x683.jpg") as a fallback.
function extractImage(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (image.url && !Array.isArray(image)) return image.url; // single ImageObject
  if (!Array.isArray(image)) return null;
  if (image.length === 1) return extractImage(image[0]);

  let best = null;
  let bestScore = -1;
  let lastUrl = null;
  let anyDims = false;
  for (const item of image) {
    const url = typeof item === 'string' ? item : item?.url;
    if (!url) continue;
    lastUrl = url;
    let score = 0;
    if (typeof item === 'object' && item.width && item.height) {
      score = Number(item.width) * Number(item.height);
    } else {
      const dims = /-(\d+)x(\d+)\.\w+(?:$|\?)/.exec(url);
      if (dims) score = Number(dims[1]) * Number(dims[2]);
    }
    if (score > 0) anyDims = true;
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  // If none of the URLs had any discoverable dimensions, fall back to the
  // last entry — sites that don't tag sizes tend to list smallest-first.
  return anyDims ? best : (lastUrl || best);
}

function extractRating(aggregateRating) {
  if (!aggregateRating) return null;
  const value = parseFloat(aggregateRating.ratingValue);
  const count = parseInt(aggregateRating.reviewCount || aggregateRating.ratingCount, 10);
  if (!value || isNaN(value)) return null;
  return { value, count: isNaN(count) ? null : count };
}

function isoDurationToText(iso) {
  if (!iso) return null;
  // Matches ISO 8601 durations like PT1H15M
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  if (!match) return null;
  const hours = match[1] ? parseInt(match[1]) : 0;
  const mins = match[2] ? parseInt(match[2]) : 0;
  if (!hours && !mins) return null;
  let text = '';
  if (hours) text += `${hours} hr `;
  if (mins) text += `${mins} min`;
  return text.trim();
}

/* ----- Ingredients: split "1 1/2 cups mashed banana" into amount + name ----- */
function normalizeIngredients(rawList) {
  const UNIT_PATTERN = /^(cups?|tablespoons?|tbsp\.?|teaspoons?|tsp\.?|ounces?|oz\.?|pounds?|lbs?\.?|grams?|g|kilograms?|kg|milliliters?|ml|liters?|l|cloves?|slices?|cans?|packages?|pinch(es)?|stick(s)?|large|medium|small)$/i;

  return rawList.map((raw, idx) => {
    const text = decodeEntities(String(raw).trim());

    // Grab a leading numeric quantity (handles "1", "1 1/2", "1/2", "1-2",
    // "2 and 1/4" / "1 and 1/2" (the word-form fraction some sites use
    // instead of "1 1/2"), and unicode fraction glyphs like "1½" or "½" on
    // their own)
    const FRAC = '¼½¾⅐-⅞'; // ¼ ½ ¾ ⅐ ... ⅞
    const qtyMatch = text.match(new RegExp(
      `^((?:[\\d]+[${FRAC}]?|[${FRAC}])(?:\\s+(?:and\\s+)?\\d+\\/\\d+|\\.\\d+|\\/\\d+)?(?:\\s*[-–]\\s*\\d+(?:\\s+\\d+\\/\\d+|\\.\\d+|\\/\\d+)?)?)\\s*`
    ));
    let amount = '';
    let rest = text;

    if (qtyMatch) {
      amount = qtyMatch[1].trim();
      rest = text.slice(qtyMatch[0].length).trim();
    }

    // Grab a unit immediately following the quantity, if present
    const words = rest.split(' ');
    if (words.length && UNIT_PATTERN.test(words[0].replace(/[(),.]/g, ''))) {
      amount = amount ? `${amount} ${words[0]}` : words[0];
      rest = words.slice(1).join(' ');
    }

    // Strip parenthetical asides like "(softened)" from the display name but keep core noun
    const name = rest.replace(/\s*\([^)]*\)\s*/g, ' ').trim() || rest;

    return {
      id: `ing${idx}`,
      amount: amount || null,
      name: name || text,
      shortName: shortIngredientName(name || text),
      raw: text,
    };
  });
}

// A trimmed-down version of the ingredient name for the inline highlight
// chip shown *within instructions* — the full ingredient list keeps every
// detail ("3 large yellow onions, thinly sliced"), but repeating "thinly
// sliced" or "at room temperature" every time that ingredient is mentioned
// in a step just adds clutter, since the prep/serving note isn't needed
// again there. The full ingredient list is untouched by this.
const TRAILING_PREP_NOTES = new RegExp(
  '\\s*,?\\s*\\b(' + [
    'at room temperature', 'room temperature', 'thinly sliced', 'finely chopped', 'finely diced',
    'finely minced', 'roughly chopped', 'coarsely chopped', 'coarsely ground', 'julienned',
    'grated', 'shredded', 'cubed', 'halved', 'quartered', 'crushed', 'peeled', 'zested',
    'for garnish', 'for serving', 'for finishing', 'for topping', 'for dusting', 'for drizzling',
    'to taste', 'divided', 'plus more for serving', 'plus more to taste', 'optional',
  ].join('|') + ')\\b.*$',
  'i'
);

function shortIngredientName(name) {
  if (!name) return name;
  // Most recipe sites put prep/serving notes after a comma
  // ("yellow onions, thinly sliced") — take just the part before it.
  let short = name.split(',')[0].trim();
  // A few notes show up without a comma ("fresh thyme for finishing") —
  // strip those known trailing phrases too.
  short = short.replace(TRAILING_PREP_NOTES, '').trim();
  return short || name;
}

/* ----- Instructions: handle string / HowToStep[] / HowToSection[] -----
   Returns an array of { text, image } — image is null unless the site's
   schema.org data includes a photo for that specific step (some sites do
   this, most don't; it's a bonus when present, never required). */
function normalizeInstructions(instructions) {
  if (!instructions) return [];
  let rawSteps = [];

  if (typeof instructions === 'string') {
    rawSteps = decodeEntities(instructions)
      .split(/\n+|(?:\d+\.\s)/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(text => ({ text, image: null }));
  } else if (Array.isArray(instructions)) {
    const steps = [];
    for (const item of instructions) {
      if (typeof item === 'string') {
        const text = decodeEntities(item.trim());
        if (text) steps.push({ text, image: null });
      } else if (item['@type'] === 'HowToSection' && Array.isArray(item.itemListElement)) {
        steps.push(...normalizeInstructions(item.itemListElement));
      } else if (item.text) {
        const text = decodeEntities(item.text.trim());
        if (text) steps.push({ text, image: extractImage(item.image) });
      }
    }
    rawSteps = steps;
  }

  // Many recipe sites cram several actions into one long instruction paragraph.
  // Break those up into shorter, more scannable sub-steps. Only the first
  // resulting chunk keeps the step's image, so it doesn't repeat on every
  // sub-step split from the same original instruction.
  const expanded = [];
  for (const step of rawSteps) {
    const chunks = splitLongStep(step.text);
    chunks.forEach((text, i) => {
      expanded.push({ text, image: i === 0 ? step.image : null });
    });
  }
  return expanded;
}

// Splits a long paragraph-style instruction into shorter chunks, grouping
// sentences together up to a target length rather than one-sentence-per-step
// (which would be too choppy for short sentences).
function splitLongStep(text, targetLen = 140) {
  if (text.length <= targetLen) return [text];

  // Split into sentences, being careful not to break on common abbreviations
  const sentences = text
    .replace(/\b(Tbsp|tbsp|tsp|oz|lb|min|hr|approx|e\.g)\./g, '$1__DOT__')
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(s => s.replace(/__DOT__/g, '.').trim())
    .filter(Boolean);

  if (sentences.length <= 1) return [text];

  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && (current.length + sentence.length + 1) > targetLen) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/* ----- Match ingredients inline within each step's text ----- */
const STOPWORDS = new Set(['of', 'and', 'to', 'taste', 'the', 'a', 'an', 'or', 'plus']);

function buildStepParts(stepText, ingredients, image = null) {
  const timer = extractTimer(stepText);

  const matchers = ingredients
    .map(ing => ({ ...ing, candidates: keywordCandidates(ing.name) }))
    .filter(ing => ing.candidates.length > 0);

  let remaining = stepText;
  let offset = 0; // tracks position of `remaining` within the original stepText
  const parts = [];
  const matchedIds = new Set();

  while (remaining.length) {
    let earliest = null;
    let earliestIdx = Infinity;
    let earliestLen = 0;

    for (const m of matchers) {
      if (matchedIds.has(m.id)) continue;
      for (const candidate of m.candidates) {
        const idx = findWordIndex(remaining, candidate);
        if (idx !== -1 && idx < earliestIdx) {
          earliestIdx = idx;
          earliest = m;
          earliestLen = candidate.length;
          break; // candidates are ordered longest/most-specific first; take first hit
        }
      }
    }

    if (!earliest) {
      parts.push(remaining);
      break;
    }

    const before = remaining.slice(0, earliestIdx);
    if (before) parts.push(before);

    parts.push({ ing: earliest.id });
    matchedIds.add(earliest.id);

    remaining = remaining.slice(earliestIdx + earliestLen);
  }

  return { parts, timer, rawText: stepText, image };
}

// Builds a list of match candidates for an ingredient name, ordered from most
// specific (full name) to least specific (any single meaningful word), since
// recipe steps often refer to ingredients more casually than the ingredient
// list does — sometimes by the generic noun ("the butter" for "unsalted
// butter"), sometimes by the distinctive/brand-like word instead of the noun
// ("Worcestershire" or "Dijon" for "Worcestershire sauce" / "Dijon mustard").
// So every individual word is a candidate, not just the last one.
function keywordCandidates(name) {
  const cleaned = name
    .replace(/\b(fresh|freshly|chopped|minced|sliced|diced|softened|melted|grated|packed|large|small|medium|whole|room temperature|optional|to taste|cracked|granulated|unsalted|salted)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(',')[0]
    .trim();

  if (!cleaned) return [];

  const words = cleaned.split(' ').filter(w => w && !STOPWORDS.has(w.toLowerCase()));
  const candidates = new Set();

  if (cleaned.length > 2) candidates.add(cleaned);
  if (words.length >= 2) candidates.add(words.slice(-2).join(' '));
  for (const w of words) {
    if (w.length > 2) candidates.add(w);
  }

  // Longest first so we prefer the most specific (multi-word) match when
  // one is present, falling back to single distinctive words otherwise.
  return Array.from(candidates).sort((a, b) => b.length - a.length);
}

function findWordIndex(text, keyword) {
  if (!keyword) return -1;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'i');
  const match = regex.exec(text);
  return match ? match.index : -1;
}

function extractTimer(text) {
  const match = /(\d+(?:[-–]\d+)?\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?))/i.exec(text);
  return match ? match[1] : null;
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// Recipe text from JSON-LD often contains HTML entities (&#8220; &amp; etc.)
// and stray HTML tags. Decode/strip them so steps read as clean plain text.
function decodeEntities(str) {
  if (!str) return str;
  return str
    // strip any leftover HTML tags (e.g. <a>, <strong>) some sites embed in steps
    .replace(/<[^>]+>/g, '')
    // numeric entities: decimal (&#8220;) and hex (&#x201C;)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    // named fraction entities some sites use instead of unicode glyphs directly
    .replace(/&frac12;/g, '½')
    .replace(/&frac14;/g, '¼')
    .replace(/&frac34;/g, '¾')
    .replace(/&frac13;/g, '⅓')
    .replace(/&frac23;/g, '⅔')
    .replace(/&frac18;/g, '⅛')
    .replace(/&frac38;/g, '⅜')
    .replace(/&frac58;/g, '⅝')
    .replace(/&frac78;/g, '⅞')
    // common named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    // collapse any double spaces left behind
    .replace(/\s{2,}/g, ' ')
    .trim();
}
