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
  const steps = rawSteps.map(stepText => buildStepParts(stepText, ingredients));

  return {
    title: recipe.name || 'Untitled Recipe',
    sourceUrl,
    sourceName: new URL(sourceUrl).hostname.replace('www.', ''),
    image: extractImage(recipe.image),
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

function extractImage(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return extractImage(image[0]);
  if (image.url) return image.url;
  return null;
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
    const text = String(raw).trim();

    // Grab a leading numeric quantity (handles "1", "1 1/2", "1/2", "1-2")
    const qtyMatch = text.match(/^([\d]+(?:\s+\d+\/\d+|\.\d+|\/\d+)?(?:\s*[-–]\s*\d+(?:\s+\d+\/\d+|\.\d+|\/\d+)?)?)\s*/);
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
      raw: text,
    };
  });
}

/* ----- Instructions: handle string / HowToStep[] / HowToSection[] ----- */
function normalizeInstructions(instructions) {
  if (!instructions) return [];
  let rawSteps = [];

  if (typeof instructions === 'string') {
    rawSteps = instructions
      .split(/\n+|(?:\d+\.\s)/)
      .map(s => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(instructions)) {
    const steps = [];
    for (const item of instructions) {
      if (typeof item === 'string') {
        steps.push(item.trim());
      } else if (item['@type'] === 'HowToSection' && Array.isArray(item.itemListElement)) {
        steps.push(...normalizeInstructions(item.itemListElement));
      } else if (item.text) {
        steps.push(item.text.trim());
      }
    }
    rawSteps = steps.filter(Boolean);
  }

  // Many recipe sites cram several actions into one long instruction paragraph.
  // Break those up into shorter, more scannable sub-steps.
  const expanded = [];
  for (const step of rawSteps) {
    expanded.push(...splitLongStep(step));
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

function buildStepParts(stepText, ingredients) {
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

  return { parts, timer, rawText: stepText };
}

// Builds a list of match candidates for an ingredient name, ordered from most
// specific (full name) to least specific (just the last meaningful word),
// since recipe steps often refer to ingredients more casually than the
// ingredient list does (e.g. "the butter" instead of "unsalted butter").
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
  if (words.length >= 1) {
    const last = words[words.length - 1];
    if (last.length > 2) candidates.add(last);
  }

  // Longest first so we prefer the most specific match when multiple match
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
