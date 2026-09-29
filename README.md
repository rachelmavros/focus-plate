# Focus Plate — Setup Guide

ADHD-friendly recipe reader. Paste any recipe link, get back a checklist-style
version with ingredients highlighted inline within each step.

This is built to deploy with **zero command line** — same workflow as your
other projects (GitHub web UI → Vercel auto-deploy on commit).

## File structure
You need exactly these 8 files, in this exact folder structure:

```
focus-plate/
├── index.html              ← the app itself
├── package.json             ← tells Vercel this uses ES modules
├── favicon.png              ← browser tab icon (64x64)
├── favicon-32.png           ← browser tab icon (32x32, some browsers prefer this size)
├── apple-touch-icon.png     ← home-screen/bookmark icon for iOS Safari
└── api/
    ├── parse-recipe.js      ← backend for recipe-blog links (schema.org data)
    ├── extract-recipe.js    ← backend for pasted text & TikTok/IG links (LLM-based)
    └── search-recipes.js    ← backend for live search across recipe blogs
```

The `api/` folder name matters — that's how Vercel knows to treat
`parse-recipe.js` as a serverless function instead of a static file.

## Step-by-step

**1. Create the repo**
Go to github.com → New repository → name it `focus-plate` (or whatever you
like) → Create repository. Don't initialize with a README, you'll add files
directly.

**2. Add the files via the web UI**
- Click **"Add file" → "Create new file"**
- For the filename, type `index.html` and paste in the contents of
  `index.html` below
- Commit directly to main
- Repeat: **"Add file" → "Create new file"**, filename `package.json`, paste
  contents, commit
- Repeat once more: **"Add file" → "Create new file"**, and for the filename
  type `api/parse-recipe.js` (typing the slash will automatically create the
  `api` folder for you) — paste contents, commit
- One more: filename `api/extract-recipe.js` — paste contents, commit
- One more: filename `api/search-recipes.js` — paste contents, commit
- The three `.png` files are images, not text, so they can't be pasted this
  way — instead use **"Add file" → "Upload files"** and drag in `favicon.png`,
  `favicon-32.png`, and `apple-touch-icon.png` together, then commit

**3. Connect to Vercel**
- Go to vercel.com → Add New → Project
- Import the `focus-plate` repo
- Leave all settings as default (no build command needed — it's static
  HTML + serverless functions)
- Click Deploy

**3b. Add your Anthropic API key (needed for pasted text & TikTok/IG import)**
- Get a key at console.anthropic.com (API Keys → Create Key)
- In the Vercel project → Settings → Environment Variables, add:
  - Name: `ANTHROPIC_API_KEY`
  - Value: your key
  - Apply to all environments, then redeploy (Deployments → ⋯ → Redeploy)
- Without this, blog-link import still works fine — only pasted-text and
  TikTok/IG import need the key.

That's it. From now on, every commit to main auto-redeploys, exactly like
your other apps.

**4. Test it**
Once deployed, open your Vercel URL and paste in a recipe link — try
`https://www.budgetbytes.com/one-pot-creamy-mushroom-pasta/` or
`https://sallysbakingaddiction.com/best-banana-bread-recipe/` first since
those are confirmed to work well.

## How it works
The app now accepts three kinds of input, auto-detected from what you paste
(or you can click "Paste text instead" to force text mode):

**1. A recipe blog/site link**
- Calls `/api/parse-recipe?url=...`
- Fetches the page's HTML, pulls out its embedded schema.org recipe data
  (the same structured data Google uses for recipe rich results), and
  reshapes it into ingredients + steps with inline ingredient highlighting

**2. A TikTok or Instagram link**
- Calls `/api/extract-recipe` with `{ socialUrl }`
- Tries to fetch the video's caption text via the platform's public oEmbed
  endpoint, then runs that caption through the same LLM extraction as (3)
- **Limitation:** this only works when the recipe is written out in the
  caption itself. It can't read on-screen text or transcribe spoken audio —
  if the caption doesn't contain the recipe (e.g. "full recipe in
  comments 👇", or the recipe is only spoken in the video), you'll get a
  clear error asking you to paste the recipe text directly. TikTok's oEmbed
  is more reliable for this than Instagram's, which frequently doesn't
  return caption text at all.

**3. Pasted text** (copied from an AI chat, a text message, notes, etc.)
- Calls `/api/extract-recipe` with `{ text }`
- Sends the text to Claude (Anthropic API) to identify the title,
  ingredients, and steps and reshape them into the app's format
- Requires the `ANTHROPIC_API_KEY` environment variable (see step 3b above)

All four produce the same recipe shape, so the reader view, ingredient
checklist, and inline highlighting work identically regardless of source.
Every imported recipe is cached in your browser's local storage as
"Recently viewed" so reopening it doesn't re-fetch or re-extract.

**4. Search** — the "Search recipes" box at the top queries a few
WordPress-based recipe blogs live (via each site's built-in `wp-json` REST
API — a stable, public JSON interface WordPress sites expose by default,
more reliable than scraping search-result pages) and shows matching
results with thumbnails. Tap a result to import it, same as any other link.

**Search relevance:** WordPress's built-in search matches a post's full body
text with no real relevance ranking, so early on this surfaced a lot of
loosely-related results — e.g. searching "french onion soup" returned a
croutons post (mentions French onion soup in passing) and several "30 Best
Spring Recipes"-style roundup posts (which name-drop dozens of dishes) ahead
of anything actually about that soup. `api/search-recipes.js` now re-ranks
results itself: it scores each result by how many of the query's words
actually appear in the *title* (a much stronger signal than a body mention),
drops roundup/listicle posts entirely (their titles reliably start with a
number, like "45 Vegetable Side Dishes"), and drops anything with zero title
overlap with the query.

## Which sites work where (an important distinction)
- **Direct-link import** (pasting a URL, or a "Popular to start" card) works
  on almost any recipe site — NYT Cooking, Bon Appétit, every WordPress food
  blog, etc. — because it reads schema.org structured data, which nearly all
  recipe sites publish for Google/Pinterest regardless of what platform
  they're built on.
- **Search** only works on WordPress-based sites, because it uses each
  site's `wp-json` REST API specifically. Big platforms run on their own
  custom systems with no equivalent public search endpoint, so they can't be
  added to search.
- **Big publishers may block both.** Allrecipes was tried as a "Popular"
  card and returned HTTP 402 (Payment Required) — some large publishers now
  use Cloudflare's bot-blocking/"pay per crawl" system, which returns 402 to
  automated requests specifically. This affects direct-link import too, not
  just search, so it was swapped for an independent WordPress blog recipe
  instead. Independent food blogs (the kind already in this app) are much
  less likely to do this than large media companies.

**On Allrecipes specifically:** re-checked while adding more sites, and it's
still a hard block — even a direct page fetch from a completely different
network got flagged instantly. That "pay per crawl" system isn't a soft
rate-limit that a different approach (rotating user-agents, retry logic,
etc.) works around — it's Cloudflare's bot detection deliberately identifying
and pricing automated access, and Allrecipes (owned by Dotdash Meredith)
opted into it on purpose. The realistic ways around that — a headless
browser, a paid scraping/proxy service — are a different kind of project
than this one (they don't fit in a lightweight serverless function, need
ongoing maintenance as the block adapts, and start to run up against
Allrecipes' terms of service), so it's not something worth bolting on here.
The same applies to Food Network, Delish, Taste of Home, Epicurious, and
Simply Recipes — all big-media, all custom (non-WordPress) platforms likely
running similar protection.

To add more sites to search, edit the `SITES` list near the top of
`api/search-recipes.js` — any WordPress-based recipe blog works the same way:

```js
const SITES = [
  { name: "Sally's Baking Addiction", base: "https://sallysbakingaddiction.com" },
  { name: "Budget Bytes", base: "https://www.budgetbytes.com" },
  // ...add more here
];
```

## What works well vs. what doesn't (yet)
**Works well:** most major recipe blogs and sites — WordPress-based food
blogs (which is most of them), NYT Cooking, Bon Appétit, Budget Bytes,
Sally's Baking Addiction, etc. — for direct-link import. These all publish
structured recipe data for Google/Pinterest, which is what `parse-recipe.js`
reads.

**Won't work:**
- Sites that don't publish structured recipe data at all — direct link
  import gives a clear error ("couldn't find structured recipe data")
  rather than a garbled result. Less rare than you'd think: **Smitten
  Kitchen** was tried here and removed after confirming its pages genuinely
  have no schema.org Recipe markup at all (it's a long-running blog on an
  older custom template, not a broken link or a fetch problem — it loads
  fine, there's just nothing on the page in the format this app reads).
- Non-WordPress sites in **search** specifically (see above) — search just
  quietly returns fewer results rather than erroring.
- A search site that blocks bot traffic or disables its JSON API — that one
  site is silently skipped and the others still return results. If one
  never works, swap it out of the `SITES` list.

**Known rough edge:** the ingredient-highlighting in each step uses text
matching, so on rare occasions an unusual phrasing may not get highlighted.
Not a blocker, just something to expect.

**Note on the "Popular to start" cards:** these no longer point at hand-typed
URLs (see the "Popular to start" section below for why) — they're resolved
live through the same search API used by the Search box, so a page moving
or a site starting to block requests fixes itself automatically within 30
days (or immediately if you clear the site's local storage) instead of
staying broken until someone edits code.

## Photos
- **Popular to start cards**: on first visit each card shows an emoji, then
  quietly fetches its real recipe photo in the background and swaps it in
  (cached in local storage after that, so it's instant on repeat visits). If
  a site is slow or blocked, the card just keeps its emoji — never shows an
  error for this, since it's a background nicety, not a user action.
- **Recipe detail view**: shows a full-width hero photo at the top of the
  page (4:3, capped at 280px tall) when the source provides one. Pasted-text
  and most TikTok/IG imports won't have one, since there's no page to pull a
  photo from.
- **Per-step photos**: some recipe sites include a photo for individual
  instruction steps in their structured data (not most sites, but some do).
  When present, it shows as a small 56px thumbnail next to that step. This
  only applies to blog-link imports — LLM-extracted recipes (pasted
  text/TikTok/IG) never have step photos since there's no source photo data.
- **Blurry photos**: if a site publishes several sizes of the same photo
  (common on WordPress — a whole responsive srcset baked into the page's
  recipe data), `parse-recipe.js` now picks the highest-resolution one
  instead of just whichever URL happened to come first, which was the cause
  of some sites' photos (Sally's Baking Addiction, notably) coming in soft.

## Popular to start
This used to be a hand-typed list of specific recipe URLs — the trouble was
that even URLs looked up via web search turned out wrong often enough
(wrong slug, page moved, site started blocking) that a noticeable chunk of
the 12 broke over time. Live Search never had that problem, because it
always asks each site fresh instead of trusting a URL someone typed from
memory months ago.

So Popular now works the same way Search does: instead of a list of
{title, source, url}, `index.html` has a `POPULAR_SEARCH_TERMS` list of
popular dish search terms (with an emoji for the placeholder look — e.g.
`{ emoji: '🍌', term: 'banana bread' }`). Each term is resolved to a real,
currently-working recipe by calling `/api/search-recipes` — the exact same
endpoint the Search box uses — and taking its top result. Resolved results
are cached in the browser's local storage for 30 days, so it's instant on
every normal visit, and automatically re-resolved once that cache expires —
so a broken link fixes itself over time instead of staying broken.

On first load (or once a term's cache expires), that card shows a dimmed
placeholder with its emoji and the term as a stand-in title while it
resolves in the background — same "never show an error, just quietly
update" spirit as the photo/rating sync. If a term genuinely can't be
resolved (e.g. a very unusual dish name with no match on any of the sites),
that one card is simply skipped rather than showing a dead link.

There are 14 terms in the pool, not just the 4 shown at once — it opens to
a random set of 4 each visit, and the ← → arrows next to the section label
page through the rest, wrapping back around at the end. Edit the
`POPULAR_SEARCH_TERMS` list near the top of `index.html`'s `<script>` to
add, remove, or reorder terms — `POPULAR_PAGE_SIZE` controls how many show
per page (4 by default). Since resolution goes through the same search API,
a term is really only as good as the recipe blogs in `api/search-recipes.js`'s
`SITES` list — pick terms you'd expect one of those sites to have a good,
specific match for (avoid anything too niche or too generic).

## Star ratings
When a site publishes an average rating (schema.org's `aggregateRating` —
the same data Google's own recipe rich results pull from), Popular and
Search cards show it the same way: `★★★★½ 4.7 (1,532)`. It's fetched live in
the background per card and cached, same as the photos. Tapping the rating
opens that recipe's own page in a new tab — where the actual reviews live —
without opening the card's reader view. Not every site publishes a rating,
so some cards simply won't show one.

## TikTok/Instagram imports
The recipe detail view for a TikTok/IG import shows a prominent
"▶ Watch original on TikTok/Instagram" button (not just the small "Source:"
line other imports get), since the video itself is often the real reference
point for these — ingredient amounts or technique details that didn't make
it into the caption. Tapping it opens the original video in a new tab.
