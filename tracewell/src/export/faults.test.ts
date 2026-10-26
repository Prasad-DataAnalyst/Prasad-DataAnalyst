import { describe, expect, it } from 'vitest';
import { readZip, writeZip } from '@tw/io';
import type { ValidationCheck } from '@tw/model';
import { CTX, datasetOf, inputOf, viewOf } from './__fixtures__/input';
import { DEFAULT_WRITERS, buildExport, readBack, type ExportWriters } from './index';

const view = viewOf(datasetOf());

function failing(checks: ValidationCheck[]): string[] {
  return [...new Set(checks.filter((c) => !c.ok).map((c) => c.id))];
}

describe('fault injection', () => {
  it('a corrupted number fails RB-VALUES and offers no package', async () => {
    const writers: ExportWriters = {
      ...DEFAULT_WRITERS,
      csv: (h, rows) =>
        DEFAULT_WRITERS.csv(
          h,
          [...rows].map((r, i) => (i === 0 ? r.map((v, j) => (j === 3 ? '1205.4' : v)) : r)),
        ),
    };
    const result = await buildExport(inputOf(view, { profile: 'csv' }), CTX, writers);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBeUndefined();
    expect(result.packageSha256).toBeNull();
    expect(failing(result.validation.checks)).toContain('RB-VALUES');
  });

  it('a dropped last row fails RB-ROWS', async () => {
    const writers: ExportWriters = {
      ...DEFAULT_WRITERS,
      csv: (h, rows) => DEFAULT_WRITERS.csv(h, [...rows].slice(0, -1)),
    };
    const result = await buildExport(inputOf(view, { profile: 'csv' }), CTX, writers);
    expect(failing(result.validation.checks)).toContain('RB-ROWS');
  });

  it('a renamed Data sheet fails RB-XLSX-STRUCTURE', async () => {
    const writers: ExportWriters = {
      ...DEFAULT_WRITERS,
      xlsx: (book) =>
        DEFAULT_WRITERS.xlsx({
          ...book,
          sheets: book.sheets.map((s) => (s.name === 'Data' ? { ...s, name: 'Sheet1' } : s)),
        }),
    };
    const result = await buildExport(inputOf(view, { profile: 'excel' }), CTX, writers);
    expect(failing(result.validation.checks)).toContain('RB-XLSX-STRUCTURE');
  });

  it('swapped longitude and latitude fail RB-GEOJSON-STRUCTURE', async () => {
    const writers: ExportWriters = {
      ...DEFAULT_WRITERS,
      geojson: (features) =>
        DEFAULT_WRITERS.geojson(
          [...features].map((f) =>
            f.geometry?.type === 'Point'
              ? {
                  ...f,
                  geometry: {
                    type: 'Point' as const,
                    coordinates: [f.geometry.coordinates[1] as number, f.geometry.coordinates[0] as number],
                  },
                }
              : f,
          ),
        ),
    };
    const result = await buildExport(inputOf(view, { profile: 'geojson' }), CTX, writers);
    expect(failing(result.validation.checks)).toContain('RB-GEOJSON-STRUCTURE');
  });

  it('an altered CHECKSUMS line fails RB-PKG-CHECKSUMS', async () => {
    const result = await buildExport(inputOf(view, { profile: 'csv' }), CTX);
    const zip = readZip(result.bytes ?? new Uint8Array());
    const entries = zip.paths().map((path) => {
      let data = zip.read(path);
      if (path === 'CHECKSUMS.sha256') {
        const text = new TextDecoder().decode(data);
        data = new TextEncoder().encode(text.replace(/^[0-9a-f]/, (c) => (c === '0' ? '1' : '0')));
      }
      return { path, data };
    });
    const tampered = writeZip(entries, { sort: true });
    expect(failing(readBack.package(tampered, result.manifest))).toContain('RB-PKG-CHECKSUMS');
  });
});
