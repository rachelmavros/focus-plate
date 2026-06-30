# Focus Plate — Setup Guide

ADHD-friendly recipe reader. Paste any recipe link, get back a checklist-style
version with ingredients highlighted inline within each step.

This is built to deploy with **zero command line** — same workflow as your
other projects (GitHub web UI → Vercel auto-deploy on commit).

## File structure
You need exactly these 3 files, in this exact folder structure:

```
focus-plate/
├── index.html          ← the app itself
├── package.json         ← tells Vercel this uses ES modules
└── api/
    └── parse-recipe.js  ← the backend that fetches & parses recipes
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

**3. Connect to Vercel**
- Go to vercel.com → Add New → Project
- Import the `focus-plate` repo
- Leave all settings as default (no build command needed — it's static
  HTML + one serverless function)
- Click Deploy

That's it. From now on, every commit to main auto-redeploys, exactly like
your other apps.

**4. Test it**
Once deployed, open your Vercel URL and paste in a recipe link — try
`https://www.budgetbytes.com/one-pot-creamy-mushroom-pasta/` or
`https://sallysbakingaddiction.com/best-banana-bread-recipe/` first since
those are confirmed to work well.

## How it works
- You paste a URL into the app
- The app calls `/api/parse-recipe?url=...` (your own backend, same project)
- That function fetches the page's HTML, pulls out its embedded schema.org
  recipe data (the same structured data Google uses for recipe rich
  results), and reshapes it into ingredients + steps with inline ingredient
  highlighting
- The result is cached in your browser's local storage as "Recently viewed"
  so reopening a recipe doesn't re-fetch it

## What works well vs. what doesn't (yet)
**Works well:** most major recipe blogs and sites — WordPress-based food
blogs (which is most of them), NYT Cooking, AllRecipes, Bon Appétit, Budget
Bytes, Sally's Baking Addiction, etc. These all publish structured recipe
data for Google/Pinterest, which is what this app reads.

**Won't work:** sites that don't publish structured recipe data (rare for
real recipe sites, but possible for smaller personal blogs or sites with
broken markup) — you'll get a clear error message rather than a garbled
result.

**Known rough edge:** the ingredient-highlighting in each step uses simple
text matching, so occasionally a second mention of an ingredient later in a
step (e.g. "the mushrooms" after already saying "baby bella mushrooms")
won't get highlighted. Not a blocker, just something to expect.
