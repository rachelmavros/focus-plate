// /api/extract-recipe.js
//
// Vercel Serverless Function — handles two input modes that DON'T have
// schema.org structured data to lean on:
//   1. Raw pasted text (copied from an AI chat, a text message, a note, etc.)
//   2. A TikTok/Instagram link — we try to pull the caption text via oEmbed,
//      then run that caption through the same LLM extraction as pasted text.
//
// Both paths end up calling Anthropic's API to turn free text into the same
// recipe JSON shape /api/parse-recipe.js produces, so the frontend can
// render either source identically.
//
// USAGE:
//   POST /api/extract-recipe
//   body: { text: "..." }                     -> straight text extraction
//   body: { socialUrl: "https://tiktok.com/..." } -> fetch caption, then extract
//
// Returns JSON shaped like parse-recipe.js's output:
// {
//   title, sourceUrl, sourceName, image, meta: { prep, cook, total, yield },
//   ingredients: [{ id, amount, name, raw }],
//   steps: [{ text, parts: [string | {ing: id}], timer }]
// }
//
// REQUIRES: an ANTHROPIC_API_KEY environment variable set in Vercel
// (Project Settings -> Environment Variables). Get one at console.anthropic.com.

// An error whose .message is safe (and useful) to show directly to the user,
// as opposed to a raw/unexpected exception where we don't want to leak
// internals — see the catch block in the handler below.
class KnownError extends Error {}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST for this endpoint.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'Text/link import isn\'t set up yet — this needs an ANTHROPIC_API_KEY added in Vercel\'s Environment Variables.'
    });
  }

  const { text, socialUrl } = req.body || {};

  if (!text && !socialUrl) {
    return res.status(400).json({ error: 'Provide either "text" (pasted recipe) or "socialUrl" (a TikTok/Instagram link).' });
  }

  try {
    let rawText = text;
    let sourceUrl = null;
    let sourceName = 'Pasted recipe';
    let platform = null;

    if (socialUrl) {
      if (!isValidUrl(socialUrl)) {
        return res.status(400).json({ error: 'That link doesn\'t look valid.' });
      }
      platform = detectPlatform(socialUrl);
      if (!platform) {
        return res.status(400).json({
          error: 'That link isn\'t a TikTok or Instagram URL. Paste the recipe text directly instead.'
        });
      }

      const caption = await fetchCaption(socialUrl, platform);
      if (!caption) {
        return res.status(422).json({
          error: `Couldn't pull the caption text from that ${platform === 'tiktok' ? 'TikTok' : 'Instagram'} link — it may be private, or the recipe might only be spoken/shown on screen rather than in the caption. Try copying the caption text and pasting it directly instead.`
        });
      }

      rawText = caption;
      sourceUrl = socialUrl;
      sourceName = platform === 'tiktok' ? 'TikTok' : 'Instagram';
    }

    if (!rawText || rawText.trim().length < 20) {
      return res.status(422).json({
        error: 'That doesn\'t look like enough text to contain a recipe.'
      });
    }

    const recipe = await extractRecipeWithLLM(rawText);

    if (!recipe) {
      return res.status(422).json({
        error: 'Couldn\'t find a clear recipe (ingredients + steps) in that text.'
      });
    }

    const formatted = formatExtractedRecipe(recipe, { sourceUrl, sourceName });
    return res.status(200).json(formatted);

  } catch (err) {
    console.error(err);
    // Surface the real reason when we raised it ourselves (bad/missing API key,
    // deprecated model, Anthropic API error, etc.) instead of masking it with a
    // generic message — that made this impossible to debug from the frontend.
    const message = err instanceof KnownError ? err.message : 'Something went wrong extracting that recipe. Check your Vercel function logs for details.';
    return res.status(500).json({ error: message });
  }
}

/* ============================================================
   Detect platform + fetch caption via oEmbed
   ============================================================ */
function detectPlatform(url) {
  const host = new URL(url).hostname.replace('www.', '');
  if (host.includes('tiktok.com')) return 'tiktok';
  if (host.includes('instagram.com')) return 'instagram';
  return null;
}

// Follows a shortened TikTok share link (tiktok.com/t/..., vm.tiktok.com/...)
// to its canonical /@user/video/123... URL. Falls back to the original URL
// if anything goes wrong, so this never blocks the rest of the flow.
async function resolveTikTokRedirect(url) {
  const isShortLink = /\/t\/|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url);
  if (!isShortLink) return url;

  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FocusPlateBot/1.0)' }
    });
    return r.url || url;
  } catch (err) {
    console.error('Could not resolve TikTok short link, using original URL:', err);
    return url;
  }
}

async function fetchCaption(url, platform) {
  if (platform === 'tiktok') {
    // Share links (tiktok.com/t/XXXXX, or vm.tiktok.com/XXXXX) are shortened
    // redirects — TikTok's oEmbed endpoint frequently fails on those and
    // needs the canonical /@user/video/123... URL instead. Resolve the
    // redirect ourselves first.
    const canonicalUrl = await resolveTikTokRedirect(url);

    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl)}`;
    try {
      const r = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FocusPlateBot/1.0)' }
      });
      if (!r.ok) {
        console.error('TikTok oEmbed failed:', r.status, await r.text().catch(() => ''));
        return null;
      }
      const data = await r.json();
      return data.title || null;
    } catch (err) {
      console.error('TikTok oEmbed request threw:', err);
      return null;
    }
  }

  if (platform === 'instagram') {
    // Instagram's oEmbed requires an access token for most apps now, and
    // frequently doesn't return caption text even when it succeeds. We try
    // it, but this is expected to fail often — that's a known limitation.
    const oembedUrl = `https://api.instagram.com/oembed?url=${encodeURIComponent(url)}`;
    try {
      const r = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FocusPlateBot/1.0)' }
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data.title || null;
    } catch {
      return null;
    }
  }

  return null;
}

/* ============================================================
   LLM extraction: free text -> structured recipe
   ============================================================ */
async function extractRecipeWithLLM(rawText) {
  const prompt = `Extract a recipe from the text below and return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "title": string,
  "prep": string | null,       // e.g. "15 min", null if not stated
  "cook": string | null,
  "total": string | null,
  "yield": string | null,      // e.g. "4 servings"
  "ingredients": [ { "amount": string | null, "name": string } ],
  "steps": [ string ]          // each a single instruction, split into reasonably short steps
}

Rules:
- If the text is not actually a recipe (no ingredients/steps you can identify), return exactly: {"error": "not_a_recipe"}
- Keep ingredient "name" as just the ingredient (e.g. "flour", not "2 cups flour") and put the quantity in "amount".
- Break long run-on instructions into multiple shorter steps.
- Do not invent ingredients, quantities, or steps that aren't in the text.
- Return raw JSON only.

TEXT:
"""
${rawText.slice(0, 8000)}
"""`;

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // .trim() guards against a stray trailing newline/space from copy-pasting
        // the key into Vercel's env var UI, which would otherwise send an
        // invalid key and fail with a confusing 401.
        'x-api-key': (process.env.ANTHROPIC_API_KEY || '').trim(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (networkErr) {
    // A network-level failure (DNS, timeout, connection reset, etc.) throws
    // here rather than giving us a response object — without this catch, that
    // exception skipped every specific error message below and fell through
    // to the handler's generic catch-all, which is the bug that was hiding
    // the real cause of failures.
    console.error('Anthropic API request failed at the network level:', networkErr);
    throw new KnownError(`Couldn't reach the Anthropic API: ${networkErr.message}`);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('Anthropic API error:', response.status, errBody);

    if (response.status === 401) {
      throw new KnownError('The Anthropic API key in Vercel is missing or invalid — double check ANTHROPIC_API_KEY in Project Settings > Environment Variables, then redeploy.');
    }
    if (response.status === 404) {
      throw new KnownError('The AI model this app requests is unavailable for your API key — it may need to be updated to a current model name.');
    }
    if (response.status === 429) {
      throw new KnownError('Rate limited or out of credits on the Anthropic API — check usage/billing at console.anthropic.com.');
    }
    throw new KnownError(`Recipe extraction service failed (status ${response.status}). Check your Vercel function logs for details.`);
  }

  const data = await response.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  if (!textBlock) return null;

  let parsed;
  try {
    // Strip accidental markdown fences just in case
    const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (parsed.error === 'not_a_recipe') return null;
  if (!parsed.ingredients?.length || !parsed.steps?.length) return null;

  return parsed;
}

/* ============================================================
   Reshape LLM output into the app's recipe object, reusing the
   same ingredient-inline-highlighting logic as parse-recipe.js
   ============================================================ */
function formatExtractedRecipe(recipe, { sourceUrl, sourceName }) {
  const ingredients = recipe.ingredients.map((ing, idx) => ({
    id: `ing${idx}`,
    amount: ing.amount || null,
    name: ing.name,
    raw: ing.amount ? `${ing.amount} ${ing.name}` : ing.name,
  }));

  const steps = recipe.steps.map(stepText => buildStepParts(stepText, ingredients));

  return {
    title: recipe.title || 'Untitled Recipe',
    sourceUrl: sourceUrl || null,
    sourceName: sourceName || 'Pasted recipe',
    image: null,
    meta: {
      prep: recipe.prep || null,
      cook: recipe.cook || null,
      total: recipe.total || null,
      yield: recipe.yield || null,
    },
    ingredients,
    steps,
  };
}

/* ----- Match ingredients inline within each step's text (same approach as parse-recipe.js) ----- */
const STOPWORDS = new Set(['of', 'and', 'to', 'taste', 'the', 'a', 'an', 'or', 'plus']);

function buildStepParts(stepText, ingredients) {
  const timer = extractTimer(stepText);

  const matchers = ingredients
    .map(ing => ({ ...ing, candidates: keywordCandidates(ing.name) }))
    .filter(ing => ing.candidates.length > 0);

  let remaining = stepText;
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
          break;
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

// Every individual word is a candidate, not just the last one — recipe
// steps sometimes refer to an ingredient by its generic noun ("the butter"
// for "unsalted butter") and sometimes by its distinctive/brand-like word
// instead ("Worcestershire" or "Dijon" for "Worcestershire sauce" / "Dijon
// mustard"), so both directions need to be checked.
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
