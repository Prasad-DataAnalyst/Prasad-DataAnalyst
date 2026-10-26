import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureSource } from '@tw/fixtures';
import { viewDigest } from '@tw/table';
import { importSource, previewSource } from './index';
import { context, plainView } from './__fixtures__/helpers';

describe('determinism', () => {
  it.each(FIXTURE_NAMES)('%s imports to the same digest twice', async (name) => {
    const digest = async () => {
      const src = fixtureSource(name);
      const preview = await previewSource(src);
      const outcome = await importSource(src, 'd1', preview.spec, context());
      return viewDigest(plainView(outcome.dataset)).sha256;
    };
    expect(await digest()).toBe(await digest());
  });

  it('refuses a spec planned for different bytes', async () => {
    const a = await previewSource(fixtureSource('csv_well_daily_golden.csv'));
    const planned = await importSource(fixtureSource('csv_well_daily_golden.csv'), 'd1', a.spec, context());
    await expect(
      importSource(fixtureSource('csv_null_markers.csv'), 'd1', planned.spec, context()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
