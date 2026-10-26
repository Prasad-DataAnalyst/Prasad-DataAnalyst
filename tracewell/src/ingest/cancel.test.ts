import { describe, expect, it } from 'vitest';
import { fixtureSource } from '@tw/fixtures';
import { importSource, previewSource } from './index';
import { context } from './__fixtures__/helpers';

describe('cancel', () => {
  it('rejects with CANCELLED when aborted after the first progress event', async () => {
    const src = fixtureSource('csv_timeseries_gaps_dups_flatline_spike.csv');
    const preview = await previewSource(src);
    const ctl = new AbortController();
    const run = importSource(src, 'd1', preview.spec, context({ signal: ctl.signal, onProgress: () => ctl.abort() }));
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects at once when already aborted', async () => {
    const src = fixtureSource('csv_well_daily_golden.csv');
    const preview = await previewSource(src);
    const ctl = new AbortController();
    ctl.abort();
    await expect(importSource(src, 'd1', preview.spec, context({ signal: ctl.signal }))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });
});
