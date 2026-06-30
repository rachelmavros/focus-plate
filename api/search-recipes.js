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
];

const PER_SITE_RESULTS = 5;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Please provide a search term with ?q=' });
  }

  const query = q.trim();

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

  // Interleave results so one site doesn't dominate the top of the list
  results = interleaveBySource(results);

  return res.status(200).json({ query, results });
}

async function searchSite(site, query) {
  const url =
    `${site.base}/wp-json/wp/v2/posts` +
    `?search=${encodeURIComponent(query)}` +
    `&per_page=${PER_SITE_RESULTS}` +
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

function extractFeaturedImage(post) {
  try {
    const media = post?._embedded?.['wp:featuredmedia']?.[0];
    if (!media) return null;
    // Prefer a medium-sized thumbnail if available, else the full source
    const sizes = media?.media_details?.sizes;
    if (sizes?.medium?.source_url) return sizes.medium.source_url;
    if (sizes?.thumbnail?.source_url) return sizes.thumbnail.source_url;
    return media?.source_url || null;
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
        'User-Agent': 'Mozilla/5.0 (compatible; FocusPlateBot/1.0)',
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
