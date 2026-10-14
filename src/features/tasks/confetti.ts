/**
 * Reminders confetti — the all-done celebration, ~70 lines of canvas.
 *
 * The legacy Tasks page fired canvas-confetti when checking a task
 * completed the whole list (two bursts, opposite bottom corners, spread 70,
 * angles 60/120 — a stock config worth keeping). Rather than re-adopt the
 * 12 KB dependency for one celebration, this is the same shape in owned
 * code: particles with gravity, drag and a little wobble, drawn on a
 * fixed full-viewport canvas that removes itself when the last piece
 * lands. Respects prefers-reduced-motion by never starting.
 */

const COLORS = ['#d9a03c', '#3d78c4', '#0e9f6e'] as const;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  spin: number;
  angle: number;
  life: number;
}

/**
 * Two bursts from the bottom corners. Fire-and-forget: the canvas tears
 * itself down after the animation, so back-to-back calls (re-checking the
 * last two tasks quickly) each get their own moment.
 */
export function fireTaskConfetti(): void {
  if (typeof window === 'undefined') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'tk-confetti';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  const width = window.innerWidth;
  const height = window.innerHeight;
  const particles: Particle[] = [];

  const burst = (originX: number, angleDeg: number): void => {
    for (let i = 0; i < 100; i += 1) {
      const spread = 70;
      const angle = ((angleDeg + (Math.random() - 0.5) * spread) * Math.PI) / 180;
      const speed = 11 + Math.random() * 8;
      particles.push({
        x: originX,
        y: height - 8,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 5 + Math.random() * 4,
        color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#d9a03c',
        spin: (Math.random() - 0.5) * 0.3,
        angle: Math.random() * Math.PI * 2,
        life: 1,
      });
    }
  };

  burst(4, 60);
  burst(width - 4, 120);

  let last = performance.now();
  const step = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx!.clearRect(0, 0, width, height);
    let alive = false;
    for (const p of particles) {
      p.vy += 22 * dt; // gravity
      p.vx *= 0.985; // drag
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      if (p.y > height + 20) p.life = 0;
      if (p.life <= 0) continue;
      alive = true;
      ctx!.save();
      ctx!.translate(p.x, p.y);
      ctx!.rotate(p.angle);
      ctx!.fillStyle = p.color;
      ctx!.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx!.restore();
    }
    if (alive) {
      requestAnimationFrame(step);
    } else {
      canvas.remove();
    }
  };
  requestAnimationFrame(step);
}
