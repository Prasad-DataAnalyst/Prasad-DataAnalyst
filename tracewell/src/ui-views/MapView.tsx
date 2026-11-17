/**
 * The map view (FR-MAP-01, FR-MAP-02, FR-MAP-04): a stage's rows where they are, in WGS 84
 * longitude and latitude, as the engine places them (getPlaces). Clicking a place selects its row,
 * which the grid and the properties panel follow, and a row selected elsewhere is marked on the
 * map. A basemap is read from a local PMTiles file; without one a graticule shows where the map is.
 * A box drawn on the map becomes a filter step, with a preview and a reason, for data in WGS 84.
 * MapLibre loads only when a map tab opens.
 */
import { useEffect, useRef, useState } from 'react';
import type { EngineClient } from '@tw/engine-api';
import type { DatasetId, PlacesWindow, RowId, StepInput, StepPreview } from '@tw/model';
import { formatCount, toErrorData, useWorkbench, type CentreViewProps } from '@tw/ui-shell';
import { ErrorNote, useReasonPrompt } from './common';
import { applyStep } from './dialogs';
import { datasetFor, useEngineQuery, useProject } from './hooks';
import type { BasemapInfo, MapController } from './map-lib';
import { areaPredicate, themeColours, type LonLatBox } from './map-style';
import { gotoRow } from './store';
import { TID } from './testids';

type MapLib = typeof import('./map-lib');

export function MapView(p: CentreViewProps): React.JSX.Element {
  const project = useProject();
  const datasetId = datasetFor(p.tab, project);
  if (datasetId === null) return <div className="tw-empty">Import a file with coordinates to see it on the map.</div>;
  return <PlacesMap engine={p.engine} datasetId={datasetId} />;
}

type AreaState = { box: LonLatBox; reason: string } | { box: LonLatBox; step: StepInput; preview: StepPreview | null };

function sourceColumn(p: PlacesWindow | null | undefined): string | undefined {
  if (p?.source == null) return undefined;
  return 'geometry' in p.source ? p.source.geometry : p.source.x;
}

function PlacesMap(p: { engine: EngineClient; datasetId: DatasetId }): React.JSX.Element {
  const { engine, datasetId } = p;
  const summary = useProject()?.datasets.find((d) => d.id === datasetId);
  const readOnly = useWorkbench((s) => s.project?.readOnly === true);
  const selection = useWorkbench((s) => s.selection);
  const select = useWorkbench((s) => s.select);
  const [stage, setStage] = useState<'working' | 'output'>('working');
  const places = useEngineQuery(engine, `places:${datasetId}:${stage}`, () => engine.getPlaces({ datasetId, stage }), [
    'schema',
    'steps',
    'datasets',
    'audit',
  ]);
  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);
  const lib = useRef<MapLib | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [rendered, setRendered] = useState<number | null>(null);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [basemapLoaded, setBasemapLoaded] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [area, setArea] = useState<AreaState | null>(null);
  const reason = useReasonPrompt();

  // The handlers the map calls read the latest state through this ref.
  const latest = useRef({ places: places.data, datasetId });
  useEffect(() => {
    latest.current = { places: places.data, datasetId };
  }, [places.data, datasetId]);

  useEffect(() => {
    let live = true;
    let made: MapController | null = null;
    import('./map-lib').then(
      (m) => {
        if (!live || container.current === null) return;
        lib.current = m;
        const style = getComputedStyle(document.documentElement);
        made = m.createMap(
          container.current,
          themeColours((n) => style.getPropertyValue(n)),
          {
            select: (rowId: RowId) => {
              const { datasetId: id, places: current } = latest.current;
              const columnId = sourceColumn(current);
              if (columnId === undefined) return;
              select({ kind: 'cell', datasetId: id, rowId, columnId });
              gotoRow(id, rowId, columnId);
            },
            area: (box: LonLatBox) => {
              setDrawing(false);
              const current = latest.current.places;
              if (current == null) return;
              const made = areaPredicate(current, box);
              if ('reason' in made) {
                setArea({ box, reason: made.reason });
                return;
              }
              const step: StepInput = { kind: 'filter', predicate: made.predicate };
              setArea({ box, step, preview: null });
              engine.previewStep(latest.current.datasetId, step).then(
                (preview) => setArea((a) => (a !== null && 'step' in a && a.step === step ? { ...a, preview } : a)),
                (e: unknown) =>
                  setArea((a) =>
                    a !== null && 'step' in a && a.step === step
                      ? { ...a, preview: { ok: false, error: toErrorData(e), description: '', sample: [] } }
                      : a,
                  ),
              );
            },
            rendered: (count: number) => setRendered(count),
            basemapLoaded: () => setBasemapLoaded(true),
          },
        );
        controller.current = made;
        setBasemap(m.currentBasemap());
        setReady(true);
      },
      (e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
      made?.destroy();
      controller.current = null;
    };
  }, [engine, select]);

  // New places: fitted to the view the first time each stage is shown, kept in view after edits.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || places.data == null) return;
    const key = `${datasetId}|${stage}`;
    controller.current?.setPlaces(places.data, fitted.current !== key);
    fitted.current = key;
  }, [ready, places.data, datasetId, stage]);

  const selectedRow = selection.kind === 'cell' && selection.datasetId === datasetId ? selection.rowId : null;
  useEffect(() => {
    if (ready) controller.current?.setSelected(selectedRow);
  }, [ready, selectedRow]);

  useEffect(() => {
    if (ready) controller.current?.setDrawing(drawing);
  }, [ready, drawing]);

  const chooseBasemap = async (file: File | null) => {
    if (file === null || lib.current === null) return;
    try {
      setFailed(null);
      setBasemapLoaded(false);
      setBasemap(await lib.current.openBasemap(file));
      controller.current?.refreshBasemap();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };

  const clearArea = () => {
    setArea(null);
    controller.current?.clearArea();
  };

  const applyArea = async () => {
    if (area === null || !('step' in area) || area.preview?.ok !== true) return;
    const label = `Keep rows within [${area.box.join(', ')}]`;
    const why = await reason.ask(label, 'Rows inside the drawn area');
    if (why === null) return;
    if (await applyStep(engine, datasetId, area.step, why, label)) clearArea();
  };

  const data = places.data ?? undefined;
  const status =
    data === undefined
      ? 'Placing rows…'
      : data.unplaced !== null
        ? null
        : `${formatCount(data.placed)} of ${formatCount(data.rows)} rows placed` +
          (data.transformed ? ` · shown in WGS 84, transformed from ${data.crs ?? ''}` : ` · ${data.crs ?? ''}`) +
          (data.truncated ? ` · the first ${formatCount(data.features.length)} drawn` : '');

  return (
    <div
      className="tw-view tw-map-view"
      data-testid={TID.mapView}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && drawing) setDrawing(false);
      }}
    >
      <div className="tw-view-toolbar" role="toolbar" aria-label="Map">
        <div className="tw-segmented" role="radiogroup" aria-label="Stage" data-testid={TID.mapStage}>
          {(['working', 'output'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={stage === s}
              className={stage === s ? 'tw-seg-on' : ''}
              onClick={() => setStage(s)}
            >
              {s === 'working' ? 'Working data' : 'Output'}
            </button>
          ))}
        </div>
        <span className="tw-view-meta" data-testid={TID.mapStatus} aria-live="polite">
          {summary?.name ?? datasetId}
          {status === null ? '' : ` · ${status}`}
        </span>
        <span className="tw-toolbar-spacer" />
        <button
          type="button"
          aria-pressed={drawing}
          data-testid={TID.mapDraw}
          disabled={!ready || readOnly || data?.source == null}
          onClick={() => setDrawing((d) => !d)}
          title="Drag a box on the map to keep the rows inside it; Escape stops drawing"
        >
          {drawing ? 'Drawing… (Esc to stop)' : 'Draw area'}
        </button>
        <label className="tw-inline-field">
          Basemap
          <input
            type="file"
            accept=".pmtiles"
            data-testid={TID.mapBasemap}
            disabled={!ready}
            onChange={(e) => void chooseBasemap(e.currentTarget.files?.[0] ?? null)}
          />
        </label>
        <span className="tw-view-meta" data-testid={TID.mapBasemapStatus}>
          {basemap === null
            ? 'No basemap: a graticule every 10°'
            : `${basemap.name} (${basemap.kind}, zoom ${basemap.minZoom} to ${basemap.maxZoom})`}
        </span>
      </div>
      {data?.unplaced != null && (
        <ErrorNote error={{ code: 'INVALID_INPUT', message: data.unplaced.reason, fix: data.unplaced.fix }} />
      )}
      {failed !== null && (
        <div className="tw-error-note" role="alert">
          <strong>{failed}</strong>
        </div>
      )}
      {area !== null && (
        <div className="tw-map-area" data-testid={TID.mapArea} aria-live="polite">
          <span className="tw-mono">[{area.box.join(', ')}]</span>
          {'reason' in area ? (
            <span>{area.reason}</span>
          ) : area.preview === null ? (
            <span>Previewing…</span>
          ) : area.preview.ok ? (
            <span>
              {area.preview.description}: {formatCount(area.preview.resultingRows ?? 0)} of{' '}
              {formatCount(data?.rows ?? 0)} rows kept
            </span>
          ) : (
            <ErrorNote error={area.preview.error} />
          )}
          <span className="tw-toolbar-spacer" />
          {'step' in area && (
            <button
              type="button"
              className="tw-primary"
              data-testid={TID.mapAreaApply}
              disabled={area.preview?.ok !== true || readOnly}
              onClick={() => void applyArea()}
            >
              Filter…
            </button>
          )}
          <button type="button" onClick={clearArea}>
            Clear
          </button>
        </div>
      )}
      <div
        ref={container}
        className="tw-map-canvas"
        data-testid={TID.mapCanvas}
        data-ready={ready && rendered !== null ? 'true' : 'false'}
        data-rendered={rendered ?? ''}
        data-selected={selectedRow ?? ''}
        data-basemap={basemap === null ? 'none' : basemapLoaded ? 'loaded' : 'loading'}
        aria-label={`Map of ${summary?.name ?? datasetId}`}
      />
      {reason.element}
    </div>
  );
}
