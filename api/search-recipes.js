// /api/search-recipes.js
//
// Live recipe search across a few chosen sites, using each site's built-in
// WordPress REST API (/wp-json/wp/v2/posts?search=...). This is far more
// reliable than scraping search-result HTML, since the JSON API is a stable,
// public, documented interface that WordPress sites expose by default.
//
// USAGE (once deployed):
//   GET /api/search-recipes?q=chocolate+chip
//
// Returns: { results: [{ title, url, image, source }] }
//
// IMPORTANT LIMITATION: this only works for WordPress-based sites. Big
// platforms like Allrecipes, NYT Cooking, Food Network, and The Pioneer
// Woman run on their own custom (non-WordPress) systems and have no
// equivalent public search API, so they can't be added here. They still
// work fine for direct-link import (paste the URL, or use a "Popular to
// start" card) since /api/parse-recipe.js reads schema.org data, which
// almost every recipe site publishes regardless of platform — that's just
// a different mechanism than this search endpoint uses.

// ============================================================
//  EDIT THIS LIST to add/remove sites you want to search.
//  - name:  shown to the user as the source label
//  - base:  the site's root URL (no trailing slash)
//  Any WordPress-based recipe site will work here. If a site ever stops
//  returning results, it may block bot traffic or use "plain" permalinks
//  (see restRoot fallback below) — just swap it out.
// ============================================================
const SITES = [
  { name: "Sally's Baking Addiction", base: "https://sallysbakingaddiction.com" },
  { name: "Budget Bytes", base: "https://www.budgetbytes.com" },
  { name: "Pinch of Yum", base: "https://pinchofyum.com" },
  { name: "Minimalist Baker", base: "https://minimalistbaker.com" },
  { name: "Damn Delicious", base: "https://damndelicious.net" },
  // Cookie and Kate, Gimme Some Oven, Love and Lemons, and The Woks of Life
  // were all removed — real recipe pages on those sites kept returning
  // 403s (or a page with no usable recipe data) when this app tried to
  // fetch them, even after fixing headers and request timing. Whatever the
  // exact cause on their end, direct-link import from them wasn't reliable,
  // so leaving them in search would just produce results that fail on
  // click. If you want to try one back in, add it here and test it.
  // Added for wider, more mainstream-recognizable coverage — all WordPress
  // blogs like the ones above, so search works the same way. As with the
  // rest of this list, unverified from my sandbox — report any that never
  // return results and I'll swap them.
  { name: 'Once Upon a Chef', base: 'https://www.onceuponachef.com' },
  { name: 'Skinnytaste', base: 'https://www.skinnytaste.com' },
  { name: "Natasha's Kitchen", base: 'https://natashaskitchen.com' },
  { name: 'Half Baked Harvest', base: 'https://www.halfbakedharvest.com' },
  { name: 'The Recipe Critic', base: 'https://therecipecritic.com' },
  { name: 'Spend With Pennies', base: 'https://www.spendwithpennies.com' },
  { name: 'Ambitious Kitchen', base: 'https://www.ambitiouskitchen.com' },
  // These two were live-tested (not guessed) — confirmed their wp-json
  // search API returns real results before adding them.
  { name: 'Two Peas & Their Pod', base: 'https://www.twopeasandtheirpod.com' },
];

const PER_SITE_RESULTS = 8; // fetch more raw candidates per site since relevance filtering below will drop a chunk of them

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Please provide a search term with ?q=' });
  }

  const query = q.trim();
  const queryWords = significantWords(query);

  // Query every site in parallel; one slow/broken site shouldn't block the rest.
  const perSite = await Promise.allSettled(
    SITES.map(site => searchSite(site, query))
  );

  let results = [];
  for (const outcome of perSite) {
    if (outcome.status === 'fulfilled' && Array.isArray(outcome.value)) {
      results.push(...outcome.value);
    }
  }

  // WordPress's built-in search matches the full post BODY, not just the
  // title, and has no real relevance ranking — so a post that merely
  // mentions a query word once in passing (or a "30 Best X Recipes"
  // roundup that name-drops dozens of dishes) ranks the same as an actual
  // dedicated recipe for that dish. Since we only control this endpoint,
  // not the target sites' search internals, we re-rank based on how well
  // each result's TITLE actually matches the query, which is a much
  // stronger relevance signal for "is this the recipe someone searched for."
  results = results
    .filter(r => !isRoundupTitle(r.title))
    .map(r => ({ ...r, _score: titleMatchScore(r.title, queryWords) }))
    .filter(r => r._score > 0); // drop titles with zero real overlap with the query

  // Interleave by source first (keeps variety among equal-relevance results),
  // then a stable sort by score brings the best title matches to the top
  // while preserving that interleaved order within each score tier.
  results = interleaveBySource(results);
  results.sort((a, b) => b._score - a._score);
  results = results.map(({ _score, ...r }) => r); // strip internal field before returning

  return res.status(200).json({ query, results });
}

async function searchSite(site, query) {
  const url =
    `${site.base}/wp-json/wp/v2/posts` +
    `?search=${encodeURIComponent(query)}` +
    `&per_page=${PER_SITE_RESULTS}` +
    `&orderby=relevance` +
    `&_embed=wp:featuredmedia`;

  try {
    const response = await fetchWithTimeout(url, 7000);
    if (!response.ok) return [];

    const posts = await response.json();
    if (!Array.isArray(posts)) return [];

    return posts.map(post => ({
      title: decodeEntities(post?.title?.rendered || 'Untitled'),
      url: post?.link,
      image: extractFeaturedImage(post),
      source: site.name,
    })).filter(r => r.url);
  } catch (err) {
    // Site blocked us, timed out, or returned something unexpected — skip it.
    return [];
  }
}

/* ============================================================
   Relevance re-ranking (see the big comment above where this is used)
   ============================================================ */
const SEARCH_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'with', 'of', 'for', 'to', 'in', 'on', 'best', 'easy']);

function significantWords(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !SEARCH_STOPWORDS.has(w));
}

// Fraction of the query's significant words that appear as whole words in
// the title — 1.0 means every query word showed up in the title (as close
// to "this is the recipe" as we can tell from title text alone).
function titleMatchScore(title, queryWords) {
  if (!queryWords.length) return 0;
  const t = title.toLowerCase();
  const hits = queryWords.filter(w => new RegExp(`\\b${escapeRegex(w)}\\b`).test(t));
  return hits.length / queryWords.length;
}

// Roundup/listicle posts ("30 Light and Bright Spring Dinner Recipes", "45
// Vegetable Side Dishes") mention many dishes in passing and are essentially
// never a good match for "find me the recipe for X" — they also have no
// single structured recipe for /api/parse-recipe.js to import. Their titles
// reliably start with a number, so that's a cheap, effective filter.
function isRoundupTitle(title) {
  return /^\d+\s/.test(title.trim());
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFeaturedImage(post) {
  try {
    const media = post?._embedded?.['wp:featuredmedia']?.[0];
    if (!media) return null;
    // Prefer a larger size so cards look crisp — "medium" (WordPress's
    // default ~300px wide) was coming in soft/blurry on some sites once
    // shown at card size. Fall back down the list only if a size is missing.
    const sizes = media?.media_details?.sizes;
    if (sizes?.medium_large?.source_url) return sizes.medium_large.source_url;
    if (sizes?.large?.source_url) return sizes.large.source_url;
    if (media?.source_url) return media.source_url; // full original, always sharpest
    if (sizes?.medium?.source_url) return sizes.medium.source_url;
    if (sizes?.thumbnail?.source_url) return sizes.thumbnail.source_url;
    return null;
  } catch {
    return null;
  }
}

function interleaveBySource(results) {
  const bySource = {};
  for (const r of results) {
    (bySource[r.source] = bySource[r.source] || []).push(r);
  }
  const sources = Object.keys(bySource);
  const merged = [];
  let added = true;
  let i = 0;
  while (added) {
    added = false;
    for (const s of sources) {
      if (bySource[s][i]) {
        merged.push(bySource[s][i]);
        added = true;
      }
    }
    i++;
  }
  return merged;
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      headers: {
        // Same reasoning as parse-recipe.js — a declared-bot User-Agent
        // gets filtered by basic WordPress security plugins even when the
        // site is otherwise happy to serve the request.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
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
    .replace(/\s{2,}/g, ' ')
    .trim();
}
