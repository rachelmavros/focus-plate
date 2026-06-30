# Focus Plate — Setup Guide

ADHD-friendly recipe reader. Search recipes, browse popular starters, or paste
any recipe link — get back a checklist-style version with ingredients
highlighted inline within each step.

Built to deploy with **zero command line** (GitHub web UI → Vercel auto-deploy).

## File structure
You need exactly these files, in this exact structure:

```
focus-plate/
├── index.html              ← the app
├── package.json             ← tells Vercel to use ES modules
└── api/
    ├── parse-recipe.js      ← fetches & reformats a single recipe URL
    └── search-recipes.js    ← live search across recipe sites
```

The `api/` folder name matters — that's how Vercel knows those two files are
serverless functions rather than static files.

## Adding the files (GitHub web UI)
For each file: **Add file → Create new file**, type the filename (including the
`api/` prefix for the two backend files — typing the slash auto-creates the
folder), paste contents, commit to main.

If you already have the repo deployed, you only need to:
1. **Add** the new file `api/search-recipes.js`
2. **Replace** `index.html` and `api/parse-recipe.js` with these updated versions
   (open each on GitHub → pencil icon → select all → paste new → commit)

Vercel redeploys automatically on each commit.

## The three features
1. **Search** — type a term (e.g. "chocolate chip"), and the app queries a few
   recipe sites live and shows matching recipes. Tap one to open it in the
   focus format.
2. **Popular to start** — three preloaded recipes from trusted sites, for when
   someone doesn't have a specific recipe in mind. Tapping one imports it live.
3. **Paste a link** — paste any recipe URL to import it directly.

All three route through the same parser, so the reading experience is identical
no matter how a recipe got in.

## How search works (and how to change which sites it searches)
Search uses each site's built-in **WordPress REST API** — a stable, public JSON
interface that WordPress sites expose by default. This is far more reliable
than scraping search-result pages.

To change which sites are searched, open `api/search-recipes.js` and edit the
`SITES` list near the top:

```js
const SITES = [
  { name: "Sally's Baking Addiction", base: "https://sallysbakingaddiction.com" },
  { name: "Budget Bytes", base: "https://www.budgetbytes.com" },
];
```

Add any WordPress-based recipe site the same way (most food blogs are
WordPress). One commit, and search picks it up.

## Things to expect / known limits
- **A site might block search.** Some sites block non-browser traffic or disable
  their JSON API. If a site returns nothing, search just skips it silently and
  shows results from the others. If one never works, swap it out of the `SITES`
  list.
- **Search results may include non-recipe posts** (like a "12 best cookies"
  round-up). Those will open with a clear "couldn't find recipe data" message
  rather than a broken screen, since they have no single structured recipe.
- **Ingredient highlighting** uses text matching, so a second casual mention of
  an ingredient later in the same step occasionally won't highlight. Not a
  blocker, just expected.
- **Preloaded recipes** import live each time they're tapped, so they always
  reflect the current version on the source site.

## Test links known to work well
- https://sallysbakingaddiction.com/best-banana-bread-recipe/
- https://www.budgetbytes.com/one-pot-creamy-mushroom-pasta/
