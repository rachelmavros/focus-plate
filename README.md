# Focus Plate — Setup Guide

ADHD-friendly recipe reader. Paste any recipe link, get back a checklist-style
version with ingredients highlighted inline within each step.

This is built to deploy with **zero command line** — same workflow as your
other projects (GitHub web UI → Vercel auto-deploy on commit).

## File structure
You need exactly these 5 files, in this exact folder structure:

```
focus-plate/
├── index.html              ← the app itself
├── package.json             ← tells Vercel this uses ES modules
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
- Sites that don't publish structured recipe data at all (rare, but
  possible for smaller personal blogs or sites with broken markup) — direct
  link import gives a clear error rather than a garbled result.
- Non-WordPress sites in **search** specifically (see above) — search just
  quietly returns fewer results rather than erroring.
- A search site that blocks bot traffic or disables its JSON API — that one
  site is silently skipped and the others still return results. If one
  never works, swap it out of the `SITES` list.

**Known rough edge:** the ingredient-highlighting in each step uses text
matching, so on rare occasions an unusual phrasing may not get highlighted.
Not a blocker, just something to expect.

**Note on the "Popular to start" links:** I can't verify live network
requests from my own sandbox (it's restricted to a small allowlist of
domains), so while these URLs are correct as of my research, you're the
first real test of whether each one still resolves and has schema.org data.
If any ever break (sites redesign/move pages sometimes, or start blocking
bots like Allrecipes did), swap in a fresh URL from that site.

## Photos
- **Popular to start cards**: on first visit each card shows an emoji, then
  quietly fetches its real recipe photo in the background and swaps it in
  (cached in local storage after that, so it's instant on repeat visits). If
  a site is slow or blocked, the card just keeps its emoji — never shows an
  error for this, since it's a background nicety, not a user action.
- **Recipe detail view**: shows a compact hero photo at the top (max ~140px
  tall, so it doesn't crowd out the reading experience) when the source
  provides one. Pasted-text and most TikTok/IG imports won't have one, since
  there's no page to pull a photo from.
- **Per-step photos**: some recipe sites include a photo for individual
  instruction steps in their structured data (not most sites, but some do).
  When present, it shows as a small 56px thumbnail next to that step. This
  only applies to blog-link imports — LLM-extracted recipes (pasted
  text/TikTok/IG) never have step photos since there's no source photo data.

## TikTok/Instagram imports
The recipe detail view for a TikTok/IG import shows a prominent
"▶ Watch original on TikTok/Instagram" button (not just the small "Source:"
line other imports get), since the video itself is often the real reference
point for these — ingredient amounts or technique details that didn't make
it into the caption. Tapping it opens the original video in a new tab.
