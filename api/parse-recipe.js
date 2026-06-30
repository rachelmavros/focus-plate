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

  if (typeof instructions === 'string') {
    // Some sites just dump one big string — split on line breaks or numbered steps
    return instructions
      .split(/\n+|(?:\d+\.\s)/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  if (Array.isArray(instructions)) {
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
    return steps.filter(Boolean);
  }

  return [];
}

/* ----- Match ingredients inline within each step's text ----- */
function buildStepParts(stepText, ingredients) {
  const timer = extractTimer(stepText);

  // Build a list of {id, amount, name, keyword} sorted by keyword length (longest first)
  // so we match "baby bella mushrooms" before just "mushroom"
  const matchers = ingredients
    .map(ing => ({ ...ing, keyword: coreKeyword(ing.name) }))
    .filter(ing => ing.keyword.length > 2)
    .sort((a, b) => b.keyword.length - a.keyword.length);

  let remaining = stepText;
  const parts = [];
  const matchedIds = new Set();

  // Simple greedy scan: find earliest occurring matcher each loop
  while (remaining.length) {
    let earliest = null;
    let earliestIdx = Infinity;

    for (const m of matchers) {
      if (matchedIds.has(m.id)) continue; // each ingredient highlighted once per step
      const idx = findWordIndex(remaining, m.keyword);
      if (idx !== -1 && idx < earliestIdx) {
        earliestIdx = idx;
        earliest = m;
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

    remaining = remaining.slice(earliestIdx + earliest.keyword.length);
  }

  return { parts, timer, rawText: stepText };
}

function coreKeyword(name) {
  // Strip common prep words so matching focuses on the actual food item
  return name
    .replace(/\b(fresh|freshly|chopped|minced|sliced|diced|softened|melted|grated|packed|large|small|medium|room temperature|optional|to taste|cracked)\b/gi, '')
    .trim()
    .split(',')[0]
    .trim();
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
