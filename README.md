# PokéPrice Search

A production-ready Pokémon card price search app powered by the [PokémonPriceTracker API v2](https://www.pokemonpricetracker.com).

## Features

- **Search by card number** — `199/165` finds the 151 Charizard ex instantly, no name required
- **Search by name** — `Charizard ex`, `Umbreon VMAX`, etc.
- **Optional set filter** — narrow results by set name
- **English / Japanese toggle** — switch market pricing data per language
- **Dark mode** — high-contrast pricing tables (white `#ffffff` headers, `#f3f4f6` cells)
- **Grid + list view** — toggle between layouts
- **Card detail modal** — full pricing breakdown per variant (normal, holofoil, etc.)

## Directory Structure

```
pokeprice-search/
├── api/
│   └── search.js          # Vercel serverless proxy (injects API key)
├── public/
│   ├── css/style.css
│   ├── js/app.js
│   └── index.html
├── .env.example
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

## Deploy to Vercel

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/pokeprice-search.git
git push -u origin main
```

### 2. Connect to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repo
3. No build settings needed (it's static + serverless)
4. Add environment variable:
   - **Name:** `POKEPRICE_API_KEY`
   - **Value:** your PokémonPriceTracker API key
5. Click **Deploy**

### 3. Done

Your app is live. Card number searches like `199/165` work natively — the `search` query param is passed directly to the API's `/cards` endpoint.

## How Card Number Search Works

The search input value is sent as-is to `/api/search?search=199/165&language=english`.  
The serverless proxy forwards it to:

```
GET https://www.pokemonpricetracker.com/api/v2/cards?search=199%2F165&language=english
```

The API natively resolves `199/165` to the matching card(s) without needing a Pokémon name.  
No client-side number-detection regex — just a direct passthrough.

## Local Development

```bash
# Install a static server
npm install -g serve

# Serve the public folder (API calls won't work without the serverless function)
serve public -l 3000
```

For full local dev including the API proxy, use the [Vercel CLI](https://vercel.com/docs/cli):

```bash
npm i -g vercel
vercel dev
```

Set `POKEPRICE_API_KEY` in a local `.env` file (see `.env.example`).
