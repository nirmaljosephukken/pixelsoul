/* =====================================================================
   PIXELSO · sentence -> seeded pixel soul
   Every random choice comes from ONE seeded generator (see makeRng).
   No Math.random() anywhere, so a seed + sentence always redraws the
   exact same avatar.
   ===================================================================== */
"use strict";

const GRID = 32;          // art pixels per side
const CELL = 20;          // screen pixels per art pixel (32 * 20 = 640)
const SIZE = GRID * CELL; // 640
const EXPORT_SIZE = 1080;
const GALLERY_KEY = "pixelso.gallery.v1";
const SETTINGS_KEY = "pixelso.settings.v1";
const DEFAULT_MODEL = "gemini-flash-latest";

/* ---------------------------------------------------------------------
   1. Hashing + seeded random number generator
   --------------------------------------------------------------------- */

// MurmurHash3 (x86, 32-bit): turns a string into a well mixed 32-bit int.
function murmur3(str, seed = 0) {
  let h = seed >>> 0;
  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  const nBlocks = len >> 2;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  for (let i = 0; i < nBlocks; i++) {
    let k = bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const tail = nBlocks * 4;
  switch (len & 3) {
    case 3: k ^= bytes[tail + 2] << 16; // falls through
    case 2: k ^= bytes[tail + 1] << 8;  // falls through
    case 1: k ^= bytes[tail];
      k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
  }
  h ^= len;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// sentence + current time (ms) -> 32-bit murmur hash -> folded to the
// 24-bit seed that is shown as #RRGGBB-style hex. The visible code IS the
// whole seed, so anyone can redraw it from the code alone.
function makeSeed(sentence, timeMs) {
  const h = murmur3(sentence.trim().toLowerCase() + "|" + timeMs);
  return (h ^ (h >>> 24)) & 0xffffff;
}

const seedToHex = (seed) => "#" + (seed >>> 0).toString(16).toUpperCase().padStart(6, "0");
const hexToSeed = (hex) => {
  const clean = String(hex || "").replace(/[^0-9a-f]/gi, "").slice(0, 8);
  if (!clean) return null;
  return parseInt(clean, 16) & 0xffffff;
};

// Small seeded PRNG (Mulberry32: a Murmur-style 32-bit mixer).
// The seed is first scrambled through murmur3 so nearby seeds diverge.
function makeRng(seed) {
  let a = murmur3("pixelso:" + seed);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + next() * (hi - lo),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (items, weights) => {
      const total = weights.reduce((s, w) => s + w, 0);
      let r = next() * total;
      for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
      return items[items.length - 1];
    },
  };
  return rng;
}

/* ---------------------------------------------------------------------
   2. Colour + frame-buffer helpers (32x32 art grid)
   --------------------------------------------------------------------- */
const hex = (s) => parseInt(s.replace("#", ""), 16);
const rgb = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const mix = (a, b, t) => {
  const A = rgb(a), B = rgb(b);
  return (Math.round(A[0] + (B[0] - A[0]) * t) << 16) |
         (Math.round(A[1] + (B[1] - A[1]) * t) << 8) |
          Math.round(A[2] + (B[2] - A[2]) * t);
};
const lum = (c) => { const [r, g, b] = rgb(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const mod = (a, n) => ((a % n) + n) % n;
const BAYER = [0, 0.5, 0.75, 0.25]; // 2x2 ordered dither

function newBuf() { return new Int32Array(GRID * GRID); }
function setPx(buf, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x >= 0 && y >= 0 && x < GRID && y < GRID) buf[y * GRID + x] = c;
}
function getPx(buf, x, y) { return buf[y * GRID + x]; }
function blendPx(buf, x, y, c, a) {
  x = Math.round(x); y = Math.round(y);
  if (x >= 0 && y >= 0 && x < GRID && y < GRID) buf[y * GRID + x] = mix(buf[y * GRID + x], c, a);
}
function rectPx(buf, x, y, w, h, c) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) setPx(buf, x + i, y + j, c);
}
function discPx(buf, cx, cy, r, c) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++)
    if (x * x + y * y <= r * r + r * 0.6) setPx(buf, cx + x, cy + y, c);
}
// stepped vertical gradient with ordered dithering between bands
function gradient(buf, colors, y0 = 0, y1 = GRID - 1) {
  const cols = colors.map(hex);
  for (let y = y0; y <= y1; y++) {
    const f = ((y - y0) / Math.max(1, y1 - y0)) * (cols.length - 1);
    const i = Math.min(cols.length - 2, Math.floor(f));
    const frac = f - i;
    for (let x = 0; x < GRID; x++) {
      const b = BAYER[(y % 2) * 2 + (x % 2)];
      // dither only around the middle of each band so the sky stays calm
      buf[y * GRID + x] = frac > 0.5 + (b - 0.375) * 0.6 ? cols[i + 1] : cols[i];
    }
  }
}
// x positions that stay clear of the character in the middle
const sideX = (R, margin = 2) => (R.chance(0.5) ? margin + R.int(8 - margin) : 23 + R.int(8 - margin + 1));

/* ---------------------------------------------------------------------
   3. Themes: palette, background painter and animated layer
   Each bg(R) paints a static Int32Array and may return anim(fb, t).
   --------------------------------------------------------------------- */
const THEMES = [
  {
    key: "haunted", name: "Haunted", mood: "negative", particle: "bats",
    words: ["moon", "crypt", "shadow", "midnight", "phantom"],
    bodies: ["#9b6bff", "#6fe3c1", "#ff7ab6", "#c7c2d9", "#7fb0ff", "#f2a65a"],
    accents: ["#ff4f7b", "#ffd166", "#7cf7d4", "#b8ff5c"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#120824", "#1e0f38", "#2c174f", "#3d2068", "#4a2878"]);
      for (let i = 0; i < 12; i++) setPx(b, R.int(GRID), R.int(16), hex(R.pick(["#b9a6e8", "#8f7cc4"])));
      const mx = R.pick([5, 6, 25, 26]), my = 5 + R.int(2);
      for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
        const d = Math.sqrt(x * x + y * y);
        if (d > 4.3 && d < 6.2) blendPx(b, mx + x, my + y, hex("#cbb8ff"), 0.18);
      }
      discPx(b, mx, my, 4, hex("#f6f1c7"));
      [[-1, -1], [1, 1], [2, -2], [-2, 2]].forEach(([dx, dy]) => setPx(b, mx + dx, my + dy, hex("#d9d2a0")));
      const ph = R.next() * 6;
      for (let x = 0; x < GRID; x++) {
        const h = 26 + Math.round(Math.sin(x * 0.33 + ph) * 1.5);
        for (let y = h; y < GRID; y++) setPx(b, x, y, hex(y === h ? "#22123a" : "#140a22"));
      }
      for (let g = 0; g < 3; g++) {
        const gx = sideX(R, 1), gy = 26 + R.int(2);
        rectPx(b, gx, gy, 3, 3, hex("#4f456a")); setPx(b, gx, gy, hex("#22123a")); setPx(b, gx + 2, gy, hex("#22123a"));
        setPx(b, gx + 1, gy + 1, hex("#2d2640"));
      }
      return {
        base: b,
        anim(fb, t) { // drifting fog
          for (let y = 20; y < 29; y++) for (let x = 0; x < GRID; x++) {
            const v = Math.sin((x + t * 0.06) * 0.42 + y * 0.9) + Math.sin((x - t * 0.035) * 0.23 + y * 0.3);
            if (v > 0.7) blendPx(fb, x, y, hex("#a596c9"), 0.32);
          }
        },
      };
    },
  },
  {
    key: "happy", name: "Happy", mood: "positive", particle: "petals",
    words: ["sunny", "daisy", "honey", "meadow", "sunbeam"],
    bodies: ["#ffb347", "#ff7eb6", "#7ee081", "#8fd3ff", "#c9a0ff", "#ffe066"],
    accents: ["#ff4f7b", "#5a7dff", "#ffffff", "#ff9f1c"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#4fb3f4", "#73c6f8", "#99d8fb", "#c3eafd"]);
      const sx = R.pick([4, 27]), sy = 4;
      [[5, 0], [-5, 0], [0, 5], [0, -5], [4, 4], [-4, 4], [4, -4], [-4, -4]].forEach(([dx, dy]) => setPx(b, sx + dx, sy + dy, hex("#ffd23f")));
      discPx(b, sx, sy, 3, hex("#ffb627"));
      discPx(b, sx, sy, 2, hex("#ffe14d"));
      const ph = R.next() * 6;
      for (let x = 0; x < GRID; x++) {
        const h = 25 + Math.round(Math.sin(x * 0.25 + ph));
        for (let y = h; y < GRID; y++) {
          const deep = y > h + 2 && BAYER[(y % 2) * 2 + (x % 2)] < 0.5;
          setPx(b, x, y, hex(y === h ? "#7fdc6a" : deep ? "#3e9a45" : "#5cc25a"));
        }
      }
      const fcols = ["#ff7eb6", "#fff36b", "#ffffff", "#ff9f5a", "#c58bff"];
      for (let i = 0; i < 9; i++) {
        const fx = R.int(GRID), fy = 27 + R.int(4), c = hex(R.pick(fcols));
        setPx(b, fx, fy + 1, hex("#2f7d3a"));
        [[1, 0], [-1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => setPx(b, fx + dx, fy + dy - 1, c));
        setPx(b, fx, fy - 1, hex("#ffd23f"));
      }
      const clouds = [];
      for (let i = 0; i < 3; i++) clouds.push({ x: R.int(GRID), y: 2 + R.int(10), w: 5 + R.int(4), sp: R.range(0.015, 0.035) });
      clouds.push({ x: sx - 4, y: sy + 1, w: 6, sp: 0 }); // the "sunny cloud"
      return {
        base: b,
        anim(fb, t) {
          clouds.forEach((c) => {
            const x0 = Math.round(mod(c.x + t * c.sp + 8, GRID + 16) - 8);
            rectPx(fb, x0, c.y + 1, c.w, 2, hex("#ffffff"));
            rectPx(fb, x0 + 1, c.y, c.w - 3, 1, hex("#ffffff"));
            rectPx(fb, x0 + 1, c.y + 3, c.w - 2, 1, hex("#e1f2ff"));
          });
        },
      };
    },
  },
  {
    key: "sad", name: "Sad", mood: "negative", particle: "rain",
    words: ["drizzle", "puddle", "cloudy", "blue", "rainy"],
    bodies: ["#8fa3bf", "#a7b8d6", "#7f8fa6", "#b6a6c9", "#6fa0b3", "#c9c3b8"],
    accents: ["#ffd166", "#ff6b6b", "#7fd4ff", "#f4f4f4"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#2b3544", "#384657", "#48596e", "#5a6d86"]);
      let x = 0;
      while (x < GRID) { // distant city
        const w = 2 + R.int(4), h = 4 + R.int(7);
        rectPx(b, x, 27 - h, w, h, hex("#323e4e"));
        x += w + R.int(2);
      }
      const ph = R.next() * 6;
      for (let cx = 0; cx < GRID; cx++) {
        const bottom = 4 + Math.round(Math.sin(cx * 0.5 + ph) * 1.4 + Math.sin(cx * 0.21) * 1);
        for (let y = 0; y <= bottom; y++) setPx(b, cx, y, hex(y === bottom ? "#3a4757" : "#252e3a"));
      }
      rectPx(b, 0, 27, GRID, 5, hex("#1f2833"));
      const puddles = [];
      for (let i = 0; i < 2; i++) {
        const px = sideX(R, 1), py = 28 + R.int(3);
        rectPx(b, px - 2, py, 5, 1, hex("#3e5068")); rectPx(b, px - 1, py + 1, 3, 1, hex("#3e5068"));
        puddles.push({ x: px, y: py, ph: R.int(40) });
      }
      return {
        base: b,
        anim(fb, t) {
          puddles.forEach((p) => {
            const k = mod(t + p.ph, 40);
            if (k < 8) { setPx(fb, p.x - 1, p.y, hex("#8aa3c4")); setPx(fb, p.x + 1, p.y, hex("#8aa3c4")); }
            else if (k < 14) { setPx(fb, p.x - 2, p.y, hex("#6f87a6")); setPx(fb, p.x + 2, p.y, hex("#6f87a6")); }
          });
        },
      };
    },
  },
  {
    key: "scifi", name: "Sci-Fi", mood: "neutral", particle: "stars",
    words: ["cosmic", "nova", "orbit", "quasar", "astro"],
    bodies: ["#00e5ff", "#ff2bd6", "#b8ff5c", "#c9a0ff", "#ffd166", "#e0e0ff"],
    accents: ["#ff2bd6", "#00e5ff", "#ffd166", "#ffffff"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#04020c", "#0a0620", "#140b33", "#22104c"], 0, 21);
      rectPx(b, 0, 22, GRID, 10, hex("#0b0418"));
      for (let i = 0; i < 14; i++) setPx(b, R.int(GRID), R.int(20), hex("#4a4a7a"));
      const pals = [["#ff7b54", "#c94f2d"], ["#5ad1ff", "#2a7fb8"], ["#c77dff", "#7b2cbf"], ["#7cf7a8", "#2f9e6a"]];
      const big = R.pick(pals), px = sideX(R, 3), py = 5 + R.int(6), pr = 3 + R.int(2);
      discPx(b, px, py, pr, hex(big[1]));
      for (let y = -pr; y <= pr; y++) for (let x = -pr; x <= pr; x++)
        if (x * x + y * y <= pr * pr && x + y < 0) setPx(b, px + x, py + y, hex(big[0]));
      if (R.chance(0.6)) for (let x = -pr - 3; x <= pr + 3; x++) {
        const y = Math.round(x * 0.3);
        if (Math.abs(x) > pr - 1 || y > 0) setPx(b, px + x, py + y, hex("#ffd6a5"));
      }
      const small = R.pick(pals), sx = px < 16 ? 22 + R.int(7) : 2 + R.int(7), sy = 2 + R.int(8);
      discPx(b, sx, sy, 1, hex(small[0]));
      for (let x = 0; x < GRID; x++) blendPx(b, x, 21, hex("#ff2bd6"), 0.55);
      return {
        base: b,
        anim(fb, t) { // neon grid flowing toward the viewer
          for (let xb = -48; xb <= 80; xb += 8)
            for (let y = 24; y < GRID; y++) setPx(fb, 16 + ((xb - 16) * (y - 21)) / 10, y, hex("#00b8d4"));
          const shift = (t * 0.012) % 1;
          for (let i = 1; i <= 4; i++) {
            const p = (i + shift) / 4.6;
            const y = 22 + Math.round(p * p * 9.5) + 1;
            if (y > 22 && y < GRID) for (let x = 0; x < GRID; x++) setPx(fb, x, y, hex("#ff2bd6"));
          }
        },
      };
    },
  },
  {
    key: "cyberpunk", name: "Cyberpunk", mood: "neutral", particle: "neonrain",
    words: ["neon", "glitch", "chrome", "synth", "byte"],
    bodies: ["#00f0ff", "#ff2bd6", "#f9f871", "#9d4edd", "#39ff14", "#ff6b35"],
    accents: ["#f9f871", "#00f0ff", "#ff2bd6", "#39ff14"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#0d0221", "#1a0436", "#2d0a4e", "#4a0f5f", "#6b1a6b"], 0, 27);
      let x = 0;
      while (x < GRID) { // back skyline
        const w = 3 + R.int(4), h = 9 + R.int(10);
        rectPx(b, x, 28 - h, w, h, hex("#1f0c36"));
        for (let i = 0; i < 3; i++) setPx(b, x + R.int(w), 28 - h + 1 + R.int(h - 2), hex("#4a2d6e"));
        x += w;
      }
      const neon = ["#ff2bd6", "#00f0ff", "#f9f871"];
      const signs = [];
      x = R.int(2);
      while (x < GRID) { // front skyline
        const w = 3 + R.int(4), h = 4 + R.int(8);
        rectPx(b, x, 28 - h, w, h, hex("#0b0416"));
        for (let i = 0; i < w * h * 0.12; i++) setPx(b, x + R.int(w), 28 - h + 1 + R.int(h - 1), hex(R.pick(neon)));
        if (R.chance(0.35) && (x < 9 || x > 21)) signs.push({ x: x + Math.floor(w / 2), y: 28 - h - 4, c: hex(R.pick(neon)), ph: R.int(97) });
        x += w + R.int(2);
      }
      for (let y = 28; y < GRID; y++) for (let xx = 0; xx < GRID; xx++) {
        const src = getPx(b, xx, 27 - (y - 28) * 2);
        setPx(b, xx, y, mix(hex("#120720"), src, BAYER[(y % 2) * 2 + (xx % 2)] < 0.5 ? 0.35 : 0.1));
      }
      return {
        base: b,
        anim(fb, t) { // flickering neon signs
          signs.forEach((s) => {
            const on = mod(t + s.ph, 97) > 6 && mod(t + s.ph, 31) !== 3;
            for (let i = 0; i < 4; i++) setPx(fb, s.x, s.y + i, on ? s.c : hex("#2a1640"));
          });
        },
      };
    },
  },
  {
    key: "hydro", name: "Hydro Depths", mood: "negative", particle: "bubbles",
    words: ["tidal", "abyss", "aqua", "wave", "deep"],
    bodies: ["#5cffe1", "#7fb0ff", "#ff9ecd", "#ffd166", "#b39cff", "#9bf6ff"],
    accents: ["#ff6f91", "#ffd166", "#ffffff", "#5cffe1"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#0a4f8a", "#083c6e", "#062c55", "#041d3b", "#02112a"]);
      const ph = R.next() * 6;
      for (let x = 0; x < GRID; x++) {
        const h = 28 + Math.round(Math.sin(x * 0.45 + ph) * 1.5 + Math.sin(x * 0.17) * 1);
        for (let y = h; y < GRID; y++) setPx(b, x, y, hex(y === h ? "#132a40" : "#0a1a2b"));
      }
      const glow = [];
      for (let i = 0; i < 9; i++) glow.push({ x: R.int(GRID), y: 14 + R.int(16), ph: R.next() * 6, sp: R.range(0.03, 0.08) });
      return {
        base: b,
        anim(fb, t) {
          for (let x = 0; x < GRID; x++) { // wavy surface + light shafts
            const w = Math.sin(x * 0.6 + t * 0.08) > 0.2;
            setPx(fb, x, 0, hex(w ? "#5ec8ff" : "#2f8fd6"));
            if (mod(x + Math.floor(t * 0.03), 9) < 2) for (let y = 1; y < 14; y++) blendPx(fb, x + Math.floor(y / 3), y, hex("#5ec8ff"), 0.12);
          }
          glow.forEach((g) => {
            const v = (Math.sin(t * g.sp + g.ph) + 1) / 2;
            setPx(fb, g.x, g.y, mix(hex("#0b3550"), hex("#5cffe1"), v));
          });
        },
      };
    },
  },
  {
    key: "forest", name: "Underwater Forest", mood: "positive", particle: "bubbles",
    words: ["kelp", "coral", "lagoon", "pearl", "reef"],
    bodies: ["#ffa36c", "#ff7a8a", "#ffe066", "#b5ff7a", "#9bf6ff", "#d9a6ff"],
    accents: ["#ff5d8f", "#ffe066", "#ffffff", "#3b5bdb"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#4fd0d6", "#2aa7b5", "#1b8a9e", "#136f86", "#0e5a70"]);
      for (let y = 28; y < GRID; y++) for (let x = 0; x < GRID; x++)
        setPx(b, x, y, hex(BAYER[(y % 2) * 2 + (x % 2)] < 0.5 ? "#e8d39a" : "#d4bd7f"));
      for (let i = 0; i < 3; i++) { // coral
        const cx = sideX(R, 1), c = hex(R.pick(["#ff7a8a", "#ffa36c", "#ff5dc8"]));
        for (let y = 0; y < 4; y++) setPx(b, cx, 27 - y, c);
        setPx(b, cx - 1, 25, c); setPx(b, cx - 1, 24, c); setPx(b, cx + 1, 26, c); setPx(b, cx + 1, 25, c);
      }
      for (let i = 0; i < 3; i++) setPx(b, R.int(GRID), 29 + R.int(3), hex("#fff3e0"));
      const kelp = [];
      for (let i = 0; i < 7; i++) kelp.push({ x: R.int(GRID), h: 10 + R.int(12), ph: R.next() * 6, c: hex(R.pick(["#2e9e5b", "#1f7a45", "#3fbf6a"])) });
      return {
        base: b,
        anim(fb, t) {
          for (let x = 0; x < GRID; x++) // sunbeams
            if (mod(x - Math.floor(t * 0.02), 11) < 2) for (let y = 0; y < 26; y++) blendPx(fb, x + Math.floor(y / 4), y, hex("#ffffff"), 0.1);
          kelp.forEach((k) => {
            for (let j = 0; j < k.h; j++) {
              const y = 27 - j;
              const sway = Math.round(Math.sin(t * 0.04 + j * 0.35 + k.ph) * (j / k.h) * 1.6);
              setPx(fb, k.x + sway, y, k.c);
              if (j % 3 === 1) setPx(fb, k.x + sway + (j % 6 === 1 ? 1 : -1), y, mix(k.c, 0xffffff, 0.2));
            }
          });
        },
      };
    },
  },
  {
    key: "candy", name: "Candyland", mood: "positive", particle: "sprinkles",
    words: ["sugar", "gumdrop", "frosted", "candy", "sprinkle"],
    bodies: ["#ff6fb5", "#7ad7ff", "#ffd166", "#b28dff", "#7cf7a8", "#ff8c69"],
    accents: ["#ffffff", "#ff3d7f", "#3dc1ff", "#ffe14d"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#ffe0f3", "#ffc8ea", "#ffb3e0", "#ff9fd6"]);
      for (let i = 0; i < 3; i++) { // cotton candy clouds
        const cx = R.int(GRID), cy = 2 + R.int(9), c = hex(R.pick(["#fff0fa", "#d8eeff"]));
        rectPx(b, cx - 3, cy, 7, 2, c); rectPx(b, cx - 2, cy - 1, 4, 1, c);
      }
      for (let i = 0; i < 2; i++) { // lollipops
        const lx = i === 0 ? 3 + R.int(3) : 26 + R.int(3), ly = 14 + R.int(5);
        rectPx(b, lx, ly + 2, 1, 26 - ly, hex("#ffffff"));
        discPx(b, lx, ly, 2, hex(R.pick(["#ff3d7f", "#3dc1ff", "#ffe14d", "#9d6bff"])));
        setPx(b, lx, ly, hex("#ffffff")); setPx(b, lx + 1, ly - 1, hex("#ffffff")); setPx(b, lx - 1, ly + 1, hex("#ffffff"));
      }
      const ph = R.next() * 6;
      for (let x = 0; x < GRID; x++) {
        const h = 26 + Math.round(Math.sin(x * 0.4 + ph));
        const drip = mod(x * 7 + 3, 5) === 0 ? 2 : 0;
        for (let y = h; y < GRID; y++) setPx(b, x, y, hex(y <= h + 1 + drip ? "#fff5fb" : "#8b4a2b"));
      }
      for (let i = 0; i < 12; i++) setPx(b, R.int(GRID), 29 + R.int(3), hex(R.pick(["#ff3d7f", "#3dc1ff", "#ffe14d", "#7cf7a8"])));
      for (let i = 0; i < 2; i++) { // gumdrops
        const gx = sideX(R, 2), c = hex(R.pick(["#ff3d7f", "#7cf7a8", "#ffe14d"]));
        rectPx(b, gx - 1, 26, 3, 2, c); setPx(b, gx, 25, c); setPx(b, gx - 1, 26, mix(c, 0xffffff, 0.5));
      }
      return { base: b, anim: null };
    },
  },
  {
    key: "goa", name: "Goa Sunset", mood: "positive", particle: "gulls",
    words: ["goan", "sunset", "beachy", "coconut", "feni", "susegad"],
    bodies: ["#ff8c5a", "#ffd166", "#7cf7d4", "#ff6fb5", "#8fd3ff", "#c9a0ff"],
    accents: ["#034f46", "#ffffff", "#ff3d7f", "#2d62ff"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#5b2e86", "#b24f7d", "#f0715a", "#ffa946", "#ffd28a"], 0, 19);
      const sx = sideX(R, 3), sy = 19;
      discPx(b, sx, sy, 4, hex("#ffe9a8"));
      discPx(b, sx, sy, 3, hex("#fff4cc"));
      gradient(b, ["#2a7f95", "#1d6a80", "#145a73"], 20, 26);
      for (let y = 27; y < GRID; y++) for (let x = 0; x < GRID; x++)
        setPx(b, x, y, hex(BAYER[(y % 2) * 2 + (x % 2)] < 0.5 ? "#f2d29b" : "#e6bf7f"));
      for (let x = 0; x < GRID; x++) setPx(b, x, 27, hex(mod(x, 5) === 0 ? "#ffffff" : "#d8f3ee")); // foam line
      // palm tree on the opposite side of the sun
      const px = sx < 16 ? 26 + R.int(3) : 3 + R.int(3), lean = sx < 16 ? -1 : 1;
      const trunk = hex("#7a4a2a"), trunk2 = hex("#5c361d");
      let tx = px, top = 11 + R.int(3);
      for (let y = 29; y >= top; y--) {
        if ((29 - y) % 6 === 5) tx += lean;
        setPx(b, tx, y, (y % 2) ? trunk : trunk2);
      }
      const leaf = hex("#2f7d3a"), leaf2 = hex("#3fa04a");
      [[-1, 0], [1, 0], [-1, 1], [1, 1], [0, -1]].forEach(([dx, dy], i) => {
        for (let k = 1; k <= 4; k++) setPx(b, tx + dx * k, top + dy * k + (k > 2 && dy === 0 ? 1 : 0), i % 2 ? leaf : leaf2);
      });
      setPx(b, tx - 1, top + 1, hex("#6b3f1f")); setPx(b, tx + 1, top + 1, hex("#6b3f1f")); // coconuts
      return {
        base: b,
        anim(fb, t) { // sun glints dancing on the water
          for (let y = 21; y < 27; y++) {
            const w = 4 - Math.floor((26 - y) / 2);
            for (let x = sx - w; x <= sx + w; x++)
              if (mod(x * 3 + y * 5 + Math.floor(t / 7), 4) === 0) setPx(fb, x, y, hex("#ffe9a8"));
          }
        },
      };
    },
  },
];

/* ---------------------------------------------------------------------
   4. Mood (sentiment.js) and theme choice
   --------------------------------------------------------------------- */
let sentimentEngine = null;
const sentimentReady = new Promise((resolve) => {
  const done = () => {
    try { if (window.Sentiment) sentimentEngine = new window.Sentiment(); } catch (e) { sentimentEngine = null; }
    resolve();
  };
  if (window.Sentiment) return done();
  window.addEventListener("sentiment-ready", done, { once: true });
  setTimeout(done, 5000); // never block forever
});

const FALLBACK_LEXICON = {
  love: 3, happy: 3, joy: 3, sunny: 2, great: 3, fun: 2, awesome: 3, cute: 2, sweet: 2, yay: 3, smile: 2,
  sad: -2, cry: -2, alone: -2, miss: -2, rain: -1, dark: -1, haunted: -2, scared: -2, hate: -3, tired: -2, lonely: -2, gloomy: -2,
};
function analyzeMood(sentence) {
  const text = (sentence || "").trim();
  let score = 0, comparative = 0;
  if (text) {
    if (sentimentEngine) {
      const r = sentimentEngine.analyze(text);
      score = r.score; comparative = r.comparative;
    } else {
      const words = text.toLowerCase().match(/[a-z']+/g) || [];
      words.forEach((w) => { score += FALLBACK_LEXICON[w] || 0; });
      comparative = words.length ? score / words.length : 0;
    }
  }
  const label = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { score, comparative, label };
}

function pickTheme(R, mood) {
  const strength = mood.label === "neutral" ? 0 : Math.min(1, 0.45 + Math.abs(mood.comparative) * 1.5);
  const weights = THEMES.map((t) => {
    if (mood.label === "neutral") return 1;
    if (t.mood === mood.label) return 1 + 5 * strength;      // lean toward matching mood
    if (t.mood === "neutral") return 1;
    return Math.max(0.25, 1 - strength);                      // lean away from opposite mood
  });
  return R.weighted(THEMES, weights);
}

/* ---------------------------------------------------------------------
   5. Characters: symbol templates (left half, mirrored to 16 x 18)
   . empty  B body  D body shade  L body light  A accent  W white
   K ink    H hair  C cape
   --------------------------------------------------------------------- */
const TYPES = [
  { key: "cat", name: "cat", eye: [3, 7], mouth: 10, headTop: 5, neck: 12, tpl: [
    "........", "........", "..B.....", "..BB....", "..BAB...", "..BBBBBB", ".BBBBBBB", ".BBBBBBB",
    ".BBBBBBB", ".BBBBBBA", ".BBBBBBB", "..BBBBBB", "...BBBBB", "..BBBLLL", "..BBBLLL", "..BBBLLL",
    "..BBBBBB", "..DDD..."] },
  { key: "fox", name: "fox", eye: [3, 7], mouth: 11, headTop: 5, neck: 13, tpl: [
    "........", ".B......", ".BB.....", ".BAB....", ".BAAB...", ".BBBBBBB", "BBBBBBBB", "BBBBBBBB",
    "BBBBBBBB", "WWBBBBBB", ".WWWBBBK", "..WWWWWW", "...WWWWW", "..BBBWWW", "..BBBWWW", "..BBBWWW",
    "..BBBBBB", "..DDD..."] },
  { key: "owl", name: "owl", eye: [2, 7], mouth: 12, headTop: 5, neck: 13, tpl: [
    "........", "........", "........", ".D......", ".DD.....", ".BBBBBBB", "BBLLLBBB", "BLLLLLBB",
    "BLLLLLBB", "BLLLLLBB", "BBLLLBBA", "BBBBBBBA", "BDBBBBBB", "BDBLLLLL", "BDBLDLLD", "BDBLLLLL",
    ".BBBBBBB", "...AA..."] },
  { key: "frog", name: "frog", eye: [1, 4], mouth: 9, headTop: 6, neck: 11, tpl: [
    "........", "........", "........", "........", ".BBB....", "BBBBB...", "BBBBBBBB", "BBBBBBBB",
    "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", ".BBBBBBB", "..LLLLLL", ".BLLLLLL", "BBLLLLLL", "BBLLLLLL",
    ".BBBBBBB", "BBBB...."] },
  { key: "bunny", name: "bunny", eye: [3, 7], mouth: 10, headTop: 5, neck: 12, tpl: [
    "...B....", "..BAB...", "..BAB...", "..BAB...", "..BAB...", "..BBBBBB", ".BBBBBBB", ".BBBBBBB",
    ".BBBBBBB", ".BBBBBBA", ".BBBBBBB", "..BBBBBB", "...LLLLL", "..BLLLLL", "..BLLLLL", "..BLLLLL",
    "..BBBBBB", "..LLL..."] },
  { key: "ghost", name: "ghost", eye: [3, 7], mouth: 10, headTop: 3, neck: 12, tpl: [
    "........", "........", "........", "....BBBB", "..BBBBBB", ".BBBBBBB", ".BBBBBBB", "BBBBBBBB",
    "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB",
    "BBBBBBBB", "B..BB..B"] },
  { key: "robot", name: "robot", eye: [3, 6], mouth: 9, headTop: 3, neck: 11, eyes: ["glow", "round", "wide"], tpl: [
    ".......A", ".......K", ".......K", ".DDDDDDD", ".DBBBBBB", ".DBBBBBB", "DDBBBBBB", "DDBBBBBB",
    ".DBBBBBB", ".DBBBBBB", ".DDDDDDD", "....DDDD", "..BBBBBB", "DBBLLLLL", "DBBLALAL", "DBBLLLLL",
    "..BBBBBB", "..DDD..."] },
  { key: "slime", name: "slime", eye: [3, 11], mouth: 14, headTop: 7, neck: 15, tpl: [
    "........", "........", "........", "........", "........", "........", "......BB", "....BBBB",
    "...BLBBB", "..BLBBBB", ".BBBBBBB", ".BBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB",
    "BBBBBBBB", ".DDDDDDD"] },
  { key: "alien", name: "alien", eye: [2, 6], mouth: 9, headTop: 3, neck: 12, eyes: ["big", "glow", "wide"], tpl: [
    "..A.....", "...K....", "....K...", "...BBBBB", "..BBBBBB", ".BBBBBBB", "BBBBBBBB", "BBBBBBBB",
    "BBBBBBBB", ".BBBBBBB", "..BBBBBB", "...BBBBB", ".....BBB", "...BBBBB", "..BBLLLL", ".BBBLLLL",
    "...BBBBB", "...BB..."] },
  { key: "dragon", name: "mini dragon", eye: [3, 6], mouth: 10, headTop: 3, neck: 11, tpl: [
    "........", "..A.....", "..AA....", "...BBBBA", "..BBBBBB", "..BBBBBB", "..BBBBBB", "..BBBBBB",
    "..BBBBBB", "...LLLKL", "...LLLLL", "D...BBBB", "DD.BBBBB", "DDDBLLLL", "DDDBLLLL", ".DDBLLLL",
    "...BBBBB", "...BB..."] },
  { key: "monster", name: "monster", eye: [3, 7], mouth: 10, headTop: 4, neck: 12, fangs: true, tpl: [
    "........", "........", ".A......", ".AB.....", ".BBBBBBB", "DBBBBBBB", "BBBBBBBB", "BBBBBBBB",
    "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "DBBBBBBB", "BBBBBBBB", "BBBLLLLL", "DBBLLLLL", "BBBLLLLL",
    ".BBBBBBB", ".DDD...."] },
  { key: "vamp", name: "vamp", eye: [3, 7], mouth: 10, headTop: 2, neck: 12, fangs: true, tpl: [
    "........", "........", "...HHHHH", "..HHHHHH", ".HHHHHHH", ".HBBBBHH", ".BBBBBBB", ".BBBBBBB",
    ".BBBBBBB", ".BBBBBBB", "C.BBBBBB", "CC.BBBBB", "CCCKLLLL", "CCCKKLLL", "CCCKKKLL", "CCCKKKKA",
    ".CCKKKKK", "..KK...."] },
];

const EYE_STYLES = {
  round: [[0, 0, "K"], [1, 0, "K"], [0, 1, "K"], [1, 1, "K"], [0, 0, "W"]],
  big:   [[0, 0, "K"], [1, 0, "W"], [0, 1, "K"], [1, 1, "K"]],
  dot:   [[1, 0, "K"], [1, 1, "K"]],
  wide:  [[0, 0, "W"], [1, 0, "W"], [0, 1, "W"], [1, 1, "K"]],
  glow:  [[0, 0, "A"], [1, 0, "W"], [0, 1, "A"], [1, 1, "A"]],
};
const ACCESSORIES = ["hat", "crown", "headphones", "glasses", "scarf", "none"];

// Sprite working buffer: template (16x18) sits at (OX, OY) so hats and
// outlines have room. The whole buffer is drawn at grid (SPR_X, SPR_Y),
// putting the body at grid columns 8..23 and rows 7..24, safely inside
// the circular crop (radius 16 around the centre).
const SW = 24, SH = 26, OX = 4, OY = 5, SPR_X = 4, SPR_Y = 2;
const INK = hex("#1a1423"), OUTLINE = hex("#07050b"), WHITE = hex("#f7f3ea");

function symbolColors(type, body, accent) {
  const c = {
    B: body, D: mix(body, 0x000000, 0.35), L: mix(body, 0xffffff, 0.55), A: accent,
    W: WHITE, K: INK, H: mix(body, 0x0b0612, 0.82), C: mix(hex("#6a0d2b"), accent, 0.25),
  };
  if (type.key === "ghost") { c.B = mix(body, 0xffffff, 0.68); c.D = mix(c.B, body, 0.5); c.L = 0xffffff; }
  if (type.key === "vamp") { c.B = mix(body, hex("#f4e8ee"), 0.78); c.L = WHITE; }
  return c;
}

function buildCharacter(R, theme) {
  const type = R.pick(TYPES);
  const body = hex(R.pick(theme.bodies));
  const accentChoices = theme.accents.filter((a) => hex(a) !== body);
  const accent = hex(R.pick(accentChoices));
  const eyeStyle = R.pick(type.eyes || Object.keys(EYE_STYLES));
  const accessory = R.pick(ACCESSORIES);
  const colors = symbolColors(type, body, accent);

  const base = new Int32Array(SW * SH).fill(-1);
  const put = (x, y, c) => { // template coords, mirrored automatically
    const bx = OX + x, by = OY + y, mx = OX + (15 - x);
    if (by < 0 || by >= SH) return;
    if (bx >= 0 && bx < SW) base[by * SW + bx] = c;
    if (mx >= 0 && mx < SW) base[by * SW + mx] = c;
  };
  const filled = (x, y) => {
    const bx = OX + x, by = OY + y;
    return bx >= 0 && by >= 0 && bx < SW && by < SH && base[by * SW + bx] !== -1;
  };

  type.tpl.forEach((row, y) => {
    for (let x = 0; x < 8; x++) { const s = row[x]; if (s !== ".") put(x, y, colors[s]); }
  });

  const [ex, ey] = type.eye, hT = type.headTop;
  if (accessory === "hat") {
    const hat = hex("#1d1726");
    for (let x = 4; x <= 7; x++) put(x, hT - 1, hat);
    for (let y = hT - 4; y <= hT - 2; y++) for (let x = 5; x <= 7; x++) put(x, y, y === hT - 2 ? accent : hat);
  } else if (accessory === "crown") {
    const gold = hex("#ffcc33"), dark = hex("#c98a1a");
    for (let x = 5; x <= 7; x++) put(x, hT - 1, dark);
    for (let x = 5; x <= 7; x++) put(x, hT - 2, gold);
    put(7, hT - 2, hex("#ff3b6b"));
    put(5, hT - 3, gold); put(7, hT - 3, gold);
  } else if (accessory === "headphones") {
    const band = hex("#2b2b3a");
    let left = 0;
    while (left < 8 && !filled(left, ey)) left++;
    for (let x = left; x <= 7; x++) put(x, hT - 1, band);
    for (let y = hT - 1; y <= ey - 2; y++) put(left - 1, y, band);
    for (let y = ey - 1; y <= ey + 1; y++) { put(left - 1, y, accent); put(left, y, mix(accent, 0x000000, 0.3)); }
  } else if (accessory === "scarf") {
    const n = type.neck, stripe = mix(accent, 0xffffff, 0.55);
    let left = 0;
    while (left < 8 && !filled(left, n)) left++;
    for (let x = Math.max(0, left - 1); x <= 7; x++) { put(x, n, accent); put(x, n + 1, x % 2 ? stripe : accent); }
    put(Math.max(0, left - 1), n + 2, accent); put(Math.max(0, left - 1), n + 3, stripe);
  }

  // dark outline around the whole silhouette (4-neighbour)
  const outline = new Uint8Array(SW * SH);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    if (base[y * SW + x] !== -1) continue;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < SW && ny < SH && base[ny * SW + nx] !== -1;
    });
    if (n) outline[y * SW + x] = 1;
  }
  return { type, body, accent, eyeStyle, accessory, colors, base, outline };
}

// Draw the character for frame t into the 32x32 frame buffer
function drawCharacter(fb, scene, t, still) {
  const ch = scene.character, { type, colors } = ch;
  const bob = still ? 0 : Math.round(Math.sin(t * 0.06));
  const blink = !still && mod(t + scene.blinkPhase, scene.blinkPeriod) < 7;

  const sprite = Int32Array.from(ch.base);
  const put = (x, y, c) => {
    const by = OY + y;
    [OX + x, OX + (15 - x)].forEach((bx) => {
      if (bx >= 0 && by >= 0 && bx < SW && by < SH) sprite[by * SW + bx] = c;
    });
  };
  const at = (x, y) => sprite[(OY + y) * SW + OX + x];
  const [ex, ey] = type.eye, my = type.mouth, mood = scene.mood.label;

  // eyes
  if (blink) { put(ex, ey + 1, INK); put(ex + 1, ey + 1, INK); }
  else EYE_STYLES[ch.eyeStyle].forEach(([dx, dy, s]) => put(ex + dx, ey + dy, colors[s] ?? INK));

  // cheeks + mouth follow the mood
  if (mood === "positive") {
    const blush = mix(ch.body, hex("#ff5c8a"), 0.6);
    if (at(ex - 1, ey + 2) !== -1) put(ex - 1, ey + 2, blush);
    put(6, my, INK); put(7, my + 1, INK);
  } else if (mood === "negative") {
    put(7, my, INK); put(6, my + 1, INK);
    const drop = still ? 0 : Math.floor(t / 9) % 3;
    put(ex, ey + 2 + drop, hex("#7fd4ff"));
    if (drop > 0) put(ex, ey + 1 + drop, mix(hex("#7fd4ff"), 0xffffff, 0.5));
  } else {
    put(6, my, INK); put(7, my, INK);
  }
  if (type.fangs && mood !== "negative") put(6, my + 1, WHITE);

  // glasses sit on top of the eyes
  if (ch.accessory === "glasses") {
    const frame = lum(ch.body) > 0.55 ? hex("#221a2e") : hex("#f2f2f2");
    for (let x = ex - 1; x <= ex + 2; x++) { put(x, ey - 1, frame); put(x, ey + 2, frame); }
    put(ex - 1, ey, frame); put(ex - 1, ey + 1, frame); put(ex + 2, ey, frame); put(ex + 2, ey + 1, frame);
    for (let x = ex + 3; x <= 7; x++) put(x, ey, frame);
  }

  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const c = sprite[y * SW + x];
    if (c !== -1) setPx(fb, SPR_X + x, SPR_Y + y + bob, c);
    else if (ch.outline[y * SW + x]) setPx(fb, SPR_X + x, SPR_Y + y + bob, OUTLINE);
  }
}

/* ---------------------------------------------------------------------
   6. Particles (positions are pure functions of seeded params + t)
   --------------------------------------------------------------------- */
function initParticles(kind, R) {
  const P = [];
  const n = { rain: 38, bats: 4, stars: 18, bubbles: 14, petals: 16, neonrain: 26, sprinkles: 22, gulls: 4 }[kind] || 0;
  for (let i = 0; i < n; i++) {
    P.push({
      x: R.next() * GRID, y: R.next() * 40, sp: R.next(), ph: R.next() * 6.283,
      dir: R.chance(0.5) ? 1 : -1, c: R.int(4), size: R.chance(0.35) ? 2 : 1,
    });
  }
  return P;
}

const BAT_UP = ["X...X", ".XXX."], BAT_DOWN = [".XXX.", "X...X"];
const GULL_UP = ["X...X", ".X.X.", "..X.."], GULL_DOWN = [".....", "XX.XX", "..X.."];
function drawParticles(fb, scene, t) {
  const kind = scene.theme.particle;
  scene.particles.forEach((p) => {
    switch (kind) {
      case "rain": {
        const y = mod(p.y + t * (0.6 + p.sp * 0.5), 40) - 4;
        const x = mod(p.x + y * 0.25, GRID);
        setPx(fb, x, y, hex("#a9c8ea")); blendPx(fb, x - 0.25, y - 1, hex("#a9c8ea"), 0.5);
        break;
      }
      case "bats": {
        const x = mod(p.x + p.dir * t * (0.08 + p.sp * 0.1), GRID + 10) - 5;
        const y = 3 + (p.y % 15) + Math.round(Math.sin(t * 0.05 + p.ph) * 1.5);
        const frame = Math.floor((t + p.ph * 10) / 6) % 2 ? BAT_UP : BAT_DOWN;
        frame.forEach((row, j) => { for (let i = 0; i < 5; i++) if (row[i] === "X") setPx(fb, x + i, y + j, hex("#0b0612")); });
        break;
      }
      case "gulls": {
        const x = mod(p.x + p.dir * t * (0.05 + p.sp * 0.06), GRID + 10) - 5;
        const y = 2 + (p.y % 10) + Math.round(Math.sin(t * 0.03 + p.ph));
        const frame = Math.floor((t + p.ph * 10) / 9) % 2 ? GULL_UP : GULL_DOWN;
        frame.forEach((row, j) => { for (let i = 0; i < 5; i++) if (row[i] === "X") setPx(fb, x + i, y + j, hex("#3a2340")); });
        break;
      }
      case "stars": {
        const x = p.x, y = (p.y / 40) * 21;
        const v = (Math.sin(t * (0.03 + p.sp * 0.06) + p.ph) + 1) / 2;
        setPx(fb, x, y, mix(hex("#2c2c55"), 0xffffff, v));
        if (v > 0.88) [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => blendPx(fb, x + dx, y + dy, hex("#9fb4ff"), 0.7));
        break;
      }
      case "bubbles": {
        const y = mod(p.y - t * (0.12 + p.sp * 0.2), 40) - 4;
        const x = p.x + Math.round(Math.sin(t * 0.05 + p.ph));
        if (p.size === 1) blendPx(fb, x, y, hex("#dfffff"), 0.75);
        else {
          blendPx(fb, x, y, 0xffffff, 0.9);
          [[1, 0], [0, 1], [1, 1]].forEach(([dx, dy]) => blendPx(fb, x + dx, y + dy, hex("#8fe8f5"), 0.55));
        }
        break;
      }
      case "petals": {
        const sp = 0.1 + p.sp * 0.12;
        const y = mod(p.y + t * sp, 38) - 3;
        const x = mod(p.x + t * sp * 0.6 + Math.sin(t * 0.04 + p.ph) * 2, GRID);
        const c = hex(["#ff9ecd", "#ffffff", "#ffd1e8", "#ffb3c7"][p.c]);
        setPx(fb, x, y, c);
        if (Math.floor(t / 15 + p.ph) % 2) setPx(fb, x + 1, y, c); else setPx(fb, x, y + 1, c);
        break;
      }
      case "neonrain": {
        const y = mod(p.y + t * (0.8 + p.sp * 0.6), 40) - 4;
        const c = hex(["#ff2bd6", "#00f0ff", "#ff2bd6", "#f9f871"][p.c]);
        setPx(fb, p.x, y, c); blendPx(fb, p.x, y - 1, c, 0.6); blendPx(fb, p.x, y - 2, c, 0.3);
        break;
      }
      case "sprinkles": {
        const y = mod(p.y + t * (0.12 + p.sp * 0.13), 38) - 3;
        const x = p.x + Math.round(Math.sin(t * 0.03 + p.ph));
        const c = hex(["#ff3d7f", "#3dc1ff", "#ffe14d", "#7cf7a8"][p.c]);
        setPx(fb, x, y, c);
        if (Math.floor(t * 0.05 + p.ph) % 2) setPx(fb, x + 1, y, c); else setPx(fb, x, y + 1, c);
        break;
      }
    }
  });
}

/* ---------------------------------------------------------------------
   7. Names
   --------------------------------------------------------------------- */
const ADJECTIVES = {
  positive: ["sparkly", "bloomy", "sunny", "bubbly", "giggly", "cozy", "zesty", "dreamy", "jolly", "glowy"],
  negative: ["gloomy", "mopey", "soggy", "grumpy", "sleepy", "spooky", "teary", "broody", "misty", "moody"],
  neutral:  ["curious", "tiny", "sneaky", "chill", "wobbly", "quiet", "fuzzy", "lucky", "zippy", "pixel"],
};
function makeName(R, theme, type, mood) {
  const pool = R.chance(0.75) ? ADJECTIVES[mood.label] : ADJECTIVES[R.pick(["positive", "negative", "neutral"])];
  return `${R.pick(pool)} ${R.pick(theme.words)} ${type.name}`;
}

/* ---------------------------------------------------------------------
   8. Scene = everything derived from (seed, sentence)
   The order of R calls below is part of the "format": never reorder.
   --------------------------------------------------------------------- */
function buildScene(seed, sentence) {
  const R = makeRng(seed);
  const mood = analyzeMood(sentence);
  const theme = pickTheme(R, mood);
  const bg = theme.bg(R);
  const character = buildCharacter(R, theme);
  const particles = initParticles(theme.particle, R);
  const name = makeName(R, theme, character.type, mood);
  const blinkPeriod = 160 + R.int(140);
  const blinkPhase = R.int(blinkPeriod);
  return { seed, sentence, mood, theme, bg, character, particles, name, blinkPeriod, blinkPhase, startFrame: 0 };
}

const fb = newBuf();
const art = document.createElement("canvas");
art.width = art.height = GRID;
const artCtx = art.getContext("2d");
const artImg = artCtx.createImageData(GRID, GRID);

function renderArt(scene, t, still = false) {
  fb.set(scene.bg.base);
  if (scene.bg.anim) scene.bg.anim(fb, still ? 0 : t);
  drawParticles(fb, scene, still ? 0 : t);
  drawCharacter(fb, scene, t, still);
  const d = artImg.data;
  for (let i = 0; i < fb.length; i++) {
    const c = fb[i];
    d[i * 4] = (c >> 16) & 255; d[i * 4 + 1] = (c >> 8) & 255; d[i * 4 + 2] = c & 255; d[i * 4 + 3] = 255;
  }
  artCtx.putImageData(artImg, 0, 0);
  return art;
}

// tiny pixel-font stamp: "PIXELSO · NAME · #SEED"
function drawStamp(ctx, size, scene) {
  const label = `PIXELSO · ${scene.name.toUpperCase()} · ${seedToHex(scene.seed)}`;
  const barH = Math.round(size * 0.065);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "rgba(8, 5, 14, 0.78)";
  ctx.fillRect(0, size - barH, size, barH);
  let fs = Math.round(size / 40);
  ctx.font = `${fs}px "Press Start 2P", monospace`;
  while (ctx.measureText(label).width > size * 0.92 && fs > 6) { fs--; ctx.font = `${fs}px "Press Start 2P", monospace`; }
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, size / 2, size - barH / 2 + 1);
  ctx.restore();
}

/* ---------------------------------------------------------------------
   9. App state + p5 sketch
   --------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const ui = {
  sentence: $("sentence"), generate: $("generateBtn"), reroll: $("rerollBtn"), download: $("downloadBtn"),
  share: $("shareBtn"), copy: $("copyLinkBtn"), stamp: $("stampToggle"), bioToggle: $("bioToggle"),
  name: $("charName"), theme: $("themeName"), bio: $("bio"), seed: $("seedCode"), preview: $("preview"),
  gallery: $("gallery"), examples: $("examples"), settings: $("settings"), settingsBtn: $("settingsBtn"),
  apiKey: $("apiKey"), apiModel: $("apiModel"), saveKey: $("saveKeyBtn"), clearKey: $("clearKeyBtn"), toast: $("toast"),
};
const previewCtx = ui.preview.getContext("2d");
let scene = null;
let mainCtx = null;
let bioRequestId = 0;

// p5 global mode
function setup() {
  const c = createCanvas(SIZE, SIZE);
  c.parent("stage");
  pixelDensity(1);
  noSmooth();
  frameRate(30);
  mainCtx = drawingContext;
  init();
}

function draw() {
  if (!scene) { background(14, 11, 22); return; }
  const t = frameCount - scene.startFrame;
  renderArt(scene, t);
  mainCtx.imageSmoothingEnabled = false;
  mainCtx.drawImage(art, 0, 0, SIZE, SIZE);
  if (ui.stamp.checked) drawStamp(mainCtx, SIZE, scene);
  previewCtx.imageSmoothingEnabled = false;
  previewCtx.drawImage(art, 0, 0, ui.preview.width, ui.preview.height);
}

/* Redraw everything from a given seed (used by links, gallery, rerolls) */
function drawFromSeed(seed, sentence = "", { save = true } = {}) {
  scene = buildScene(seed >>> 0, sentence);
  scene.startFrame = typeof frameCount === "number" ? frameCount : 0;
  ui.name.textContent = scene.name;
  ui.theme.textContent = `${scene.theme.name} · ${scene.mood.label} mood`;
  ui.seed.textContent = seedToHex(seed);
  ui.bio.classList.add("hidden");
  ui.bio.textContent = "";
  if (save) addToGallery(scene);
  renderGallery();
  maybeFetchBio(scene);
  return scene;
}

function generate(newTime = true) {
  const sentence = ui.sentence.value.trim();
  if (!sentence) { toast("Type a sentence first"); ui.sentence.focus(); return; }
  const seed = makeSeed(sentence, newTime ? Date.now() : 0);
  drawFromSeed(seed, sentence);
  history.replaceState(null, "", location.pathname); // fresh avatar, clean URL
}

async function init() {
  loadSettings();
  await sentimentReady;
  try { await document.fonts.load('16px "Press Start 2P"'); } catch (e) { /* font is optional */ }

  const params = new URLSearchParams(location.search);
  const linkedSeed = hexToSeed(params.get("seed"));
  if (linkedSeed !== null) {
    const s = params.get("s") || "";
    ui.sentence.value = s;
    drawFromSeed(linkedSeed, s);
  } else {
    const items = readGallery();
    if (items.length) { ui.sentence.value = items[0].sentence; drawFromSeed(items[0].seed, items[0].sentence, { save: false }); }
    else drawFromSeed(makeSeed("hello pixel world", Date.now()), "hello pixel world", { save: false });
  }
  if (canShareFiles()) ui.share.classList.remove("hidden");
}

/* ---------------------------------------------------------------------
   10. Export, share, link
   --------------------------------------------------------------------- */
function renderExportCanvas() {
  const out = document.createElement("canvas");
  out.width = out.height = EXPORT_SIZE;
  const ctx = out.getContext("2d");
  renderArt(scene, 0, true);       // fresh, still frame
  ctx.imageSmoothingEnabled = false; // nearest-neighbour scaling
  ctx.drawImage(art, 0, 0, EXPORT_SIZE, EXPORT_SIZE);
  if (ui.stamp.checked) drawStamp(ctx, EXPORT_SIZE, scene);
  return out;
}
const fileName = () => `pixelso-${scene.name.replace(/\s+/g, "-")}-${seedToHex(scene.seed).slice(1)}.png`;
const toBlob = (canvas) => new Promise((res) => canvas.toBlob(res, "image/png"));

async function downloadPNG() {
  if (!scene) return;
  const blob = await toBlob(renderExportCanvas());
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Saved 1080 x 1080 PNG");
}

function canShareFiles() {
  try {
    const f = new File([new Blob()], "x.png", { type: "image/png" });
    return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [f] }));
  } catch (e) { return false; }
}
async function sharePNG() {
  if (!scene) return;
  const blob = await toBlob(renderExportCanvas());
  const file = new File([blob], fileName(), { type: "image/png" });
  try {
    await navigator.share({ files: [file], title: "My Pixelso", text: `Meet ${scene.name} ${seedToHex(scene.seed)}` });
  } catch (e) {
    if (e && e.name !== "AbortError") downloadPNG();
  }
}

function shareURL() {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("seed", seedToHex(scene.seed).slice(1));
  if (scene.sentence) url.searchParams.set("s", scene.sentence);
  return url.toString();
}
async function copyLink() {
  if (!scene) return;
  const link = shareURL();
  history.replaceState(null, "", link);
  try { await navigator.clipboard.writeText(link); }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = link; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) { /* ignore */ }
    ta.remove();
  }
  toast("Link copied!");
}

/* ---------------------------------------------------------------------
   11. Gallery (last 8 in localStorage)
   --------------------------------------------------------------------- */
function readGallery() {
  try { const v = JSON.parse(localStorage.getItem(GALLERY_KEY)); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function writeGallery(items) {
  try { localStorage.setItem(GALLERY_KEY, JSON.stringify(items)); } catch (e) { /* storage full or blocked */ }
}
function addToGallery(sc) {
  renderArt(sc, 0, true);
  const thumb = art.toDataURL("image/png");
  const items = readGallery().filter((g) => !(g.seed === sc.seed && g.sentence === sc.sentence));
  items.unshift({ seed: sc.seed, sentence: sc.sentence, name: sc.name, theme: sc.theme.name, thumb });
  writeGallery(items.slice(0, 8));
}
function renderGallery() {
  const items = readGallery();
  ui.examples.classList.toggle("hidden", items.length > 0);
  ui.gallery.innerHTML = "";
  if (!items.length) {
    ui.gallery.innerHTML = '<span class="empty">Your last 8 avatars show up here.</span>';
    return;
  }
  items.forEach((g) => {
    const b = document.createElement("button");
    b.className = "thumb" + (scene && scene.seed === g.seed && scene.sentence === g.sentence ? " active" : "");
    b.title = `${g.name} · ${g.theme} · ${seedToHex(g.seed)}`;
    const img = document.createElement("img");
    img.src = g.thumb; img.alt = g.name;
    b.appendChild(img);
    b.addEventListener("click", () => { ui.sentence.value = g.sentence; drawFromSeed(g.seed, g.sentence, { save: false }); });
    ui.gallery.appendChild(b);
  });
}

/* ---------------------------------------------------------------------
   12. Optional AI bio via Gemini (key stays in this browser)
   --------------------------------------------------------------------- */
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { s = {}; }
  ui.apiKey.value = s.key || "";
  ui.apiModel.value = s.model || DEFAULT_MODEL;
  ui.stamp.checked = !!s.stamp;
  ui.bioToggle.checked = !!s.bio;
}
function saveSettings() {
  const s = { key: ui.apiKey.value.trim(), model: ui.apiModel.value.trim() || DEFAULT_MODEL, stamp: ui.stamp.checked, bio: ui.bioToggle.checked };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

async function maybeFetchBio(sc) {
  const id = ++bioRequestId;
  ui.bio.classList.add("hidden");
  const key = ui.apiKey.value.trim();
  if (!ui.bioToggle.checked || !key) return;
  const model = ui.apiModel.value.trim() || DEFAULT_MODEL;
  const prompt =
    `Write ONE funny, wholesome one-line bio (max 18 words, no hashtags, no quotes) for a pixel art character.\n` +
    `Name: ${sc.name}\nCharacter type: ${sc.character.type.name}\nTheme: ${sc.theme.name}\n` +
    `Mood: ${sc.mood.label}\nInspired by the sentence: "${sc.sentence}"`;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 1 } }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(" ").trim();
    const line = text.split("\n").map((l) => l.trim()).filter(Boolean)[0];
    if (!line || id !== bioRequestId) throw new Error("empty or stale");
    ui.bio.textContent = line.replace(/^["']|["']$/g, "").slice(0, 160);
    ui.bio.classList.remove("hidden");
  } catch (e) {
    if (id === bioRequestId) ui.bio.classList.add("hidden"); // fail silently
  }
}

/* ---------------------------------------------------------------------
   13. UI wiring
   --------------------------------------------------------------------- */
let toastTimer = null;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 1800);
}

ui.generate.addEventListener("click", () => generate());
ui.sentence.addEventListener("keydown", (e) => { if (e.key === "Enter") generate(); });
ui.reroll.addEventListener("click", () => generate()); // same sentence, new time
ui.download.addEventListener("click", downloadPNG);
ui.share.addEventListener("click", sharePNG);
ui.copy.addEventListener("click", copyLink);
ui.stamp.addEventListener("change", saveSettings);
ui.bioToggle.addEventListener("change", () => {
  saveSettings();
  if (ui.bioToggle.checked && !ui.apiKey.value.trim()) { toast("Add a Gemini key in settings"); ui.settings.showModal(); }
  else if (scene) maybeFetchBio(scene);
});
document.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => { ui.sentence.value = chip.textContent; generate(); }));
ui.settingsBtn.addEventListener("click", () => ui.settings.showModal());
ui.saveKey.addEventListener("click", () => { saveSettings(); toast("Settings saved"); if (scene) maybeFetchBio(scene); });
ui.clearKey.addEventListener("click", () => { ui.apiKey.value = ""; saveSettings(); toast("Key cleared"); });

/* Voice input: speak your sentence (Web Speech API, Chrome / Edge / Safari) */
(function setupVoice() {
  const btn = $("micBtn");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !btn) return;
  btn.classList.remove("hidden");
  let rec = null, listening = false;
  const stop = () => { listening = false; btn.classList.remove("listening"); btn.setAttribute("aria-pressed", "false"); };
  btn.addEventListener("click", () => {
    if (listening && rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = navigator.language || "en-IN";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      ui.sentence.value = (finalText + interim).trim();
    };
    rec.onerror = (e) => { stop(); if (e.error === "not-allowed") toast("Microphone access was blocked"); };
    rec.onend = () => { stop(); if (finalText.trim()) generate(); };
    listening = true;
    btn.classList.add("listening");
    btn.setAttribute("aria-pressed", "true");
    toast("Listening… say your sentence");
    try { rec.start(); } catch (e) { stop(); }
  });
})();

// expose for console / later features (shared rings)
window.Pixelso = { drawFromSeed, makeSeed, seedToHex, hexToSeed, buildScene };
