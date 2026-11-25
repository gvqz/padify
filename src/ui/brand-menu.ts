import { $ } from '../lib/q';
import { registerLayer } from './behavior/layers';

/**
 * Brand (wordmark) menu — the navbar's dropdown and its hover deck.
 *
 * This module used to live in help.ts as `initHelp`, where it shared a
 * file with the onboarding help tour. The tour is gone (issue #172: the
 * app's one help surface is the keyboard-shortcuts sheet — the same
 * verdict that deleted the canvas's vendor help dialog), and what
 * remained is what this file is: the "padify" wordmark's dropdown menu
 * (About, Keyboard shortcuts) and the brand deck.
 */

/**
 * Wires the brand (wordmark) menu and the brand deck. Called by boot.ts.
 */
export function initBrandMenu(): void {
  // ---- brand menu -----------------------------------------------------------

  const menu = $('#brandMenu');
  const brandButton = $('#brandMenuButton');

  // The brand menu is a registered dismissable layer: the registry's
  // capture-phase pointerdown sweep closes it when another layer opens
  // (and closes every other layer when this one opens) — no more stacked
  // menus from stopPropagation'ed openers outrunning document click
  // closers.
  const brandLayer = registerLayer({
    elements: [menu.get(0) as HTMLElement, brandButton.get(0) as HTMLElement],
    isOpen: () => menu.hasClass('show'),
    setOpen: (open) => {
      menu.toggleClass('show', open);
      brandButton.attr('aria-expanded', String(open));
    },
  });

  brandButton.on('click', () => {
    brandLayer.toggle();
  });

  // The entries open their modals through Bootstrap's delegated
  // click.bs.modal.data-api handler on the document, so the click must keep
  // bubbling — only close the menu.
  menu.on('click', 'a.brand-menu-item', () => {
    brandLayer.close();
  });

  // ---- brand deck -----------------------------------------------------------

  // Hover is a deck of ten cards now, dealt in the owner's order — magnetic,
  // typo, wire re-ink, wet ink, inhale, misregistration, stamp, circle,
  // mirror, armed key — one per pointerenter, wrapping forever. The design
  // story lives in the comment block in vercel/03-topbar.css; this
  // controller only deals: it sets data-move, which the stylesheet turns
  // into the card, and drives the two cards that are interactions rather
  // than animations (magnetic follows the pointer, typo runs on timers).
  const brandEl = brandButton.get(0) as HTMLElement;
  const stageEl = brandEl.querySelector<HTMLElement>('.brand-stage');

  if (stageEl) {
    const DECK = ['mag', 'typo', 'wire', 'wet', 'inhale', 'reg', 'stamp', 'ring', 'flip', 'arm'];
    let dealt = 0;

    const prefersReduce = (): boolean =>
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

    // card 04 — the d never reflows: the real glyph goes transparent while a
    // ghost paints the wrong key on its own advance, then the word shakes the
    // fix in. Timers fold on leave; a beat abandoned is a beat dropped.
    const typoLetter = stageEl.querySelector<HTMLElement>('.brand-L-typo');
    const typoGhost = stageEl.querySelector<HTMLElement>('.brand-typo');
    let typoTimers: number[] = [];

    const foldTypo = (): void => {
      typoTimers.forEach((t) => clearTimeout(t));
      typoTimers = [];
      typoLetter?.classList.remove('typoing');
      if (typoGhost) typoGhost.textContent = 'd';
      stageEl.classList.remove('glitching');
    };

    const dealTypo = (): void => {
      if (!typoLetter || !typoGhost) return;
      const beat = (fn: () => void, ms: number): void => {
        typoTimers.push(window.setTimeout(fn, ms));
      };
      beat(() => {
        typoGhost.textContent = 'b';
        typoLetter.classList.add('typoing');
      }, 140);
      beat(() => {
        typoGhost.textContent = 'e';
      }, 250);
      beat(() => {
        typoGhost.textContent = 'd';
        typoLetter.classList.remove('typoing');
        stageEl.classList.add('glitching');
      }, 360);
      beat(() => stageEl.classList.remove('glitching'), 580);
    };

    // card 02 — magnetic: the letters lean toward the pointer, clamped to
    // 2.2px; the stylesheet springs them home when the card folds.
    const letters = Array.from(stageEl.querySelectorAll<HTMLElement>('.brand-word > .brand-L'));

    const foldMagnet = (): void => {
      letters.forEach((letter) => {
        letter.style.transform = '';
      });
    };

    const setMove = (move: string | null): void => {
      if (move === null) stageEl.removeAttribute('data-move');
      else stageEl.setAttribute('data-move', move);
    };

    brandEl.addEventListener('pointerenter', () => {
      if (prefersReduce()) return; // reduced motion: the CSS dim is the hover
      const move = DECK[dealt % DECK.length];
      dealt += 1;
      foldTypo();
      foldMagnet();
      setMove(null);
      // flush style so a re-dealt card restarts its animation from zero
      void stageEl.offsetWidth;
      setMove(move);
      if (move === 'typo') dealTypo();
    });

    brandEl.addEventListener('pointerleave', () => {
      foldTypo();
      foldMagnet();
      // one-shot animations land before the card folds — canceling a flip
      // mid-air snaps the whole word; transition-driven cards (ring, arm)
      // fold at once so they retract on the way out
      const running = stageEl
        .getAnimations({ subtree: true })
        .filter((a) => a instanceof CSSAnimation && a.playState === 'running');
      if (running.length) {
        Promise.allSettled(running.map((a) => a.finished)).then(() => {
          if (!brandEl.matches(':hover')) setMove(null);
        });
      } else {
        setMove(null);
      }
    });

    brandEl.addEventListener('pointermove', (event) => {
      if (stageEl.getAttribute('data-move') !== 'mag' || prefersReduce()) return;
      const x = event.clientX - stageEl.getBoundingClientRect().left;
      letters.forEach((letter) => {
        const center = letter.offsetLeft + letter.offsetWidth / 2;
        const pull = Math.max(-2.2, Math.min(2.2, (x - center) * 0.16));
        letter.style.transform = `translateX(${pull}px)`;
      });
    });
  }
}
