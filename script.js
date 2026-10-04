/* =====================================================================
   PIXEL SOUL · sentence -> seeded pixel soul
   Every random choice comes from ONE seeded generator (see makeRng).
   No Math.random() anywhere, so a seed + sentence always redraws the
   exact same avatar.
   ===================================================================== */
"use strict";

const GRID = 32;          // layout units per side (theme painters think in these)
const S = 2;              // fine pixels per layout unit
const FINE = GRID * S;    // 64: real art resolution (64 x 64 pixel art)
const SIZE = 640;         // on-screen canvas: 10 screen px per art pixel
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

// Buffers are FINE x FINE (64 x 64). Painters use layout units (0..32):
//   setPx / rectPx / blendPx  -> a full layout unit (2 x 2 fine pixels)
//   dotPx / dotBlend          -> a single fine pixel for small details
//   discPx / gradient         -> computed at fine resolution (smooth)
function newBuf() { return new Int32Array(FINE * FINE); }
function fineSet(buf, fx, fy, c) {
  if (fx >= 0 && fy >= 0 && fx < FINE && fy < FINE) buf[fy * FINE + fx] = c;
}
function fineBlend(buf, fx, fy, c, a) {
  if (fx >= 0 && fy >= 0 && fx < FINE && fy < FINE) buf[fy * FINE + fx] = mix(buf[fy * FINE + fx], c, a);
}
function setPx(buf, x, y, c) {
  const fx = Math.round(x * S), fy = Math.round(y * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) fineSet(buf, fx + i, fy + j, c);
}
function blendPx(buf, x, y, c, a) {
  const fx = Math.round(x * S), fy = Math.round(y * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) fineBlend(buf, fx + i, fy + j, c, a);
}
function dotPx(buf, x, y, c) { fineSet(buf, Math.round(x * S), Math.round(y * S), c); }
function dotBlend(buf, x, y, c, a) { fineBlend(buf, Math.round(x * S), Math.round(y * S), c, a); }
function getPx(buf, x, y) {
  const fx = Math.min(FINE - 1, Math.max(0, Math.round(x * S)));
  const fy = Math.min(FINE - 1, Math.max(0, Math.round(y * S)));
  return buf[fy * FINE + fx];
}
function rectPx(buf, x, y, w, h, c) {
  const x0 = Math.round(x * S), y0 = Math.round(y * S), x1 = Math.round((x + w) * S), y1 = Math.round((y + h) * S);
  for (let fy = y0; fy < y1; fy++) for (let fx = x0; fx < x1; fx++) fineSet(buf, fx, fy, c);
}
function discPx(buf, cx, cy, r, c) {
  const fcx = (cx + 0.5) * S, fcy = (cy + 0.5) * S, fr = (r + 0.4) * S;
  for (let fy = Math.floor(fcy - fr); fy <= Math.ceil(fcy + fr); fy++)
    for (let fx = Math.floor(fcx - fr); fx <= Math.ceil(fcx + fr); fx++) {
      const dx = fx + 0.5 - fcx, dy = fy + 0.5 - fcy;
      if (dx * dx + dy * dy <= fr * fr) fineSet(buf, fx, fy, c);
    }
}
// smooth vertical gradient (fine rows) with ordered dithering between bands
function gradient(buf, colors, y0 = 0, y1 = GRID - 1) {
  const cols = colors.map(hex);
  const f0 = y0 * S, f1 = (y1 + 1) * S - 1;
  for (let fy = f0; fy <= f1; fy++) {
    const f = ((fy - f0) / Math.max(1, f1 - f0)) * (cols.length - 1);
    const i = Math.min(cols.length - 2, Math.floor(f));
    const frac = f - i;
    for (let fx = 0; fx < FINE; fx++) {
      const b = BAYER[(fy % 2) * 2 + (fx % 2)];
      // dither only around the middle of each band so the sky stays calm
      buf[fy * FINE + fx] = frac > 0.5 + (b - 0.375) * 0.6 ? cols[i + 1] : cols[i];
    }
  }
}
// x positions that stay clear of the character in the middle
const sideX = (R, margin = 2) => (R.chance(0.5) ? margin + R.int(8 - margin) : 23 + R.int(8 - margin + 1));

/* ---------------------------------------------------------------------
   3. Themes: palette, background painter and animated layer
   Each bg(R) paints a static Int32Array and may return anim(fb, t).
   --------------------------------------------------------------------- */
// ----- extra painters used by the newer themes -----
function fineDisc(b, fcx, fcy, fr, c) {
  for (let fy = Math.floor(fcy - fr); fy <= Math.ceil(fcy + fr); fy++)
    for (let fx = Math.floor(fcx - fr); fx <= Math.ceil(fcx + fr); fx++) {
      const dx = fx + 0.5 - fcx, dy = fy + 0.5 - fcy;
      if (dx * dx + dy * dy <= fr * fr) fineSet(b, fx, fy, c);
    }
}
function fineGround(b, fromY, c1, c2, mixAt = 0.5) {
  for (let fy = Math.round(fromY * S); fy < FINE; fy++)
    for (let fx = 0; fx < FINE; fx++) fineSet(b, fx, fy, BAYER[(fy % 2) * 2 + (fx % 2)] < mixAt ? c1 : c2);
}
function mountain(b, cx, peakY, baseY, halfW, col, capCol) {
  const f0 = peakY * S, f1 = baseY * S;
  for (let fy = f0; fy <= f1; fy++) {
    const w = ((fy - f0) / (f1 - f0)) * halfW * S;
    const capLine = f0 + (f1 - f0) * 0.28;
    for (let fx = Math.round(cx * S + 1 - w); fx <= Math.round(cx * S + 1 + w); fx++) {
      const isCap = capCol && fy < capLine + ((fx * 7) % 3);
      fineSet(b, fx, fy, isCap ? capCol : (fx < cx * S + 1 - w * 0.35 ? mix(col, 0xffffff, 0.08) : col));
    }
  }
}
function pine(b, x, baseY, h, col, snowCol) {
  const cx = x * S + 1, base = baseY * S;
  rectPx(b, x, baseY - 1.5, 1, 1.5, hex("#4a2f1f"));
  const tiers = 3, th = (h * S) / tiers;
  for (let t = 0; t < tiers; t++) {
    const tierBase = base - 3 - t * th * 0.75, maxW = h * S * 0.32 * (1 - t * 0.22);
    for (let k = 0; k < th; k++) {
      const w = ((th - k) / th) * maxW, fy = Math.round(tierBase - k);
      for (let fx = Math.round(cx - w); fx <= Math.round(cx + w); fx++)
        fineSet(b, fx, fy, snowCol && k < 2 ? snowCol : (fx < cx ? mix(col, 0xffffff, 0.1) : col));
    }
  }
}
function roundTree(b, x, baseY, h, c0, c1) {
  rectPx(b, x, baseY - h + 2, 1, h - 1.5, hex("#5a3a24"));
  const top = baseY - h;
  discPx(b, x, top + 1, 3, c0); discPx(b, x - 2, top + 3, 2, c0); discPx(b, x + 2, top + 3, 2, c0);
  discPx(b, x - 1, top, 1, c1); discPx(b, x + 1, top + 2, 1, c1);
}
function palm(b, px, baseY, h, lean) {
  let tx = px; const top = baseY - h;
  for (let y = baseY; y >= top; y--) {
    if ((baseY - y) % 4 === 3) tx += lean * 0.5;
    setPx(b, tx, y, hex((y % 2) ? "#7a4a2a" : "#5c361d"));
  }
  const leaf = hex("#2f7d3a"), leaf2 = hex("#3fa04a");
  [[-1, 0], [1, 0], [-1, 1], [1, 1], [-0.6, -0.8], [0.6, -0.8]].forEach(([dx, dy], i) => {
    for (let k = 1; k <= 5; k++) setPx(b, tx + dx * k, top + dy * k + (k > 2 && dy >= 0 ? (k - 2) * 0.5 : 0), i % 2 ? leaf : leaf2);
  });
  dotPx(b, tx - 0.5, top + 1, hex("#6b3f1f")); dotPx(b, tx + 1, top + 1, hex("#6b3f1f"));
}
function leafShape(b, x, y, dir, c) {
  for (let k = 0; k <= 12; k++) {
    const u = k / 12;
    const fcx = (x + dir * u * 6) * S, fcy = (y - u * 2 + u * u * 3) * S;
    fineDisc(b, fcx, fcy, Math.sin(u * Math.PI) * 3 + 0.6, c);
  }
  for (let k = 1; k < 12; k++) {
    const u = k / 12;
    fineSet(b, Math.round((x + dir * u * 6) * S), Math.round((y - u * 2 + u * u * 3) * S), mix(c, 0x000000, 0.25));
  }
}
function block(b, x, y, c) {
  rectPx(b, x, y, 2, 2, c);
  for (let k = 0; k < 4; k++) { dotPx(b, x + k * 0.5, y, mix(c, 0xffffff, 0.45)); dotPx(b, x, y + k * 0.5, mix(c, 0xffffff, 0.3)); }
  for (let k = 1; k < 4; k++) { dotPx(b, x + k * 0.5, y + 1.5, mix(c, 0x000000, 0.3)); dotPx(b, x + 1.5, y + k * 0.5, mix(c, 0x000000, 0.3)); }
}
function heart(b, x, y, c) {
  [".X.X.", "XXXXX", ".XXX.", "..X.."].forEach((row, j) => {
    for (let i = 0; i < 5; i++) if (row[i] === "X") fineSet(b, Math.round(x * S) + i, Math.round(y * S) + j, c);
  });
}

const THEMES = [
  {
    key: "haunted", name: "Haunted", mood: "negative", particle: "bats",
    words: ["moon", "crypt", "shadow", "midnight", "phantom"],
    bodies: ["#9b6bff", "#6fe3c1", "#ff7ab6", "#c7c2d9", "#7fb0ff", "#f2a65a"],
    accents: ["#ff4f7b", "#ffd166", "#7cf7d4", "#b8ff5c"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#120824", "#1e0f38", "#2c174f", "#3d2068", "#4a2878"]);
      for (let i = 0; i < 12; i++) dotPx(b, R.int(GRID), R.int(16), hex(R.pick(["#b9a6e8", "#8f7cc4"])));
      const mx = R.pick([5, 6, 25, 26]), my = 5 + R.int(2);
      for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
        const d = Math.sqrt(x * x + y * y);
        if (d > 4.3 && d < 6.2) blendPx(b, mx + x, my + y, hex("#cbb8ff"), 0.18);
      }
      discPx(b, mx, my, 4, hex("#f6f1c7"));
      [[-2, -1.5], [-1.5, -1], [1, 1.5], [1.5, 1.5], [1, 2], [2.5, -1], [-1, 2.5]].forEach(([dx, dy]) => dotPx(b, mx + dx, my + dy, hex("#ddd5a3")));
      for (let k = 0; k < 4; k++) dotPx(b, mx - 3.5 + k * 0.5, my + 3 - k * 0.5 - 1.5, hex("#fffbe0")); // rim shine
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
      for (let i = 0; i < 14; i++) dotPx(b, R.int(GRID), R.int(20), hex("#6a6a9a"));
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
  {
    key: "snow", name: "Snowy Peaks", mood: "neutral", particle: "snow",
    words: ["frosty", "snowy", "alpine", "icicle", "yeti", "himalayan"],
    bodies: ["#ff7a7a", "#7fb0ff", "#ffd166", "#b39cff", "#7cf7d4", "#ff9ecd"],
    accents: ["#ff3d5a", "#2d62ff", "#ffffff", "#ffb627"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#8fb9e3", "#b3d1ef", "#d7e8f7"], 0, 24);
      mountain(b, 4 + R.int(8), 6 + R.int(3), 24, 12, hex("#9db4d4"), hex("#ffffff"));
      mountain(b, 20 + R.int(8), 4 + R.int(3), 24, 13, hex("#87a1c6"), hex("#f4f8ff"));
      mountain(b, 13 + R.int(6), 11 + R.int(3), 25, 10, hex("#6f8db8"), hex("#e8f0fb"));
      fineGround(b, 25, hex("#dfe9f5"), hex("#f4f8ff"), 0.25);
      for (let i = 0; i < 4; i++) pine(b, sideX(R, 1), 27 + R.int(3), 7 + R.int(4), hex("#2f6b4f"), hex("#f4f8ff"));
      return { base: b, anim: null };
    },
  },
  {
    key: "desert", name: "Desert Dunes", mood: "neutral", particle: "sand",
    words: ["dusty", "sandy", "mirage", "oasis", "nomad", "sunbaked"],
    bodies: ["#7cc4ff", "#ff7eb6", "#7cf7a8", "#c9a0ff", "#fff1c2", "#ff6b6b"],
    accents: ["#2d62ff", "#ff3d7f", "#034f46", "#ffffff"],
    bg(R) {
      const b = newBuf();
      const dusk = R.chance(0.4);
      gradient(b, dusk ? ["#5b3a8a", "#d0607a", "#ff9f5a", "#ffd08a"] : ["#6cbcef", "#9fd4f4", "#ffe6b0"], 0, 22);
      discPx(b, sideX(R, 3), dusk ? 17 : 5, 3, hex(dusk ? "#ffe1a8" : "#fff6d6"));
      for (let i = 0; i < 2; i++) {
        const mx = R.int(GRID), w = 4 + R.int(5), h = 3 + R.int(4);
        rectPx(b, mx, 22 - h, w, h + 1, hex(dusk ? "#8a4a5a" : "#c97a4a"));
        rectPx(b, mx - 1, 22 - h, w + 2, 1, hex(dusk ? "#9c5866" : "#d98c5a"));
      }
      const ph = R.next() * 6;
      for (let fx = 0; fx < FINE; fx++) {
        const x = fx / S, h1 = 22 + Math.sin(x * 0.22 + ph) * 1.5, h2 = 26 + Math.sin(x * 0.3 + ph * 2) * 1.2;
        for (let fy = Math.round(h1 * S); fy < FINE; fy++) {
          const back = fy < h2 * S, edge = back ? fy < h1 * S + 2 : fy < h2 * S + 2;
          fineSet(b, fx, fy, hex(back ? (edge ? "#f7d58a" : "#e9b864") : (edge ? "#ffe2a0" : "#f2c46d")));
        }
      }
      const cx = sideX(R, 2), cy = 27, g = hex("#3f8a4a");
      rectPx(b, cx, cy - 7, 1, 8, g); rectPx(b, cx - 2, cy - 5, 1, 3, g); rectPx(b, cx - 2, cy - 3, 2, 1, g);
      rectPx(b, cx + 2, cy - 6, 1, 3, g); rectPx(b, cx + 1, cy - 4, 2, 1, g);
      return { base: b, anim: null };
    },
  },
  {
    key: "volcano", name: "Volcano", mood: "negative", particle: "embers",
    words: ["molten", "lava", "ember", "blazing", "magma", "scorched"],
    bodies: ["#ffd166", "#7cf7d4", "#c9a0ff", "#ff9ecd", "#8fd3ff", "#f2f2f2"],
    accents: ["#ff6a00", "#ffd166", "#ffffff", "#ff3d3d"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#140707", "#2e0c0c", "#5c1a12", "#9a3218"], 0, 25);
      const vx = 16 + (R.chance(0.5) ? -7 : 7);
      for (let fy = 0; fy < 26 * S; fy++) for (let fx = 0; fx < FINE; fx++) { // eruption glow in the sky
        const d = Math.hypot(fx - vx * S, fy - 8 * S);
        if (d < 26) fineBlend(b, fx, fy, hex("#ff7a2a"), 0.45 * (1 - d / 26));
      }
      for (let fy = 8 * S; fy < 26 * S; fy++) {
        const k = (fy - 8 * S) / (18 * S), w = (2.5 + k * 13) * S;
        for (let fx = Math.round(vx * S - w); fx <= Math.round(vx * S + w); fx++) {
          const lit = fx < vx * S - w * 0.2;
          fineSet(b, fx, fy, hex(lit ? (BAYER[(fy % 2) * 2 + (fx % 2)] < 0.3 ? "#6b3324" : "#5a2a1e") : "#3d1c15"));
        }
      }
      rectPx(b, vx - 2, 8, 5, 1, hex("#ffd23a")); rectPx(b, vx - 1.5, 7.5, 4, 0.5, hex("#ff9a2e"));
      const streams = [];
      for (let i = 0; i < 3; i++) {
        let x = vx - 1 + R.int(3); const pts = [];
        for (let y = 10; y < 26; y++) { if (R.chance(0.35)) x += R.chance(0.5) ? -1 : 1; pts.push([x, y]); }
        streams.push(pts);
      }
      fineGround(b, 26, hex("#1a0c09"), hex("#241210"));
      const cracks = [];
      for (let i = 0; i < 5; i++) cracks.push([R.int(GRID), 27 + R.int(5), 2 + R.int(4)]);
      return {
        base: b,
        anim(fb, t) {
          const pulse = (Math.sin(t * 0.08) + 1) / 2;
          streams.forEach((pts) => pts.forEach(([x, y], i) => {
            const hot = mod(i - t * 0.15, 8) < 2;
            setPx(fb, x, y, hex("#e04a00"));
            dotPx(fb, x, y, mix(hex("#ff5a00"), hex("#ffd23a"), hot ? 1 : pulse * 0.5));
          }));
          cracks.forEach(([x, y, l]) => { for (let k = 0; k < l; k++) dotPx(fb, x + k * 0.5, y + (k % 2) * 0.5, mix(hex("#b33a00"), hex("#ffb02e"), pulse)); });
          for (let i = 0; i < 14; i++) {
            const yy = 8 - mod(t * 0.05 + i * 0.7, 8);
            blendPx(fb, vx - 1 + Math.sin(i * 1.7 + t * 0.02) * 2 + (8 - yy) * 0.4, yy, hex("#3a2a2a"), 0.5);
          }
        },
      };
    },
  },
  {
    key: "autumn", name: "Autumn Woods", mood: "positive", particle: "leaves",
    words: ["maple", "harvest", "amber", "acorn", "rustling", "cinnamon"],
    bodies: ["#8fd3ff", "#c9a0ff", "#ffe066", "#7cf7a8", "#ff9ecd", "#f2f2f2"],
    accents: ["#d1495b", "#034f46", "#ffffff", "#2d62ff"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#ffc58f", "#ffd9ad", "#ffeccf"], 0, 22);
      const ph = R.next() * 6;
      for (let x = 0; x < GRID; x++) { const h = 20 + Math.round(Math.sin(x * 0.3 + ph) * 1.5); for (let y = h; y < 25; y++) setPx(b, x, y, hex("#d9935a")); }
      fineGround(b, 24, hex("#b8692f"), hex("#c97b3a"));
      const leafCols = ["#e8572e", "#f2a33a", "#ffcf3a", "#c93a2a"];
      for (let i = 0; i < 5; i++) {
        const x = i < 2 ? 1 + R.int(6) : i < 4 ? 25 + R.int(6) : R.int(GRID);
        roundTree(b, x, 25 + R.int(2), 8 + R.int(5), hex(R.pick(leafCols)), hex(R.pick(leafCols)));
      }
      for (let i = 0; i < 40; i++) dotPx(b, R.next() * GRID, 25 + R.next() * 7, hex(R.pick(leafCols)));
      return { base: b, anim: null };
    },
  },
  {
    key: "sakura", name: "Sakura Garden", mood: "positive", particle: "petals",
    words: ["blossom", "sakura", "petal", "zen", "spring", "haiku"],
    bodies: ["#ffffff", "#8fd3ff", "#ffe066", "#b39cff", "#7cf7a8", "#ff7a8a"],
    accents: ["#ff3d7f", "#034f46", "#2d62ff", "#ffd166"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#dcecff", "#f6e4f2", "#ffd3e6"], 0, 23);
      mountain(b, 16 + (R.chance(0.5) ? -5 : 5), 8, 23, 12, hex("#b8c3e3"), hex("#ffffff"));
      fineGround(b, 23, hex("#8fcb8c"), hex("#9ed89b"));
      const px = sideX(R, 3);
      for (let fy = 27 * S; fy < 29.5 * S; fy++) for (let fx = (px - 3) * S; fx < (px + 4) * S; fx++) fineSet(b, fx, fy, hex("#9fd3e8"));
      const pinks = ["#ffb7d5", "#ff9cc6", "#ffd1e5"];
      for (let i = 0; i < 4; i++) {
        const x = i % 2 ? 2 + R.int(5) : 25 + R.int(5);
        roundTree(b, x, 25 + R.int(2), 9 + R.int(4), hex(R.pick(pinks)), hex(R.pick(pinks)));
      }
      return { base: b, anim: null };
    },
  },
  {
    key: "backwaters", name: "Kerala Backwaters", mood: "positive", particle: "glints",
    words: ["malabar", "monsoon", "backwater", "coconut", "kochi", "lagoon"],
    bodies: ["#ffd166", "#ff7eb6", "#ffffff", "#c9a0ff", "#ff8c5a", "#8fd3ff"],
    accents: ["#ffcc33", "#d1495b", "#034f46", "#ffffff"],
    bg(R) {
      const b = newBuf();
      const golden = R.chance(0.35);
      gradient(b, golden ? ["#ff9a5a", "#ffc27a", "#ffe3a8"] : ["#6cc3f2", "#9ad6f7", "#cdeefc"], 0, 17);
      for (let x = 0; x < GRID; x++) { setPx(b, x, 17, hex("#2f7a3a")); setPx(b, x, 18, hex("#2a6e34")); }
      for (let i = 0; i < 7; i++) {
        const x = R.int(GRID);
        rectPx(b, x, 13, 0.5, 4, hex("#3b5a2a"));
        [[-1, 0], [1, 0], [-1, 1], [1, 1]].forEach(([dx, dy]) => { for (let k = 1; k <= 3; k++) dotPx(b, x + dx * k * 0.5, 13 + dy * k * 0.5, hex("#2f7a3a")); });
      }
      gradient(b, golden ? ["#d99a6a", "#3f8fa8", "#2f7a92"] : ["#5fb8cc", "#3f9fb5", "#2f8aa0"], 19, 31);
      const hx = sideX(R, 4), hy = 22; // houseboat
      rectPx(b, hx - 4, hy + 1, 9, 1, hex("#5a3a1f")); rectPx(b, hx - 3, hy + 2, 7, 0.5, hex("#4a2f18"));
      for (let fx = (hx - 3) * S; fx < (hx + 4) * S; fx++) {
        const k = Math.abs(fx - (hx + 0.5) * S);
        for (let fy = (hy - 2) * S + Math.round(k * 0.3); fy < (hy + 1) * S; fy++) fineSet(b, fx, fy, hex(fy % 3 ? "#c9a26b" : "#b38a55"));
      }
      rectPx(b, hx - 2, hy, 1, 1, hex("#3a2614")); rectPx(b, hx + 2, hy, 1, 1, hex("#3a2614"));
      palm(b, 1 + R.int(3), 31, 10 + R.int(4), 1);
      palm(b, 28 + R.int(3), 31, 10 + R.int(4), -1);
      return { base: b, anim: null };
    },
  },
  {
    key: "aurora", name: "Aurora Night", mood: "neutral", particle: "stars",
    words: ["polar", "aurora", "nordic", "starlit", "glacier", "northern"],
    bodies: ["#ff7eb6", "#ffd166", "#7cf7d4", "#ffffff", "#ff9f43", "#b39cff"],
    accents: ["#3dffb0", "#a06bff", "#ffffff", "#ff3d7f"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#020617", "#041530", "#082447", "#0d3159"], 0, 24);
      for (let i = 0; i < 30; i++) dotPx(b, R.next() * GRID, R.next() * 20, hex(R.pick(["#ffffff", "#9fb4ff", "#cfd8ff"])));
      const ph = R.next() * 6;
      for (let fx = 0; fx < FINE; fx++) {
        const x = fx / S, h = 22 + Math.sin(x * 0.25 + ph) * 1.2 + Math.sin(x * 0.6) * 0.5;
        for (let fy = Math.round(h * S); fy < FINE; fy++)
          fineSet(b, fx, fy, hex(fy < h * S + 2 ? "#e8f0ff" : BAYER[(fy % 2) * 2 + (fx % 2)] < 0.3 ? "#b9c9ea" : "#d3dff5"));
      }
      for (let i = 0; i < 5; i++) pine(b, sideX(R, 1), 25 + R.int(3), 6 + R.int(4), hex("#0a1f2e"), null);
      const ph2 = R.next() * 6, second = R.chance(0.5) ? hex("#a06bff") : hex("#3dd6ff");
      return {
        base: b,
        anim(fb, t) {
          for (let fx = 0; fx < FINE; fx++) {
            const x = fx / S;
            const yc = (6 + Math.sin(x * 0.28 + t * 0.025 + ph2) * 2.2 + Math.sin(x * 0.09 - t * 0.01) * 1.5) * S;
            const glow = 0.6 + 0.4 * Math.sin(x * 0.5 + t * 0.05);
            for (let k = 0; k < 14; k++) fineBlend(fb, fx, Math.round(yc + k), k < 6 ? hex("#3dffb0") : second, Math.max(0, (1 - k / 14) * 0.5 * glow));
          }
        },
      };
    },
  },
  {
    key: "arcade", name: "Retro Arcade", mood: "neutral", particle: "blocks",
    words: ["arcade", "retro", "8-bit", "combo", "joystick", "high-score"],
    bodies: ["#ff3d7f", "#3dc1ff", "#ffe14d", "#7cf7a8", "#ff9f43", "#c9a0ff"],
    accents: ["#ffffff", "#ffe14d", "#ff3d7f", "#3dc1ff"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#07071a", "#0e0b2e", "#1a0f40"]);
      for (let f = 0; f < FINE; f += 8) for (let k = 0; k < FINE; k++) { fineBlend(b, k, f, hex("#3b2a8a"), 0.35); fineBlend(b, f, k, hex("#3b2a8a"), 0.35); }
      const cols = ["#ff3d7f", "#3dc1ff", "#ffe14d", "#7cf7a8", "#ff9f43", "#c58bff"];
      for (let x = 0; x < GRID; x += 2) {
        const h = x > 9 && x < 22 ? R.int(2) : 1 + R.int(5);
        for (let j = 0; j < h; j++) block(b, x, 30 - j * 2, hex(R.pick(cols)));
      }
      for (let i = 0; i < 3; i++) heart(b, 1 + i * 3, 1.5, hex("#ff3d5a"));
      for (let i = 0; i < 6; i++) rectPx(b, 19 + i * 2, 1.5, 1, 1.5, hex("#ffe14d"));
      return { base: b, anim(fb) { for (let fy = 1; fy < FINE; fy += 2) for (let fx = 0; fx < FINE; fx++) fineBlend(fb, fx, fy, 0x000000, 0.14); } };
    },
  },
  {
    key: "matrix", name: "Hacker Terminal", mood: "neutral", particle: "code",
    words: ["root", "binary", "terminal", "kernel", "sudo", "byte"],
    bodies: ["#39ff14", "#00f0ff", "#f2f2f2", "#ffd166", "#ff2bd6", "#9d4edd"],
    accents: ["#39ff14", "#00f0ff", "#ffffff", "#ff2bd6"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#010603", "#02100a", "#031a0f"]);
      for (let i = 0; i < 140; i++) dotPx(b, R.int(FINE) / S, R.int(FINE) / S, hex(R.pick(["#0a3a1c", "#0d4a22"])));
      rectPx(b, 0, 0, GRID, 1.5, hex("#0d2a18"));
      ["#ff5f56", "#ffbd2e", "#27c93f"].forEach((c, i) => fineDisc(b, (1.2 + i * 1.4) * S, 0.75 * S, 1.2, hex(c)));
      return {
        base: b,
        anim(fb, t) {
          for (let k = 0; k < 3; k++) dotPx(fb, 1 + k * 0.5, 29.5, hex("#1fdc5a"));
          if (Math.floor(t / 15) % 2) rectPx(fb, 2.5, 29, 1, 1.5, hex("#39ff14"));
        },
      };
    },
  },
  {
    key: "room", name: "Cozy Room", mood: "positive", particle: "dust",
    words: ["cozy", "homey", "snug", "lofi", "pillow", "teatime"],
    bodies: ["#8fd3ff", "#ff7eb6", "#7cf7a8", "#c9a0ff", "#ffd166", "#ff8c5a"],
    accents: ["#d1495b", "#034f46", "#2d62ff", "#ffffff"],
    bg(R) {
      const b = newBuf();
      const night = R.chance(0.5);
      const wall = R.pick([["#f3d9b1", "#ead0a6"], ["#cfe3d4", "#c3d9c8"], ["#e3d4f0", "#d8c6e8"], ["#f6c8b8", "#efbba9"]]);
      for (let fy = 0; fy < 23 * S; fy++) for (let fx = 0; fx < FINE; fx++) fineSet(b, fx, fy, hex(Math.floor(fx / 6) % 2 ? wall[0] : wall[1]));
      for (let fy = 23 * S; fy < FINE; fy++) for (let fx = 0; fx < FINE; fx++) {
        const plank = Math.floor((fy - 23 * S) / 3), seam = ((fx + plank * 11) % 17) === 0 || (fy - 23 * S) % 3 === 0;
        fineSet(b, fx, fy, hex(seam ? "#8a5530" : "#a86b3c"));
      }
      rectPx(b, 0, 23, GRID, 0.5, hex("#6e4226"));
      const wx = R.chance(0.5) ? 2 : 22, wy = 4, frame = hex("#6e4a32");
      rectPx(b, wx, wy, 8, 8, frame);
      for (let fy = (wy + 0.5) * S; fy < (wy + 7.5) * S; fy++) for (let fx = (wx + 0.5) * S; fx < (wx + 7.5) * S; fx++)
        fineSet(b, fx, fy, night ? mix(hex("#0d1838"), hex("#24356b"), (fy - wy * S) / (8 * S)) : mix(hex("#7cc6f2"), hex("#cdeefc"), (fy - wy * S) / (8 * S)));
      if (night) { fineDisc(b, (wx + 5.5) * S, (wy + 2.5) * S, 2.6, hex("#fff3c4")); for (let i = 0; i < 5; i++) dotPx(b, wx + 1 + R.next() * 6, wy + 1 + R.next() * 6, 0xffffff); }
      else { rectPx(b, wx + 1, wy + 2, 3, 1, 0xffffff); rectPx(b, wx + 1.5, wy + 1.5, 2, 0.5, 0xffffff); }
      rectPx(b, wx + 3.75, wy, 0.5, 8, frame); rectPx(b, wx, wy + 3.75, 8, 0.5, frame);
      const sx = wx < 16 ? 23 : 2;
      rectPx(b, sx, 9, 7, 0.5, frame);
      let bx = sx;
      while (bx < sx + 6.5) {
        const w = 0.5 + R.int(2) * 0.5, h = 2 + R.int(3) * 0.5;
        rectPx(b, bx, 9 - h, w, h, hex(R.pick(["#d1495b", "#2d62ff", "#034f46", "#ffb627", "#7f1c34", "#8a6bd1"])));
        bx += w;
      }
      const px = wx < 16 ? 27 : 3;
      rectPx(b, px - 1, 20, 3, 3, hex("#c96a3d")); rectPx(b, px - 1.5, 20, 4, 0.5, hex("#b05a30"));
      [[0, -1], [-1, -2], [1, -2], [0, -3], [-1.5, -1], [1.5, -1]].forEach(([dx, dy]) => setPx(b, px + dx, 20 + dy, hex(dy % 2 ? "#3fa04a" : "#2f8a3e")));
      const rug = hex(R.pick(["#d1495b", "#2d62ff", "#ffb627", "#8a6bd1"]));
      for (let fy = 26 * S; fy < 31 * S; fy++) for (let fx = 0; fx < FINE; fx++) {
        const dx = (fx - 32) / 26, dy = (fy - 28.5 * S) / 5;
        if (dx * dx + dy * dy <= 1) fineSet(b, fx, fy, Math.floor(Math.sqrt(dx * dx + dy * dy) * 4) % 2 ? rug : mix(rug, 0xffffff, 0.4));
      }
      if (night) {
        for (let i = 0; i < b.length; i++) b[i] = mix(b[i], hex("#241c3d"), 0.35);
        const lx = (sx + 3.5) * S, ly = 6 * S;
        for (let fy = 0; fy < FINE; fy++) for (let fx = 0; fx < FINE; fx++) {
          const d = Math.hypot(fx - lx, fy - ly);
          if (d < 22) fineBlend(b, fx, fy, hex("#ffcf7a"), 0.35 * (1 - d / 22));
        }
      }
      return { base: b, anim: null };
    },
  },
  {
    key: "storm", name: "Thunderstorm", mood: "negative", particle: "rain",
    words: ["stormy", "thunder", "brooding", "tempest", "raging", "electric"],
    bodies: ["#ffd166", "#8fd3ff", "#c9a0ff", "#ff9ecd", "#7cf7d4", "#f2f2f2"],
    accents: ["#ffd166", "#ffffff", "#7fd4ff", "#ff3d5a"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#101219", "#1a1e2b", "#262c3d", "#323a50"], 0, 23);
      const ph = R.next() * 6;
      for (let fx = 0; fx < FINE; fx++) {
        const x = fx / S, bot = (5 + Math.sin(x * 0.45 + ph) * 1.5 + Math.sin(x * 0.17) * 1.2) * S;
        for (let fy = 0; fy < bot; fy++) fineSet(b, fx, fy, hex(fy > bot - 2 ? "#3a4258" : "#1b202c"));
      }
      gradient(b, ["#1c2a3a", "#152230", "#0f1924"], 24, 31);
      for (let i = 0; i < 20; i++) rectPx(b, R.int(GRID), 24 + R.int(8), 1 + R.int(2), 0.5, hex("#2d4258"));
      const lx = sideX(R, 2);
      rectPx(b, lx, 16, 2, 8, hex("#e8e8e8")); rectPx(b, lx, 18, 2, 1, hex("#d1495b")); rectPx(b, lx, 21, 2, 1, hex("#d1495b"));
      rectPx(b, lx - 0.5, 15, 3, 1, hex("#2a2f3a")); rectPx(b, lx, 14, 2, 1, hex("#ffd166")); rectPx(b, lx - 2, 24, 6, 1, hex("#1a1f28"));
      const boltX = sideX(R, 4), period = 110 + R.int(80), phase = R.int(period), bolt = [];
      let x = boltX;
      for (let y = 5; y < 22; y++) { bolt.push([x, y]); if (R.chance(0.5)) x += R.chance(0.5) ? -1 : 1; }
      return {
        base: b,
        anim(fb, t) {
          const dir = Math.cos(t * 0.03);
          for (let i = 1; i < 10; i++) blendPx(fb, lx + 0.5 + dir * i, 14, hex("#fff3b0"), 0.3 * (1 - i / 10) * Math.abs(dir));
          const f = mod(t + phase, period);
          if (f < 7) {
            const a = f < 2 ? 0.45 : f < 4 ? 0.1 : 0.3;
            for (let i = 0; i < fb.length; i++) fb[i] = mix(fb[i], 0xdfe8ff, a);
            bolt.forEach(([bx, by]) => { setPx(fb, bx, by, 0xffffff); dotPx(fb, bx + 1, by, hex("#bcd2ff")); });
          }
        },
      };
    },
  },
  {
    key: "jungle", name: "Jungle", mood: "neutral", particle: "fireflies",
    words: ["wild", "tropical", "jungle", "vine", "tiger", "canopy"],
    bodies: ["#ff8c5a", "#ffd166", "#ff7eb6", "#8fd3ff", "#c9a0ff", "#ffffff"],
    accents: ["#ff3d5a", "#ffd166", "#ffffff", "#2d62ff"],
    bg(R) {
      const b = newBuf();
      gradient(b, ["#2c7a4b", "#1f6a40", "#155a36", "#0f4a2c"]);
      for (let x = 0; x < GRID; x += 1) if (mod(x * 5, 9) < 2) for (let y = 0; y < 26; y++) blendPx(b, x + y * 0.2, y, hex("#bfffc8"), 0.06);
      const greens = ["#2f9e5b", "#3fbf6a", "#1f7a45", "#58c46a"];
      for (let i = 0; i < 10; i++) {
        const left = i % 2 === 1, x = left ? R.int(7) : 25 + R.int(7), y = 4 + R.int(24);
        leafShape(b, x, y, left ? 1 : -1, hex(R.pick(greens)));
      }
      fineGround(b, 27, hex("#0d3322"), hex("#123d28"));
      for (let i = 0; i < 4; i++) {
        const x = sideX(R, 1), y = 27 + R.int(3);
        discPx(b, x, y, 1, hex(R.pick(["#ff5d8f", "#ffb627", "#ff7a3d"]))); dotPx(b, x + 0.25, y + 0.25, hex("#ffe066"));
      }
      const vines = [];
      for (let i = 0; i < 5; i++) vines.push({ x: R.int(GRID), len: 5 + R.int(10), ph: R.next() * 6 });
      return {
        base: b,
        anim(fb, t) {
          vines.forEach((v) => {
            for (let j = 0; j < v.len * S; j++) {
              const y = j / S, sway = Math.sin(t * 0.03 + v.ph + y * 0.25) * (y / v.len) * 1.2;
              dotPx(fb, v.x + sway, y, hex("#2a6e2f"));
              if (j % 5 === 0) dotPx(fb, v.x + sway + 0.5, y, hex("#4caf50"));
            }
          });
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

// casual words the AFINN list scores oddly (or not at all)
const MOOD_EXTRAS = {
  chilling: 2, chill: 2, chilled: 2, vibe: 1, vibes: 2, vibing: 2, susegad: 3, beach: 1, sunset: 1, cozy: 2,
  lit: 2, dope: 2, fire: 0, sick: 0, killing: 0, slay: 2, slaying: 2, homesick: -2, rainy: -1, monday: -1,
  grumpy: -2, moody: -1, sleepy: 0, debugging: 0, cute: 2, adorable: 3, chilling: 2,
};
const FALLBACK_LEXICON = {
  love: 3, happy: 3, joy: 3, sunny: 2, great: 3, fun: 2, awesome: 3, cute: 2, sweet: 2, yay: 3, smile: 2,
  sad: -2, cry: -2, alone: -2, miss: -2, rain: -1, dark: -1, haunted: -2, scared: -2, hate: -3, tired: -2, lonely: -2, gloomy: -2,
};
function analyzeMood(sentence) {
  const text = (sentence || "").trim();
  let score = 0, comparative = 0, positive = [], negative = [];
  if (text) {
    if (sentimentEngine) {
      const r = sentimentEngine.analyze(text, { extras: MOOD_EXTRAS });
      score = r.score; comparative = r.comparative;
      positive = r.positive || []; negative = r.negative || [];
    } else {
      const words = text.toLowerCase().match(/[a-z']+/g) || [];
      words.forEach((w) => {
        const v = FALLBACK_LEXICON[w] || 0;
        score += v;
        if (v > 0) positive.push(w); else if (v < 0) negative.push(w);
      });
      comparative = words.length ? score / words.length : 0;
    }
  }
  const label = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { score, comparative, label, positive: [...new Set(positive)], negative: [...new Set(negative)] };
}

/* ---------------------------------------------------------------------
   4b. Keywords: the actual words you use steer the avatar.
   Matches boost the odds very strongly (the seed still makes the final
   pick, so everything stays reproducible).
   --------------------------------------------------------------------- */
const KEYWORDS = {
  theme: {
    haunted: "haunted haunt spooky halloween midnight moon bat bats grave witch creepy castle scary horror ghostly night",
    happy: "sunny sun flower flowers garden meadow picnic spring bloom daisy smile morning sunshine",
    sad: "rain rainy gloomy grey gray cry crying tears lonely monday miss sad",
    scifi: "space star stars planet planets galaxy rocket cosmic astronaut orbit universe nasa",
    cyberpunk: "neon city cyber cyberpunk glitch 3am street streets synth nightlife downtown metro",
    hydro: "ocean sea deep wave waves abyss water whale shark dive diving",
    forest: "reef coral kelp fish lagoon aquarium mermaid turtle snorkel snorkeling",
    candy: "candy cake sweet sweets sugar birthday sprinkle sprinkles chocolate dessert icecream lollipop donut party",
    goa: "goa goan beach sunset baga calangute anjuna palm susegad feni vacation holiday",
    snow: "snow snowy winter ice icy frozen mountain mountains ski skiing himalaya himalayas manali shimla",
    desert: "desert dune dunes sahara camel dry rajasthan jaisalmer sand",
    volcano: "volcano volcanoes lava magma eruption angry furious rage mad burning",
    autumn: "autumn fall leaf leaves maple october harvest",
    sakura: "sakura cherry blossom blossoms japan tokyo kyoto zen",
    backwaters: "kerala backwater backwaters houseboat alleppey alappuzha kochi kumarakom river boat monsoon coconut",
    aurora: "aurora northern lights polar arctic iceland norway lapland",
    arcade: "arcade retro 8bit game games gaming gamer level boss console nintendo",
    matrix: "hacker hackers hack hacking hackathon terminal linux matrix binary sudo bug bugs debug debugging python javascript code coding programmer developer",
    room: "home room bedroom bed lofi nap netflix tea coffee indoors weekend",
    storm: "storm stormy thunder thunderstorm lightning tempest hurricane cyclone",
    jungle: "jungle rainforest tropical wild tiger monkey vines amazon forest",
  },
  type: {
    cat: "cat cats kitty kitten meow", fox: "fox foxy", owl: "owl owls wise study studying",
    frog: "frog toad pond", bunny: "bunny rabbit bun hop easter", ghost: "ghost ghosts boo spirit phantom",
    robot: "robot robots ai bot bots tech machine computer android code coding",
    slime: "slime goo blob jelly", alien: "alien aliens ufo martian", dragon: "dragon dragons fire flame dino",
    monster: "monster monsters beast rawr", vamp: "vampire vamp dracula blood fangs",
    penguin: "penguin penguins antarctica", panda: "panda pandas bamboo", bear: "bear bears teddy hug hugs",
    puppy: "dog dogs puppy puppies pup doggo woof", duck: "duck ducks quack duckling",
    mushroom: "mushroom mushrooms shroom fungi", cactus: "cactus cacti plant plants succulent",
    octopus: "octopus kraken tentacle tentacles squid", axolotl: "axolotl axolotls",
    ninja: "ninja ninjas stealth samurai", astronaut: "astronaut astronauts cosmonaut spaceman rocket",
    wizard: "wizard wizards magic spell sorcerer mage potion", skeleton: "skeleton skeletons bones skull",
    pumpkin: "pumpkin pumpkins halloween jack", elephant: "elephant elephants kerala tusker jumbo",
  },
  color: {
    red: "#ff4d4d", orange: "#ff9f43", yellow: "#ffd93d", green: "#6bdc6b", blue: "#4da3ff", purple: "#a06bff",
    violet: "#a06bff", pink: "#ff7eb6", white: "#f2f2f2", black: "#4a4a5a", brown: "#b07a4a", gold: "#ffcc33",
    golden: "#ffcc33", silver: "#c9ced6", teal: "#2ec4b6", cyan: "#3ee6ff", lavender: "#d9b8ff", mint: "#98f5c9",
  },
  accessory: {
    crown: "crown king queen royal prince princess", hat: "hat fancy gentleman magic magician classy",
    headphones: "music song songs dj headphones beats vibe vibes dance dancing",
    glasses: "glasses nerd nerdy exam exams read reading book books smart geek",
    scarf: "scarf winter cold snow cozy chilly",
    bow: "bow cute ribbon kawaii adorable", flowers: "rose roses floral bouquet garland",
    cap: "cap sports cricket football baseball skate skater gym", mustache: "mustache moustache dad uncle papa",
  },
};
const KEYWORD_INDEX = (() => { // word -> [{kind, key}]
  const idx = {};
  ["theme", "type", "accessory"].forEach((kind) => Object.entries(KEYWORDS[kind]).forEach(([key, list]) =>
    list.split(" ").forEach((w) => (idx[w] = idx[w] || []).push({ kind, key }))));
  Object.keys(KEYWORDS.color).forEach((w) => (idx[w] = idx[w] || []).push({ kind: "color", key: w }));
  return idx;
})();

function analyzeWords(sentence) {
  const hints = { theme: {}, type: {}, accessory: {}, count: { theme: {}, type: {}, accessory: {} }, color: null, colorWord: null };
  const words = (sentence || "").toLowerCase().match(/[a-z0-9']+/g) || [];
  words.forEach((raw) => {
    const w = KEYWORD_INDEX[raw] ? raw : KEYWORD_INDEX[raw.replace(/'s$|s$/, "")] ? raw.replace(/'s$|s$/, "") : null;
    if (!w) return;
    KEYWORD_INDEX[w].forEach(({ kind, key }) => {
      if (kind === "color") { if (!hints.color) { hints.color = hex(KEYWORDS.color[key]); hints.colorWord = raw; } }
      else {
        if (!hints[kind][key]) hints[kind][key] = raw;
        hints.count[kind][key] = (hints.count[kind][key] || 0) + 1;
      }
    });
  });
  return hints;
}

function pickTheme(R, mood, hints) {
  const strength = mood.label === "neutral" ? 0 : Math.min(1, 0.45 + Math.abs(mood.comparative) * 1.5);
  const weights = THEMES.map((t) => {
    let w = 1;
    if (mood.label !== "neutral") {
      if (t.mood === mood.label) w = 1 + 5 * strength;              // lean toward matching mood
      else if (t.mood !== "neutral") w = Math.max(0.25, 1 - strength); // lean away from opposite mood
    }
    return w;
  });
  // your words win: if any theme word matched, only matched themes can be picked
  // the scene(s) with the most matching words win
  const matched = THEMES.map((t) => hints.count.theme[t.key] || 0);
  const best = Math.max(...matched);
  return R.weighted(THEMES, best > 0 ? weights.map((w, i) => (matched[i] === best ? w : 0)) : weights);
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
  { key: "penguin", name: "penguin", eye: [4, 7], mouth: 11, headTop: 3, neck: 11, noMouth: true, tpl: [
    "........", "........", "........", "....BBBB", "...BBBBB", "..BBBBBB", "..BBWWWW", ".BBWWWWW",
    ".BBWWWWW", ".BBWWWOO", ".BBWWWWO", "BBBWWWWW", "BBBWWWWW", "BBBWWWWW", ".BBWWWWW", ".BBWWWWW",
    "..BBWWWW", "...OO..."] },
  { key: "panda", name: "panda", eye: [2, 7], mouth: 10, headTop: 3, neck: 12, eyes: ["wide", "glow"], shade: "W", tpl: [
    "........", "........", ".KK.....", ".KKWWWWW", "..WWWWWW", ".WWWWWWW", "WWKKWWWW", "WKKKWWWW",
    "WKKKWWWW", "WWKWWWWK", "WWWWWWWW", ".WWWWWWW", "..KKKKKK", "KKKWWWWW", "KKKWWWWW", ".KKWWWWW",
    "..WWWWWW", "..KKK..."] },
  { key: "bear", name: "bear", eye: [2, 6], mouth: 10, headTop: 4, neck: 12, tpl: [
    "........", "........", ".BB.....", ".BAB....", ".BBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB",
    "BBBBBLLL", "BBBBLLLK", "BBBBLLLL", ".BBBBLLL", "..BBBBBB", ".BBBLLLL", "BBBLLLLL", "BBBLLLLL",
    ".BBBBBBB", ".DDD...."] },
  { key: "puppy", name: "puppy", eye: [3, 7], mouth: 11, headTop: 3, neck: 12, tpl: [
    "........", "........", "........", "...BBBBB", "..BBBBBB", "DDBBBBBB", "DDBBBBBB", "DDBBBBBB",
    "DDBBBBBB", "DDBBBLLL", ".DBBLLLK", "..BBLLLL", "...BBBBB", "..BBBLLL", "..BBBLLL", "..BBBLLL",
    "..BBBBBB", "..LLL..."] },
  { key: "duck", name: "duck", eye: [3, 6], mouth: 10, headTop: 4, neck: 11, tpl: [
    "........", "........", ".......B", ".....BBB", "...BBBBB", "..BBBBBB", "..BBBBBB", "..BBBBBB",
    "..BBBBOO", "..BBBOOO", "...BBBBB", "....BBBB", "..BBBBBB", ".BBBBBBB", "BBDBBBBB", "BBDBBBBB",
    ".BBBBBBB", "...OO..."] },
  { key: "mushroom", name: "mushroom", eye: [3, 9], mouth: 12, headTop: 1, neck: 14, tpl: [
    "........", "....BBBB", "..BBBBBB", ".BBWWBBB", "BBBWWBBB", "BBBBBBWW", "BBBBBBWW", "DDDDDDDD",
    "..LLLLLL", "..LLLLLL", "..LLLLLL", "..LLLLLL", "..LLLLLL", "...LLLLL", "...LLLLL", "...LLLLL",
    "..LLLLLL", "..DDD..."] },
  { key: "cactus", name: "cactus", eye: [4, 6], mouth: 9, headTop: 3, neck: 14, tpl: [
    "........", "........", "......AA", "....BBBB", "...BBBBB", "...BBDBB", "...BBDBB", "...BBDBB",
    "B..BBBBB", "B..BBBBB", "BB.BBBBB", ".BBBBBBB", "...BBBBB", "...BBDBB", "...BBBBB", "..CCCCCC",
    "..CCCCCC", "...CCCCC"] },
  { key: "octopus", name: "octopus", eye: [3, 8], mouth: 11, headTop: 3, neck: 12, tpl: [
    "........", "........", "........", "....BBBB", "..BBBBBB", ".BBBBBBB", ".BBLBBBB", "BBBBBBBB",
    "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", "BBBBBBBB", ".BBBBBBB", "BBBBBBBB", "BB.BB.BB", "BB.BB.BB",
    ".B.BB.B.", ".D..D..."] },
  { key: "axolotl", name: "axolotl", eye: [3, 7], mouth: 10, headTop: 4, neck: 12, tpl: [
    "........", "........", "........", "A.......", "AA.BBBBB", ".AABBBBB", "AABBBBBB", ".ABBBBBB",
    "AABBBBBB", "..BBBBBB", "..BBBBBB", "...BBBBB", "...LLLLL", "..BBLLLL", ".BBBLLLL", "..BBLLLL",
    "...BBBBB", "..BB...."] },
  { key: "ninja", name: "ninja", eye: [3, 6], mouth: 10, headTop: 2, neck: 11, noMouth: true, eyes: ["round", "shine", "dot", "big"], shade: "H", tpl: [
    "........", "........", "...HHHHH", "..HHHHHH", ".HHHHHHH", ".AAAAAAA", ".HSSSSSS", ".HSSSSSS",
    ".HSSSSSS", ".HHHHHHH", ".HHHHHHH", "..HHHHHH", "...HHHHH", "..HHHHHH", ".HHHHHHH", ".HHAAAAA",
    "..HHHHHH", "..HH...."] },
  { key: "astronaut", name: "astronaut", eye: [3, 7], mouth: 9, headTop: 2, neck: 11, shade: "W", tpl: [
    "........", "........", "....WWWW", "..WWWWWW", ".WWWWWWW", ".WWSSSSS", "WWSSSSSS", "WWSSSSSS",
    "WWSSSSSS", "WWSSSSSS", ".WWSSSSS", ".WWWWWWW", "..WWWWWW", ".WWWWWWW", "WWWWBABA", ".WWWWWWW",
    "..WWWWWW", "..DDD..."] },
  { key: "wizard", name: "wizard", eye: [3, 7], mouth: 9, headTop: 5, neck: 15, noHead: true, tpl: [
    ".......B", "......BB", ".....BBB", "....BBBA", "...BBBBB", ".BBBBBBB", "..SSSSSS", "..SSSSSS",
    "..SSSSSS", "..WSSSSS", "..WWWWWW", ".BWWWWWW", ".BBWWWWW", "BBBBWWWW", "BBBBBBWW", "BBBBBBBB",
    ".BBBBBBB", ".DDD...."] },
  { key: "skeleton", name: "skeleton", eye: [3, 6], mouth: 10, headTop: 2, neck: 12, noMouth: true, eyes: ["glow"], shade: "W", tpl: [
    "........", "........", "....WWWW", "..WWWWWW", ".WWWWWWW", ".WWWWWWW", ".WKKKKWW", ".WKKKKWW",
    ".WWKKWWW", ".WWWWWKW", "..WWWWWW", "...WKWKW", "....WWWW", "...WWWWW", "..W.W.WW", "..W.W.WW",
    "...WWWWW", "...WW..."] },
  { key: "pumpkin", name: "pumpkin", eye: [3, 8], mouth: 11, headTop: 4, neck: 14, eyes: ["glow", "round", "shine"], tpl: [
    "........", "........", "......VV", "......VV", "..BBBBBB", ".BBDBBDB", "BBBDBBDB", "BBBDBBDB",
    "BBBDBBDB", "BBBDBBDB", "BBBDBBDB", "BBBDBBDB", "BBBDBBDB", "BBBDBBDB", ".BBDBBDB", "..BBBBBB",
    "...DD...", "........"] },
  { key: "elephant", name: "elephant", eye: [4, 6], mouth: 10, headTop: 3, neck: 13, noMouth: true, tpl: [
    "........", "........", "........", "...BBBGG", ".DDBBBBB", "DDDBBBBB", "DDDBBBBB", "DDDBBBBB",
    "DDDBBBBB", ".DDBBBBB", "..DBBWBB", "....BDBB", "..BBBDBB", "..BBBBBB", ".BBBBBBB", ".BBBBBBB",
    ".BBBBBBB", ".DD..DD."] },
];

// Eye styles at fine resolution (4 x 4, left eye; right eye is mirrored)
const EYE_STYLES = {
  round: [".KK.", "KWKK", "KKKK", ".KK."],
  big:   ["KKKK", "KWWK", "KWKK", "KKKK"],
  dot:   ["....", ".KK.", ".KK.", "...."],
  wide:  [".WW.", "WWKK", "WWKK", ".WW."],
  glow:  [".AA.", "AWWA", "AWAA", ".AA."],
  shine: [".KK.", "KKWK", "KKKK", "WKK."],
};
const BLINK_EYE = ["....", "....", "K..K", ".KK."];
const ACCESSORIES = ["hat", "crown", "headphones", "glasses", "scarf", "bow", "flowers", "cap", "mustache", "none"];
const HEAD_ACCESSORIES = ["hat", "crown", "headphones", "bow", "flowers", "cap"];
// extra vivid colours so characters are not limited to each scene's palette
const GLOBAL_BODIES = ["#ff6b6b", "#ff9f43", "#ffd93d", "#6bdc6b", "#2ec4b6", "#4da3ff", "#7b6bff", "#c56bff", "#ff6bd6", "#ff8fa3", "#a3e635", "#38bdf8", "#f472b6", "#fbbf24", "#e2e8f0", "#94a3b8"];

// Sprite working buffer (layout units): template (16x18) sits at (OX, OY)
// so hats and outlines have room. It is smoothed 2x into a fine sprite and
// drawn at layout (SPR_X, SPR_Y): body at columns 8..23 and rows 7..24,
// safely inside the circular crop (radius 16 around the centre).
const SW = 24, SH = 26, OX = 4, OY = 5, SPR_X = 4, SPR_Y = 2;
const FW = SW * S, FH = SH * S;
const INK = hex("#1a1423"), OUTLINE = hex("#07050b"), WHITE = hex("#f7f3ea");

function symbolColors(type, body, accent, hinted) {
  const c = {
    B: body, D: mix(body, 0x000000, 0.35), L: mix(body, 0xffffff, 0.55), A: accent,
    W: WHITE, K: INK, H: mix(body, 0x0b0612, 0.82), C: mix(hex("#6a0d2b"), accent, 0.25),
    O: hex("#ff9f2e"), S: hex("#f2c9a0"), G: hex("#ffcc33"), V: hex("#3f8a3a"),
  };
  const tint = (base, amt) => (hinted ? body : mix(body, hex(base), amt));
  if (type.key === "penguin") { c.B = mix(body, hex("#1d2333"), hinted ? 0.35 : 0.72); c.D = mix(c.B, 0x000000, 0.3); }
  if (type.key === "mushroom") { c.L = hex("#f5e6c8"); c.D = mix(hex("#f5e6c8"), 0x000000, 0.25); }
  if (type.key === "cactus") { c.B = tint("#3fa34d", 0.75); c.D = mix(c.B, 0x000000, 0.3); c.C = hex("#c96a3d"); }
  if (type.key === "pumpkin") { c.B = tint("#ff8c2e", 0.75); c.D = mix(c.B, 0x000000, 0.25); }
  if (type.key === "elephant") { c.B = tint("#9aa3b5", 0.6); c.D = mix(c.B, 0x000000, 0.22); }
  if (type.key === "astronaut") { c.D = hex("#9aa0b5"); }
  if (type.key === "ninja") { c.H = mix(body, hex("#0b0612"), 0.72); }
  if (type.key === "wizard") { c.B = mix(body, hex("#3b2a8a"), hinted ? 0.2 : 0.45); c.D = mix(c.B, 0x000000, 0.3); c.A = hex("#ffd93d"); }
  if (type.key === "ghost") { c.B = mix(body, 0xffffff, 0.68); c.D = mix(c.B, body, 0.5); c.L = 0xffffff; }
  if (type.key === "vamp") { c.B = mix(body, hex("#f4e8ee"), 0.78); c.L = WHITE; }
  return c;
}

// Scale2x (EPX): doubles pixel art while rounding stair-step corners
function scale2x(src, w, h) {
  const out = new Int32Array(w * 2 * h * 2);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : src[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const P = at(x, y), A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), D = at(x, y + 1);
    let e0 = P, e1 = P, e2 = P, e3 = P;
    if (C === A && C !== D && A !== B) e0 = A;
    if (A === B && A !== C && B !== D) e1 = B;
    if (D === C && D !== B && C !== A) e2 = C;
    if (B === D && B !== A && D !== C) e3 = D;
    const o = (y * 2) * w * 2 + x * 2;
    out[o] = e0; out[o + 1] = e1; out[o + w * 2] = e2; out[o + w * 2 + 1] = e3;
  }
  return out;
}

// equal odds normally; if any keyword matched, only matched options remain
function keywordWeights(keys, counts) {
  const any = keys.some((k) => counts[k]);
  return keys.map((k) => (any ? counts[k] || 0 : 1));
}

function buildCharacter(R, theme, hints) {
  const type = R.weighted(TYPES, keywordWeights(TYPES.map((t) => t.key), hints.count.type));
  const wildColour = R.chance(0.3);
  const pickedBody = hex(wildColour ? R.pick(GLOBAL_BODIES) : R.pick(theme.bodies));
  const body = hints.color ?? pickedBody;                         // "red" paints it red
  const accentChoices = theme.accents.filter((a) => hex(a) !== body);
  const accent = hex(R.pick(accentChoices));
  const eyeStyle = R.pick(type.eyes || Object.keys(EYE_STYLES));
  const accessory = R.weighted(ACCESSORIES, keywordWeights(ACCESSORIES, hints.count.accessory));
  const colors = symbolColors(type, body, accent, !!hints.color);

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

  const [, ey] = type.eye, hT = type.headTop;
  const skipHead = type.noHead && HEAD_ACCESSORIES.includes(accessory);
  if (skipHead) {
    // wizards already wear a hat
  } else if (accessory === "bow") {
    const bow = mix(accent, hex("#ff5c8a"), 0.6);
    put(3, hT - 1, bow); put(5, hT - 1, bow); put(3, hT, bow); put(4, hT, mix(bow, 0x000000, 0.3)); put(5, hT, bow);
  } else if (accessory === "flowers") {
    [[3, "#ffffff"], [5, "#ffd93d"], [7, "#ff7eb6"]].forEach(([x, c]) => put(x, hT - 1, hex(c)));
    [4, 6].forEach((x) => put(x, hT - 1, hex("#3fa04a")));
  } else if (accessory === "cap") {
    const capC = accent, brim = mix(accent, 0x000000, 0.3);
    for (let x = 5; x <= 7; x++) put(x, hT - 2, capC);
    for (let x = 4; x <= 7; x++) put(x, hT - 1, capC);
    for (let x = 3; x <= 7; x++) put(x, hT, brim);
    put(7, hT - 3, brim);
  } else if (accessory === "hat") {
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

  // smooth to fine resolution, then add soft volume to the body colour
  const fine = scale2x(base, SW, SH);
  const shaded = Int32Array.from(fine);
  const fat = (x, y) => (x < 0 || y < 0 || x >= FW || y >= FH ? -1 : fine[y * FW + x]);
  const shadeC = colors[type.shade || "B"];
  const hi = mix(shadeC, 0xffffff, 0.32), lo = mix(shadeC, 0x000000, 0.2);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    if (fine[y * FW + x] !== shadeC) continue;
    if (fat(x, y - 1) === -1) shaded[y * FW + x] = hi;                       // rim light on top edges
    else if (fat(x, y + 1) === -1 || fat(x, y + 2) === -1) shaded[y * FW + x] = lo; // shade underneath
  }

  // thin dark outline around the whole silhouette (8-neighbour, 1 fine px)
  const outline = new Uint8Array(FW * FH);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    if (fine[y * FW + x] !== -1) continue;
    for (let dy = -1; dy <= 1 && !outline[y * FW + x]; dy++)
      for (let dx = -1; dx <= 1; dx++) if (fat(x + dx, y + dy) !== -1) { outline[y * FW + x] = 1; break; }
  }
  return { type, body, accent, eyeStyle, accessory, colors, fine: shaded, outline };
}

// Draw the character for frame t into the 64x64 frame buffer
function drawCharacter(fb, scene, t, still) {
  const ch = scene.character, { type, colors } = ch;
  const bob = still ? 0 : Math.round(Math.sin(t * 0.06) * 1.5);
  const blink = !still && mod(t + scene.blinkPhase, scene.blinkPeriod) < 6;

  const sprite = Int32Array.from(ch.fine);
  const OXF = OX * S, OYF = OY * S;
  const put = (x, y, c) => { // fine template coords (0..31), mirrored
    const by = OYF + y;
    [OXF + x, OXF + (31 - x)].forEach((bx) => {
      if (bx >= 0 && by >= 0 && bx < FW && by < FH) sprite[by * FW + bx] = c;
    });
  };
  const at = (x, y) => sprite[(OYF + y) * FW + OXF + x];
  const ex = type.eye[0] * S, ey = type.eye[1] * S, my = type.mouth * S, mood = scene.mood.label;

  // eyes (4 x 4)
  const pattern = blink ? BLINK_EYE : EYE_STYLES[ch.eyeStyle];
  pattern.forEach((row, dy) => {
    for (let dx = 0; dx < 4; dx++) {
      const s = row[dx];
      if (s !== ".") put(ex + dx, ey + dy, colors[s] ?? INK);
    }
  });

  // cheeks + mouth follow the mood (masks, beaks and trunks hide the mouth)
  const showMouth = !type.noMouth;
  if (!showMouth) {
    if (mood === "positive") {
      const blush = mix(ch.body, hex("#ff5c8a"), 0.55);
      for (let dx = -1; dx <= 1; dx++) if (at(ex + dx, ey + 5) !== -1) put(ex + dx, ey + 5, blush);
    } else if (mood === "negative") {
      const drop = still ? 0 : Math.floor(t / 5) % 5, tear = hex("#7fd4ff");
      put(ex + 1, ey + 4 + drop, tear); put(ex + 1, ey + 5 + drop, mix(tear, 0xffffff, 0.45));
    }
  } else if (mood === "positive") {
    const blush = mix(ch.body, hex("#ff5c8a"), 0.55);
    for (let dx = -1; dx <= 1; dx++) if (at(ex + dx, ey + 5) !== -1) put(ex + dx, ey + 5, blush);
    put(12, my, INK); put(13, my + 1, INK); put(14, my + 2, INK); put(15, my + 2, INK);
    put(14, my + 1, hex("#ff6b8b")); put(15, my + 1, hex("#ff6b8b")); // little tongue
  } else if (mood === "negative") {
    put(14, my + 1, INK); put(15, my + 1, INK); put(13, my + 2, INK); put(12, my + 3, INK);
    const drop = still ? 0 : Math.floor(t / 5) % 5;
    const tear = hex("#7fd4ff");
    put(ex + 1, ey + 4 + drop, tear); put(ex + 1, ey + 5 + drop, mix(tear, 0xffffff, 0.45));
  } else {
    put(13, my + 1, INK); put(14, my + 1, INK); put(15, my + 1, INK);
  }
  if (showMouth && type.fangs && mood !== "negative") { put(13, my + 2, WHITE); put(13, my + 3, WHITE); }
  if (showMouth && ch.accessory === "mustache") {
    const m = hex("#3a2614");
    for (let x = 11; x <= 15; x++) put(x, my - 1, m);
    put(13, my - 2, m); put(14, my - 2, m); put(15, my - 2, m); put(10, my - 2, m);
  }

  // glasses sit on top of the eyes
  if (ch.accessory === "glasses") {
    const frame = lum(ch.body) > 0.55 ? hex("#221a2e") : hex("#f2f2f2");
    for (let x = ex - 1; x <= ex + 4; x++) { put(x, ey - 1, frame); put(x, ey + 4, frame); }
    for (let y = ey; y <= ey + 3; y++) { put(ex - 1, y, frame); put(ex + 4, y, frame); }
    for (let x = ex + 5; x <= 15; x++) put(x, ey + 1, frame);
    put(ex, ey - 1, mix(frame, 0xffffff, 0.5));
  }

  const ox = SPR_X * S, oy = SPR_Y * S + bob;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const c = sprite[y * FW + x];
    if (c !== -1) fineSet(fb, ox + x, oy + y, c);
    else if (ch.outline[y * FW + x]) fineSet(fb, ox + x, oy + y, OUTLINE);
  }
}

/* ---------------------------------------------------------------------
   6. Particles (positions are pure functions of seeded params + t)
   --------------------------------------------------------------------- */
function initParticles(kind, R) {
  const P = [];
  const n = { rain: 38, bats: 4, stars: 18, bubbles: 14, petals: 16, neonrain: 26, sprinkles: 22, gulls: 4, snow: 42, sand: 30, embers: 26, leaves: 14, glints: 18, blocks: 6, code: 34, dust: 18, fireflies: 12 }[kind] || 0;
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
        dotPx(fb, x, y, hex("#b9d6f2"));
        dotBlend(fb, x - 0.125, y - 0.5, hex("#a9c8ea"), 0.65);
        dotBlend(fb, x - 0.25, y - 1, hex("#a9c8ea"), 0.35);
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
      case "snow": {
        const y = mod(p.y + t * (0.04 + p.sp * 0.08), 38) - 3;
        const x = mod(p.x + Math.sin(t * 0.02 + p.ph) * 1.5, GRID);
        if (p.size === 2) setPx(fb, x, y, 0xffffff); else dotBlend(fb, x, y, 0xffffff, 0.9);
        break;
      }
      case "sand": {
        const x = mod(p.x + t * (0.15 + p.sp * 0.25), GRID + 4) - 2;
        const y = 17 + (p.y % 14) + Math.sin(t * 0.05 + p.ph) * 0.5;
        dotBlend(fb, x, y, hex("#fff1c8"), 0.75); dotBlend(fb, x - 0.5, y, hex("#fff1c8"), 0.35);
        break;
      }
      case "embers": {
        const y = 31 - mod(p.y * 0.8 + t * (0.06 + p.sp * 0.12), 34);
        const x = p.x + Math.sin(t * 0.04 + p.ph) * 1.2;
        dotPx(fb, x, y, mix(hex("#ff4a00"), hex("#ffd23a"), (Math.sin(t * 0.3 + p.ph) + 1) / 2));
        break;
      }
      case "leaves": {
        const sp = 0.08 + p.sp * 0.1;
        const y = mod(p.y + t * sp, 38) - 3;
        const x = mod(p.x - t * sp * 0.5 + Math.sin(t * 0.035 + p.ph) * 2.5, GRID);
        const c = hex(["#e8572e", "#f2a33a", "#ffcf3a", "#c93a2a"][p.c]);
        dotPx(fb, x, y, c); dotPx(fb, x + 0.5, y + 0.5, c);
        if (Math.floor(t / 12 + p.ph) % 2) dotPx(fb, x + 0.5, y, mix(c, 0x000000, 0.2)); else dotPx(fb, x, y + 0.5, mix(c, 0x000000, 0.2));
        break;
      }
      case "glints": {
        const x = p.x, y = 20 + (p.y % 11);
        const v = Math.sin(t * (0.05 + p.sp * 0.05) + p.ph);
        if (v > 0.55) dotBlend(fb, x, y, 0xffffff, (v - 0.55) * 2);
        if (v > 0.9) { dotBlend(fb, x - 0.5, y, 0xffffff, 0.5); dotBlend(fb, x + 0.5, y, 0xffffff, 0.5); }
        break;
      }
      case "blocks": {
        const y = mod(p.y + t * (0.04 + p.sp * 0.05), 40) - 4;
        block(fb, Math.floor(p.x / 2) * 2, Math.floor(y * 2) / 2, hex(["#ff3d7f", "#3dc1ff", "#ffe14d", "#7cf7a8"][p.c]));
        break;
      }
      case "code": {
        const x = Math.floor(p.x * 2) / 2, y = mod(p.y + t * (0.15 + p.sp * 0.3), 44) - 4, len = 5 + p.c * 2;
        dotPx(fb, x, y, hex("#d4ffcc"));
        for (let k = 1; k < len; k++) if (mod(k + Math.floor(t / 4 + p.ph * 3), 5) !== 0) dotBlend(fb, x, y - k * 0.5, hex("#1fdc5a"), 0.9 * (1 - k / len));
        break;
      }
      case "dust": {
        const x = mod(p.x + Math.sin(t * 0.01 + p.ph) * 2 + t * 0.005, GRID);
        const y = mod(p.y * 0.6 + Math.cos(t * 0.012 + p.ph) * 2, 24);
        dotBlend(fb, x, y, hex("#fff6d8"), 0.3 + 0.3 * Math.sin(t * 0.05 + p.ph));
        break;
      }
      case "fireflies": {
        const x = p.x + Math.sin(t * 0.02 + p.ph) * 2, y = 8 + (p.y % 20) + Math.cos(t * 0.017 + p.ph * 1.3) * 1.5;
        const v = (Math.sin(t * 0.08 + p.ph) + 1) / 2;
        dotPx(fb, x, y, mix(hex("#3a5a20"), hex("#e8ff6a"), v));
        if (v > 0.7) [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].forEach(([dx, dy]) => dotBlend(fb, x + dx, y + dy, hex("#e8ff6a"), 0.35));
        break;
      }
      case "stars": {
        const x = p.x, y = (p.y / 40) * 21;
        const v = (Math.sin(t * (0.03 + p.sp * 0.06) + p.ph) + 1) / 2;
        dotPx(fb, x, y, mix(hex("#2c2c55"), 0xffffff, v));
        if (v > 0.8) [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].forEach(([dx, dy]) => dotBlend(fb, x + dx, y + dy, hex("#b8c6ff"), (v - 0.8) * 4));
        if (v > 0.95) [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => dotBlend(fb, x + dx, y + dy, hex("#9fb4ff"), 0.35));
        break;
      }
      case "bubbles": {
        const y = mod(p.y - t * (0.12 + p.sp * 0.2), 40) - 4;
        const x = p.x + Math.sin(t * 0.05 + p.ph) * 0.75;
        if (p.size === 1) dotBlend(fb, x, y, hex("#dfffff"), 0.8);
        else { // little ring with a shine
          [[0.5, 0], [0, 0.5], [1, 0.5], [0.5, 1]].forEach(([dx, dy]) => dotBlend(fb, x + dx, y + dy, hex("#a8f0fa"), 0.75));
          dotPx(fb, x + 0.5, y + 0.5, mix(getPx(fb, x + 0.5, y + 0.5), 0xffffff, 0.15));
          dotPx(fb, x + 0.5, y, 0xffffff);
        }
        break;
      }
      case "petals": {
        const sp = 0.1 + p.sp * 0.12;
        const y = mod(p.y + t * sp, 38) - 3;
        const x = mod(p.x + t * sp * 0.6 + Math.sin(t * 0.04 + p.ph) * 2, GRID);
        const c = hex(["#ff9ecd", "#ffffff", "#ffd1e8", "#ffb3c7"][p.c]);
        dotPx(fb, x, y, c); dotPx(fb, x + 0.5, y, c);
        if (Math.floor(t / 15 + p.ph) % 2) dotPx(fb, x + 0.5, y + 0.5, mix(c, 0xff5c8a, 0.3));
        else dotPx(fb, x, y + 0.5, mix(c, 0xff5c8a, 0.3));
        break;
      }
      case "neonrain": {
        const y = mod(p.y + t * (0.8 + p.sp * 0.6), 40) - 4;
        const c = hex(["#ff2bd6", "#00f0ff", "#ff2bd6", "#f9f871"][p.c]);
        dotPx(fb, p.x, y, 0xffffff);
        [0.5, 1, 1.5, 2].forEach((k, i) => dotBlend(fb, p.x, y - k, c, 0.85 - i * 0.2));
        break;
      }
      case "sprinkles": {
        const y = mod(p.y + t * (0.12 + p.sp * 0.13), 38) - 3;
        const x = p.x + Math.round(Math.sin(t * 0.03 + p.ph));
        const c = hex(["#ff3d7f", "#3dc1ff", "#ffe14d", "#7cf7a8"][p.c]);
        const horiz = Math.floor(t * 0.05 + p.ph) % 2;
        for (let k = 0; k < 3; k++) dotPx(fb, x + (horiz ? k * 0.5 : 0), y + (horiz ? 0 : k * 0.5), c);
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
  const pool = R.chance(0.9) ? ADJECTIVES[mood.label] : ADJECTIVES[R.pick(["positive", "negative", "neutral"])];
  return `${R.pick(pool)} ${R.pick(theme.words)} ${type.name}`;
}

/* ---------------------------------------------------------------------
   8. Scene = everything derived from (seed, sentence)
   The order of R calls below is part of the "format": never reorder.
   --------------------------------------------------------------------- */
function buildScene(seed, sentence) {
  const R = makeRng(seed);
  const mood = analyzeMood(sentence);
  const hints = analyzeWords(sentence);
  const theme = pickTheme(R, mood, hints);
  const bg = theme.bg(R);
  const character = buildCharacter(R, theme, hints);
  const particles = initParticles(theme.particle, R);
  const name = makeName(R, theme, character.type, mood);
  const blinkPeriod = 160 + R.int(140);
  const blinkPhase = R.int(blinkPeriod);
  return { seed, sentence, mood, hints, theme, bg, character, particles, name, blinkPeriod, blinkPhase, startFrame: 0 };
}

const fb = newBuf();
const art = document.createElement("canvas");
art.width = art.height = FINE;
const artCtx = art.getContext("2d");
const artImg = artCtx.createImageData(FINE, FINE);

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

// tiny pixel-font stamp: "PIXEL SOUL · NAME · #SEED"
function drawStamp(ctx, size, scene) {
  const label = `PIXEL SOUL · ${scene.name.toUpperCase()} · ${seedToHex(scene.seed)}`;
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

/* Show exactly how the sentence shaped this avatar */
function renderWordsUsed(sc) {
  const box = $("wordsUsed");
  if (!box) return;
  const h = sc.hints, ch = sc.character, items = [];
  const q = (w) => `\u201c${w}\u201d`;
  if (h.theme[sc.theme.key]) items.push([q(h.theme[sc.theme.key]), `${sc.theme.name} scene`]);
  if (h.type[ch.type.key]) items.push([q(h.type[ch.type.key]), `${ch.type.name}`]);
  if (h.colorWord) items.push([q(h.colorWord), `${h.colorWord} body`]);
  if (h.accessory[ch.accessory]) items.push([q(h.accessory[ch.accessory]), ch.accessory]);
  const face = { positive: "smiling face", negative: "sad face + tears", neutral: "calm face" }[sc.mood.label];
  const moodWords = sc.mood.label === "positive" ? sc.mood.positive : sc.mood.label === "negative" ? sc.mood.negative : [];
  if (moodWords.length) items.push([moodWords.slice(0, 3).map(q).join(" "), `${sc.mood.label} mood, ${face}`]);
  else items.push(["no mood words", face]);
  items.push(["your exact words + the moment", `seed ${seedToHex(sc.seed)}`]);
  box.innerHTML = "";
  const title = document.createElement("span");
  title.className = "words-title";
  title.textContent = "How your words shaped it";
  box.appendChild(title);
  items.forEach(([from, to]) => {
    const chip = document.createElement("span");
    chip.className = "word-chip";
    const a = document.createElement("b"); a.textContent = from;
    chip.append(a, document.createTextNode(" \u2192 " + to));
    box.appendChild(chip);
  });
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
  renderWordsUsed(scene);
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
const fileName = () => `pixel-soul-${scene.name.replace(/\s+/g, "-")}-${seedToHex(scene.seed).slice(1)}.png`;
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
    await navigator.share({ files: [file], title: "My Pixel Soul", text: `Meet ${scene.name} ${seedToHex(scene.seed)}` });
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

/* Voice input: speak your sentence (Web Speech API: Chrome, Edge, Safari)
   Shows clear status and fixes for every failure case instead of failing
   silently. Wispr Flow dictation into the text box is always the fallback. */
(function setupVoice() {
  const btn = $("micBtn"), status = $("voiceStatus");
  if (!btn) return;
  btn.classList.remove("hidden"); // always visible so it can explain itself
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TIP = " You can also click the text box and dictate with Wispr Flow.";
  let hideTimer = null;
  const say = (msg, kind = "", ms = 0) => {
    if (!status) { toast(msg); return; }
    clearTimeout(hideTimer);
    status.textContent = msg;
    status.className = "voice-status" + (kind ? " " + kind : "");
    status.hidden = !msg;
    if (ms) hideTimer = setTimeout(() => { status.hidden = true; }, ms);
  };

  if (!SR) {
    btn.addEventListener("click", () =>
      say("This browser has no built-in speech-to-text (Firefox doesn't support it). Open Pixel Soul in Chrome, Edge or Safari." + TIP, "warn"));
    return;
  }

  const ERRORS = {
    "not-allowed": "Microphone is blocked for this page. Click the icon left of the address bar, set Microphone to Allow, then reload and try again.",
    "service-not-allowed": "The browser refused speech recognition here. Open the live https link (GitHub Pages) in Chrome or Edge, not the file directly from your computer.",
    "audio-capture": "No microphone was found. Check that one is plugged in, and in Windows go to Settings > Privacy & security > Microphone and allow your browser.",
    "network": "Couldn't reach the speech service. Chrome and Edge need internet for this, and Brave blocks it. Try Chrome or Edge on a normal connection.",
    "no-speech": "I didn't hear anything. Tap the mic and start speaking right away, a little closer to the microphone.",
    "language-not-supported": "Your browser's language isn't supported for speech. Switching to English, tap the mic again.",
  };
  const lang = /^en/i.test(navigator.language || "") ? navigator.language : "en-US";
  let rec = null, listening = false, langOverride = null;

  const setListening = (on) => {
    listening = on;
    btn.classList.toggle("listening", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Stop listening" : "Speak your sentence";
  };

  btn.addEventListener("click", () => {
    if (listening && rec) { rec.stop(); return; }
    if (navigator.brave) say("Heads up: Brave usually blocks browser speech recognition. Chrome or Edge work best." + TIP, "warn", 6000);

    rec = new SR();
    rec.lang = langOverride || lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let finalText = "", interimText = "", errored = false, heardAudio = false;
    const before = ui.sentence.value;
    let silenceTimer = null, hardStop = null;

    rec.onstart = () => {
      setListening(true);
      say("Listening… say your sentence, then pause.", "live");
      silenceTimer = setTimeout(() => {
        if (!heardAudio) say("Still waiting for sound from your mic. Check that the right microphone is selected and not muted.", "warn");
      }, 3500);
      hardStop = setTimeout(() => { try { rec.stop(); } catch (e) { /* already stopped */ } }, 15000);
    };
    rec.onaudiostart = () => { heardAudio = true; };
    rec.onspeechstart = () => { heardAudio = true; say("Hearing you…", "live"); };
    rec.onresult = (e) => {
      heardAudio = true;
      interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const txt = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += txt; else interimText += txt;
      }
      const live = (finalText + interimText).trim();
      if (live) { ui.sentence.value = live; say("Hearing: “" + live + "”", "live"); }
    };
    rec.onerror = (e) => {
      if (e.error === "aborted") return;
      errored = true;
      if (e.error === "language-not-supported") langOverride = "en-US";
      say((ERRORS[e.error] || "Voice input stopped (" + e.error + ").") + TIP, "warn");
    };
    rec.onend = () => {
      clearTimeout(silenceTimer); clearTimeout(hardStop);
      setListening(false);
      const text = (finalText || interimText).trim(); // keep words even if never "final"
      if (text) {
        ui.sentence.value = text;
        say("Heard: “" + text + "”", "ok", 4000);
        generate();
      } else {
        ui.sentence.value = before;
        if (!errored) say(ERRORS["no-speech"] + TIP, "warn");
      }
    };

    try { rec.start(); }
    catch (err) { setListening(false); say("Couldn't start the microphone. Reload the page and try again." + TIP, "warn"); }
  });
})();

// expose for console / later features (shared rings)
window.PixelSoul = window.Pixelso = { drawFromSeed, makeSeed, seedToHex, hexToSeed, buildScene, analyzeWords };
