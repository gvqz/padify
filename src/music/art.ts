/**
 * Procedural album art for the Padify music player.
 *
 * `drawTrackArt` renders a 512×512 ambient "cover" — soft radial-gradient
 * blobs in the track's palette over a dark warm base, a slight rotated
 * composition, fine grain, and a vignette. Deterministic per track seed and
 * cached per canvas so repeated calls are cheap.
 */

import type { Track } from './tracks';
import { mulberry32 } from './rng';

const ART_SIZE = 512;
const GRAIN_SIZE = 180;

const lastSeedByCanvas = new WeakMap<HTMLCanvasElement, number>();
let grainCanvas: HTMLCanvasElement | null = null;

interface Rgb {
    r: number;
    g: number;
    b: number;
}

function hexToRgb(hex: string): Rgb {
    const value = hex.replace('#', '');
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16)
    };
}

function rgba(color: Rgb, alpha: number): string {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(3)})`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
    return {
        r: Math.round(a.r + (b.r - a.r) * t),
        g: Math.round(a.g + (b.g - a.g) * t),
        b: Math.round(a.b + (b.b - a.b) * t)
    };
}

function getGrain(rand: () => number): HTMLCanvasElement {
    if (grainCanvas) return grainCanvas;
    const canvas = document.createElement('canvas');
    canvas.width = GRAIN_SIZE;
    canvas.height = GRAIN_SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        const image = ctx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
        const data = image.data;
        for (let i = 0; i < data.length; i += 4) {
            const v = Math.floor(rand() * 255);
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
    }
    grainCanvas = canvas;
    return canvas;
}

/**
 * Draws the track's album art onto `canvas` (internal resolution forced to
 * 512×512; CSS controls the displayed size). Repeated calls with the same
 * canvas + track are cached no-ops.
 */
export function drawTrackArt(canvas: HTMLCanvasElement, track: Track): void {
    if (lastSeedByCanvas.get(canvas) === track.seed) return;
    lastSeedByCanvas.set(canvas, track.seed);

    if (canvas.width !== ART_SIZE || canvas.height !== ART_SIZE) {
        canvas.width = ART_SIZE;
        canvas.height = ART_SIZE;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rand = mulberry32(track.seed ^ 0x51ed270b);
    const palette = track.artPalette.map(hexToRgb);
    const warmDark = mix(palette[0], { r: 18, g: 15, b: 12 }, 0.78);

    ctx.save();
    ctx.clearRect(0, 0, ART_SIZE, ART_SIZE);

    // Base: deep warm vertical wash derived from the darkest palette color.
    const base = ctx.createLinearGradient(0, 0, 0, ART_SIZE);
    base.addColorStop(0, rgba(mix(warmDark, { r: 40, g: 33, b: 26 }, 0.35), 1));
    base.addColorStop(0.55, rgba(warmDark, 1));
    base.addColorStop(1, rgba(mix(warmDark, { r: 8, g: 7, b: 6 }, 0.5), 1));
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, ART_SIZE, ART_SIZE);

    // Soft luminous blobs, composed with a slight rotation and offset.
    const blobCount = 4 + Math.floor(rand() * 4); // 4-7
    const rotation = (rand() - 0.5) * 0.9;
    const offsetX = (rand() - 0.5) * 120;
    const offsetY = (rand() - 0.5) * 90;

    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(ART_SIZE / 2 + offsetX, ART_SIZE / 2 + offsetY);
    ctx.rotate(rotation);

    for (let i = 0; i < blobCount; i++) {
        const color = palette[i % palette.length];
        const cx = (rand() - 0.5) * (ART_SIZE + 140);
        const cy = (rand() - 0.5) * (ART_SIZE + 100);
        const radius = 130 + rand() * 190;
        const alpha = 0.32 + rand() * 0.4;
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        glow.addColorStop(0, rgba(color, alpha));
        glow.addColorStop(0.45, rgba(mix(color, warmDark, 0.45), alpha * 0.55));
        glow.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    // One deep anchor blob for tonal grounding (screen blend, low alpha).
    ctx.globalCompositeOperation = 'screen';
    const anchorX = (rand() - 0.5) * 200;
    const anchorY = (rand() - 0.5) * 160;
    const anchorR = 200 + rand() * 90;
    const anchor = ctx.createRadialGradient(anchorX, anchorY, 0, anchorX, anchorY, anchorR);
    anchor.addColorStop(0, rgba(palette[2], 0.16));
    anchor.addColorStop(1, rgba(palette[2], 0));
    ctx.fillStyle = anchor;
    ctx.beginPath();
    ctx.arc(anchorX, anchorY, anchorR, 0, Math.PI * 2);
    ctx.fill();

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Fine grain overlay.
    const grain = getGrain(rand);
    const pattern = ctx.createPattern(grain, 'repeat');
    if (pattern) {
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = 0.07;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, ART_SIZE, ART_SIZE);
        ctx.globalAlpha = 1;
    }

    // Subtle vignette.
    ctx.globalCompositeOperation = 'source-over';
    const vignette = ctx.createRadialGradient(
        ART_SIZE / 2,
        ART_SIZE / 2,
        ART_SIZE * 0.32,
        ART_SIZE / 2,
        ART_SIZE / 2,
        ART_SIZE * 0.74
    );
    vignette.addColorStop(0, 'rgba(10, 8, 6, 0)');
    vignette.addColorStop(1, 'rgba(10, 8, 6, 0.42)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, ART_SIZE, ART_SIZE);

    ctx.restore();
}

/** Convenience: exports the art for a track as a PNG data URL (512×512). */
export function trackArtDataUrl(track: Track): string {
    const canvas = document.createElement('canvas');
    drawTrackArt(canvas, track);
    return canvas.toDataURL('image/png');
}
