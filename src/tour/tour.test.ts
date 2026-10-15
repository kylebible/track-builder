import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import trains from '../trains/trains.ts?raw';
import { placeCard, STEPS } from './tour';

const view = { width: 1200, height: 800 };
const card = { width: 320, height: 180 };

describe('tour card placement', () => {
  it('sits in the middle with nothing to point at', () => {
    expect(placeCard(null, card, view)).toEqual({ left: 440, top: 310 });
  });

  it('goes under a toolbar button, centred on it', () => {
    expect(placeCard({ left: 600, top: 12, width: 40, height: 36 }, card, view)).toEqual({ left: 460, top: 60 });
  });

  it('stays on screen under a button at the right edge', () => {
    expect(placeCard({ left: 1150, top: 12, width: 40, height: 36 }, card, view).left).toBe(1200 - 320 - 8);
  });

  it('goes above a palette docked along the bottom', () => {
    const phone = { width: 390, height: 800 };
    const at = placeCard({ left: 0, top: 628, width: 390, height: 172 }, { width: 374, height: 180 }, phone);
    expect(at.top).toBe(628 - 12 - 180);
    expect(at.left).toBe(8);
  });

  it('goes beside a full-height sidebar', () => {
    expect(placeCard({ left: 0, top: 0, width: 284, height: 800 }, card, view)).toEqual({ left: 296, top: 310 });
  });
});

describe('tour steps', () => {
  it('starts with a welcome and ends at Help, where it can be found again', () => {
    expect(STEPS[0].anchor).toBeUndefined();
    expect(STEPS.at(-1)!.anchor).toContain('#help-button');
  });

  it('points only at ids the page has', () => {
    for (const step of STEPS) {
      const ids = (step.anchor ?? []).filter((s) => s.startsWith('#')).map((s) => s.slice(1));
      for (const id of ids) expect(html.includes(`id="${id}"`) || trains.includes(`id: '${id}'`), id).toBe(true);
    }
  });
});
