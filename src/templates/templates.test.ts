import { describe, expect, it } from 'vitest';
import { checkLayout } from '../planning/check';
import { getEnvironment, offArea } from '../environments/environments';
import { TEMPLATES } from './templates';

describe('templates', () => {
  for (const t of TEMPLATES) {
    it(`${t.name} passes the layout check`, () => {
      const layout = t.build();
      expect(checkLayout(layout).map((i) => i.message)).toEqual([]);
    });
    it(`${t.name} fits on the play table`, () => {
      expect(offArea(t.build(), getEnvironment('table'))).toBeNull();
    });
  }
});
