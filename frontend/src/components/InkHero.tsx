import { useEffect, useRef, useState } from 'react';

/** Low-resolution, capped-rate ink wash. No shaders, model assets or network. */
export function InkBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, last = 0, time = 0;
    let targetX = .6, targetY = .2, pointerX = .6, pointerY = .2;
    const resize = () => {
      const ratio = Math.min(.65, 800 / innerWidth, 500 / innerHeight);
      canvas.width = Math.max(1, Math.round(innerWidth * ratio));
      canvas.height = Math.max(1, Math.round(innerHeight * ratio));
      draw();
    };
    const draw = () => {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      pointerX += (targetX - pointerX) * .025;
      pointerY += (targetY - pointerY) * .025;
      for (let i = 0; i < 8; i++) {
        const phase = i * 2.37;
        const x = w * (.5 + .48 * Math.sin(phase + time * .045) + (pointerX - .5) * .05);
        const y = h * (.23 + .32 * Math.cos(phase * .7 + time * .035) + (pointerY - .5) * .05);
        const radius = Math.min(w, h) * (.24 + .08 * Math.sin(phase + time * .06));
        const ink = ctx.createRadialGradient(x, y, 0, x, y, radius);
        ink.addColorStop(0, `rgba(54, 78, 94, ${i % 3 === 0 ? .17 : .10})`);
        ink.addColorStop(.5, 'rgba(91, 111, 125, .07)');
        ink.addColorStop(1, 'rgba(91, 111, 125, 0)');
        ctx.fillStyle = ink;
        ctx.beginPath();
        for (let point = 0; point <= 48; point++) {
          const angle = point / 48 * Math.PI * 2;
          const r = radius * (.86 + .09 * Math.sin(angle * 3 + phase + time * .13));
          const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
          if (point === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
      }
    };
    const tick = (now: number) => {
      if (now - last >= 1000 / 24) {
        time += Math.min((now - last) / 1000, .1); last = now; draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      last = performance.now();
      if (!document.hidden && !motion.matches) frame = requestAnimationFrame(tick);
      else draw();
    };
    const move = (event: PointerEvent) => {
      targetX = event.clientX / innerWidth; targetY = event.clientY / innerHeight;
    };
    resize(); resume();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('visibilitychange', resume);
    motion.addEventListener('change', resume);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', move);
      document.removeEventListener('visibilitychange', resume);
      motion.removeEventListener('change', resume);
    };
  }, []);
  return <canvas ref={canvasRef} aria-hidden="true" className="library-ink" />;
}

const SLOGAN = '万卷皆如原文';
const CHARS = SLOGAN.split('');
// 入场编排：眉题 → 逐字浮现（每字 90ms 级联）→ 副标语 → 滚动引导
const charDelay = (i: number) => `${340 + i * 90}ms`;
const SUBTITLE_DELAY = `${340 + CHARS.length * 90 + 160}ms`;

/** Pointer-driven ink; only schedules frames while the drop is moving. */
export default function InkHero() {
  const titleRef = useRef<HTMLButtonElement>(null);
  const [fallbackText, setFallbackText] = useState(false);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    if (typeof CSS === 'undefined' || !CSS.supports?.('clip-path', 'circle(10px at 0 0)')) {
      setFallbackText(true);
      return;
    }
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    let active = false, pinned = false;
    let pointerType = 'mouse';
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const paint = () => {
      el.style.setProperty('--drop-x', `${cx.toFixed(1)}px`);
      el.style.setProperty('--drop-y', `${cy.toFixed(1)}px`);
    };
    const measure = () => {
      el.style.setProperty('--drop-r', `${Math.min(70, Math.max(30, el.clientHeight * .66))}px`);
    };
    const show = (value: boolean) => {
      active = value;
      el.classList.toggle('is-hovering', value);
      el.setAttribute('aria-pressed', String(value));
      if (!value) stop();
    };
    const frame = () => {
      raf = 0;
      cx += (tx - cx) * .3; cy += (ty - cy) * .3;
      if (Math.abs(tx - cx) + Math.abs(ty - cy) < .1) {
        cx = tx; cy = ty; paint(); return;
      }
      paint();
      raf = requestAnimationFrame(frame);
    };
    const target = (x: number, y: number) => {
      tx = x; ty = y;
      if (!active || motion.matches) { stop(); cx = tx; cy = ty; paint(); }
      show(true);
      if (!motion.matches && !raf && (cx !== tx || cy !== ty)) raf = requestAnimationFrame(frame);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const rect = el.getBoundingClientRect();
      target(event.clientX - rect.left, event.clientY - rect.top);
    };
    const onLeave = () => { if (!pinned) show(false); };
    const onDown = (event: PointerEvent) => { pointerType = event.pointerType; };
    const onClick = (event: MouseEvent) => {
      if (pointerType !== 'touch' && event.detail !== 0) return;
      pinned = !pinned;
      if (pinned) target(el.clientWidth / 2, el.clientHeight / 2);
      else show(false);
    };
    const onBlur = () => { pinned = false; show(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onBlur(); };
    const onMotion = () => { stop(); cx = tx; cy = ty; if (active) paint(); };
    const onVisibility = () => { if (document.hidden) onBlur(); };
    const onScroll = () => onBlur();
    const size = new ResizeObserver(measure);
    measure(); size.observe(el);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('click', onClick);
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKey);
    motion.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      stop(); size.disconnect();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', onClick);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      motion.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <section className="library-hero" aria-label="译镜介绍">
      <p className="library-eyebrow reveal-fade" style={{ animationDelay: '120ms' }}>PAPERMIRROR · 译镜</p>
      {fallbackText ? (
        <h1 className="ink-fallback">{SLOGAN}</h1>
      ) : (
        <h1 className="ink-heading" aria-label={SLOGAN}>
          <button ref={titleRef} type="button" className="ink-hero-title" aria-label="切换标题墨滴效果" aria-pressed="false">
            <span className="ink-base" aria-hidden="true">
              {CHARS.map((ch, i) => (
                <span key={i} className="ink-char" style={{ animationDelay: charDelay(i) }}>{ch}</span>
              ))}
            </span>
            <span className="ink-disc" aria-hidden="true" />
            <span className="ink-top" aria-hidden="true">
              {CHARS.map((ch, i) => (
                <span key={i} className="ink-char" style={{ animationDelay: charDelay(i) }}>{ch}</span>
              ))}
            </span>
          </button>
        </h1>
      )}
      <p className="library-intro reveal-fade" style={{ animationDelay: SUBTITLE_DELAY }}>
        原文与译文相映，阅读与思考同行。
      </p>
      <a href="#library" className="hero-scroll-cue" aria-label="向下浏览文献书库" onClick={event => {
        event.preventDefault();
        document.getElementById('library')?.scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start',
        });
      }}>
        <span>文献书库</span>
        <span className="hero-cue-line" aria-hidden="true" />
      </a>
    </section>
  );
}
