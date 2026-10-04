# Pixelso

**Type a sentence. Get a pixel soul.**

Pixelso turns one sentence into a one-of-a-kind, animated 32 × 32 pixel art character that you can download as a crisp 1080 × 1080 profile picture. Every avatar comes from a seed, so any avatar can be rebuilt exactly from its seed code and sentence.

> Built entirely on voice with **Wispr Flow** for **Hacker House Goa 2026** (Task 05).

![Pixelso screenshot](docs/screenshot.png)
<!-- Screenshot placeholder: add a capture of the app at docs/screenshot.png -->

---

## What it does

- **Sentence to avatar.** Type or speak (mic button) a sentence and press **Generate**. Pixelso reads the mood of the sentence, picks a theme and a character, and draws a 32 × 32 scene on a 640 × 640 canvas (each art pixel is 20 × 20 screen pixels, smoothing off).
- **9 themes**, each with its own palette, background and particles:
  | Theme | Scene | Particles |
  |---|---|---|
  | Haunted | Purple night, full moon, graves, drifting fog | Flapping bats |
  | Happy | Blue sky, sun with a cloud, flower meadow | Floating petals |
  | Sad | Gray-blue sky, heavy clouds, city, puddles | Rain |
  | Sci-Fi | Deep space, planets, flowing neon grid | Twinkling stars |
  | Cyberpunk | Neon skyline, flickering signs, wet street | Neon rain |
  | Hydro Depths | Deep ocean, wavy surface, light shafts, glowing dots | Bubbles |
  | Underwater Forest | Swaying kelp, sunbeams, coral, sand | Bubbles |
  | Candyland | Pink sky, lollipops, frosting hills, gumdrops | Sprinkles |
| Goa Sunset | Purple-orange sunset, sea glints, palm tree, beach | Seagulls |
- **12 characters**: cat, fox, owl, frog, bunny, ghost, robot, slime, alien, mini dragon, monster, vamp. Each is a symbol template (left half, mirrored for perfect symmetry) with a dark outline. The seed picks body color, eye style and an accessory (hat, crown, headphones, glasses, scarf or nothing).
- **Mood expressions.** Positive: smile and blush. Neutral: straight line. Negative: frown with falling tears.
- **Animation.** The character bobs gently and blinks every few seconds while the theme particles move.
- **Fun names** such as *Gloomy Neon Fox* or *Sparkly Moon Slime*, shown with the theme.
- **Reroll** keeps your sentence and uses a new timestamp for a fresh avatar.
- **Download PFP** renders a fresh still frame straight onto a 1080 × 1080 canvas with nearest-neighbor scaling, so pixels stay sharp.
- **Circular preview** shows how it looks as an Instagram, WhatsApp or LinkedIn profile picture. The character always sits inside the circle.
- **Name + seed stamp** toggle adds tiny pixel text (for example `PIXELSO · BLOOMY MOON FOX · #0F2A9C`) to the bottom of the image.
- **Copy link** puts the seed and sentence in the URL. Opening the link redraws exactly the same avatar.
- **Share** (phones) uses the Web Share API to send the PNG straight to apps.
- **Gallery** keeps your last 8 avatars as thumbnails in localStorage. Click one to bring it back.
- **AI bio (optional).** Toggle it on, add your Gemini API key in Settings (stored only in your browser), and Pixelso asks Gemini for a funny one-line bio. If the call fails, the bio just stays hidden.
- **Example chips** for first-time visitors and a fully responsive layout for phones.
- **Design.** A warm, editorial look inspired by Wispr Flow (cream paper, serif headlines, lavender buttons, one deep green studio panel) with Goa touches like the sunset theme and wave footer.

## How the seeds work

1. **Seed.** On Generate, Pixelso joins the sentence with the current time in milliseconds (`sentence|1759571234567`) and hashes it with **MurmurHash3 (32-bit)**. The 32-bit hash is folded to 24 bits, which is shown as a short hex code like `#0F2A9C`. Because the code is the entire seed, the code alone is enough to rebuild the scene.
2. **One generator.** The seed feeds a small seeded PRNG (Mulberry32, a Murmur-style mixer). Every random choice in the app comes from this generator. `Math.random()` is never used, so the same seed always gives the same result.
3. **Fixed order.** Choices are drawn in a fixed order: theme, background details, character type, body color, accent, eye style, accessory, particles, name, blink timing.
4. **Mood shifts the odds.** sentiment.js scores the sentence. Positive sentences make Happy, Candyland, Underwater Forest and Goa Sunset more likely, and negative ones push toward Haunted, Sad and Hydro Depths. The seed still makes the final pick, so the same seed and sentence always land on the same theme.
5. **Animation is deterministic.** Particle positions and blinks are pure functions of seeded values and the frame number.
6. **Redraw from seed.** `Pixelso.drawFromSeed(seed, sentence)` rebuilds any avatar. Shared links (`?seed=0F2A9C&s=your+sentence`), the gallery and future features (such as shared rings) all use it.

## How to run it

No build step. It is three static files.

```bash
# option 1: open index.html directly in a browser

# option 2 (recommended, so clipboard and sharing work): serve the folder
python -m http.server 8000
# then visit http://localhost:8000
```

An internet connection is needed for the CDN libraries and the font.

## Tech used

- **HTML, CSS, vanilla JavaScript** (`index.html`, `style.css`, `script.js`)
- **p5.js** (CDN) for the canvas, the draw loop and `noSmooth()`
- **sentiment.js** (CDN via jsDelivr) for mood scoring, with a small built-in fallback word list
- **EB Garamond + Figtree** (UI) and **Press Start 2P** (pixel text) from Google Fonts
- **Web Speech API** for speaking your sentence (Chrome, Edge, Safari)
- **MurmurHash3 + Mulberry32** for seeding and reproducible randomness
- **Canvas 2D** nearest-neighbor scaling for the 1080 × 1080 export
- **Web Share API**, **Clipboard API**, **localStorage**
- **Gemini API** (optional, bring your own key) for AI bios

## Built by voice

Pixelso was built entirely by voice using **Wispr Flow**. The whole spec was dictated in plain speech: the 32 × 32 grid, seeded hashing, themes, characters, mood rules, animation, export, sharing, gallery, AI bio and responsive layout. Wispr Flow turned speech into the prompts for an AI coding assistant, which wrote the code in this repo. Every follow-up tweak and fix was dictated the same way.
