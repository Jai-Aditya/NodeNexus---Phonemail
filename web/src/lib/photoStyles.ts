// Profile-photo styles, applied on the device before upload (only the chosen picture leaves the browser).
// Same spec on Android and iOS: all styles work on the 512×512 square crop and produce 512×512.
export const STYLES = ['original', 'oil', 'pixel', 'outline', 'pencil'] as const;
export type Style = (typeof STYLES)[number];
export const STYLE_NAMES: Record<Style, string> = {
  original: 'Original', oil: 'Oil painting', pixel: 'Pixel', outline: 'Outline', pencil: 'Pencil sketch',
};

const S = 512;
const tick = () => new Promise((r) => setTimeout(r, 0)); // let the page paint between heavy steps

function canvas(size = S) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Centre-crop an image file to a 512×512 canvas (white under any transparency).
export async function squareCrop(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file is not an image'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = canvas();
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const gray = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function pixel(src: HTMLCanvasElement): HTMLCanvasElement {
  const d = src.getContext('2d')!.getImageData(0, 0, S, S).data;
  const out = canvas();
  const ctx = out.getContext('2d')!;
  const N = 20;
  for (let by = 0; by < N; by++) {
    for (let bx = 0; bx < N; bx++) {
      const x0 = Math.floor((bx * S) / N), x1 = Math.floor(((bx + 1) * S) / N);
      const y0 = Math.floor((by * S) / N), y1 = Math.floor(((by + 1) * S) / N);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * S + x) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      ctx.fillStyle = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0); // nearest-neighbour blocks
    }
  }
  return out;
}

function oil(src: HTMLCanvasElement): HTMLCanvasElement {
  const H = 256, R = 4, L = 20;
  const small = canvas(H);
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(src, 0, 0, H, H);
  const img = sctx.getImageData(0, 0, H, H);
  const d = img.data;
  const lvl = new Uint8Array(H * H);
  for (let p = 0; p < H * H; p++) lvl[p] = Math.min(L - 1, Math.floor((gray(d, p * 4) * L) / 256));
  const out = new Uint8ClampedArray(d.length);
  const cnt = new Int32Array(L), sr = new Int32Array(L), sg = new Int32Array(L), sb = new Int32Array(L);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < H; x++) {
      cnt.fill(0); sr.fill(0); sg.fill(0); sb.fill(0);
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= H) continue;
          const p = yy * H + xx, k = lvl[p], i = p * 4;
          cnt[k]++; sr[k] += d[i]; sg[k] += d[i + 1]; sb[k] += d[i + 2];
        }
      }
      let best = 0;
      for (let k = 1; k < L; k++) if (cnt[k] > cnt[best]) best = k;
      const o = (y * H + x) * 4;
      out[o] = sr[best] / cnt[best]; out[o + 1] = sg[best] / cnt[best]; out[o + 2] = sb[best] / cnt[best]; out[o + 3] = 255;
    }
  }
  sctx.putImageData(new ImageData(out, H, H), 0, 0);
  const big = canvas();
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, S, S);
  return big;
}

function grayArray(src: HTMLCanvasElement) {
  const d = src.getContext('2d')!.getImageData(0, 0, S, S).data;
  const g = new Float32Array(S * S);
  for (let p = 0; p < S * S; p++) g[p] = gray(d, p * 4);
  return g;
}

function toCanvas(values: Float32Array | Uint8ClampedArray): HTMLCanvasElement {
  const out = canvas();
  const img = new ImageData(S, S);
  for (let p = 0; p < S * S; p++) {
    const v = values[p];
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v;
    img.data[p * 4 + 3] = 255;
  }
  out.getContext('2d')!.putImageData(img, 0, 0);
  return out;
}

// Separable Gaussian blur, clamped at the edges.
function blur(a: Float32Array, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(S * S), out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    for (let i = -r; i <= r; i++) v += a[y * S + Math.min(S - 1, Math.max(0, x + i))] * k[i + r];
    tmp[y * S + x] = v;
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    for (let i = -r; i <= r; i++) v += tmp[Math.min(S - 1, Math.max(0, y + i)) * S + x] * k[i + r];
    out[y * S + x] = v;
  }
  return out;
}

function pencil(src: HTMLCanvasElement): HTMLCanvasElement {
  const g = grayArray(src);
  const inv = new Float32Array(S * S);
  for (let p = 0; p < S * S; p++) inv[p] = 255 - g[p];
  const b = blur(inv, 8);
  const out = new Float32Array(S * S);
  for (let p = 0; p < S * S; p++) {
    const dodge = b[p] >= 255 ? 255 : Math.min(255, (g[p] * 255) / (255 - b[p]));
    out[p] = Math.max(0, Math.min(255, (dodge - 128) * 1.15 + 128)); // slight contrast boost
  }
  return toCanvas(out);
}

function outline(src: HTMLCanvasElement): HTMLCanvasElement {
  const g = blur(grayArray(src), 1); // a touch of smoothing so noise does not become lines
  const mag = new Float32Array(S * S);
  let max = 1;
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    const p = y * S + x;
    const gx = -g[p - S - 1] - 2 * g[p - 1] - g[p + S - 1] + g[p - S + 1] + 2 * g[p + 1] + g[p + S + 1];
    const gy = -g[p - S - 1] - 2 * g[p - S] - g[p - S + 1] + g[p + S - 1] + 2 * g[p + S] + g[p + S + 1];
    const m = Math.hypot(gx, gy);
    mag[p] = m;
    if (m > max) max = m;
  }
  const strength = new Float32Array(S * S); // 0 (paper) .. 1 (full line)
  for (let p = 0; p < S * S; p++) strength[p] = Math.min(1, Math.max(0, (mag[p] / max - 0.12) / 0.2));
  const dil = new Float32Array(S * S); // dilate once: lines about 2 px wide
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let m = strength[y * S + x];
    if (x + 1 < S) m = Math.max(m, strength[y * S + x + 1]);
    if (y + 1 < S) m = Math.max(m, strength[(y + 1) * S + x]);
    dil[y * S + x] = m;
  }
  const out = new Float32Array(S * S);
  for (let p = 0; p < S * S; p++) out[p] = 0xfa + (0x1b - 0xfa) * dil[p];
  return toCanvas(out);
}

// Every style of the crop, computed one after another so the page stays responsive.
export async function renderStyles(crop: HTMLCanvasElement): Promise<Record<Style, HTMLCanvasElement>> {
  const res = { original: crop } as Record<Style, HTMLCanvasElement>;
  await tick(); res.pixel = pixel(crop);
  await tick(); res.outline = outline(crop);
  await tick(); res.pencil = pencil(crop);
  await tick(); res.oil = oil(crop);
  return res;
}

export const toJpeg = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the photo'))), 'image/jpeg', 0.85));
