/**
 * The map itself, with MapLibre GL JS, loaded only when a map tab opens: a stage's places drawn
 * over a basemap read from a local PMTiles file, or over a graticule when there is none, with the
 * selected row marked and a box drawn to filter by. MapLibre's worker is a file of the application's
 * own origin, as the Content Security Policy requires, and basemap tiles are read from the chosen
 * file through the pmtiles protocol: nothing is fetched from a network (NFR-07).
 */
import {
  AttributionControl,
  Map as MapLibre,
  NavigationControl,
  ScaleControl,
  addProtocol,
  setWorkerUrl,
  type GeoJSONSource,
  type LayerSpecification,
  type MapMouseEvent,
  type SourceSpecification,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { FileSource, PMTiles, Protocol } from 'pmtiles';
import type { PlacesWindow, RowId } from '@tw/model';
import {
  basemapLayers,
  boundsOf,
  boxBetween,
  boxFeature,
  graticule,
  placesCollection,
  tileKind,
  type LonLatBox,
  type MapColours,
  type TileKind,
} from './map-style';

setWorkerUrl(workerUrl);
const protocol = new Protocol({ metadata: true });
addProtocol('pmtiles', protocol.tile);

export interface BasemapInfo {
  name: string;
  kind: TileKind;
  minZoom: number;
  maxZoom: number;
  /** The source layers of a vector archive, each drawn plainly. */
  layers: string[];
  /** Whom the basemap's data must be credited to, as the archive says. */
  attribution: string | null;
}

/** The basemap chosen in this session, kept for every map opened after it. */
let current: { info: BasemapInfo; url: string } | null = null;

export function currentBasemap(): BasemapInfo | null {
  return current?.info ?? null;
}

/** Reads a PMTiles archive from a local file; its tiles are read from the file as the map needs them. */
export async function openBasemap(file: File): Promise<BasemapInfo> {
  const archive = new PMTiles(new FileSource(file));
  const header = await archive.getHeader();
  const kind = tileKind(header.tileType);
  if (kind === 'unsupported') {
    throw new Error(`${file.name} holds tiles of a kind the map cannot draw; choose a vector or image basemap.`);
  }
  const metadata = (await archive.getMetadata()) as {
    vector_layers?: { id?: unknown }[];
    attribution?: unknown;
  } | null;
  protocol.add(archive);
  const info: BasemapInfo = {
    name: file.name,
    kind,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    layers: (metadata?.vector_layers ?? []).flatMap((l) => (typeof l.id === 'string' ? [l.id] : [])),
    attribution: typeof metadata?.attribution === 'string' ? metadata.attribution : null,
  };
  current = { info, url: `pmtiles://${archive.source.getKey()}` };
  return info;
}

const EMPTY = { type: 'FeatureCollection' as const, features: [] };
const PLACE_LAYERS = ['places-fill', 'places-line', 'places-point'];
const NONE: RowId = -1;

const isType = (...types: string[]) => ['in', ['geometry-type'], ['literal', types]];

function basemapSource(c: NonNullable<typeof current>): SourceSpecification {
  return c.info.kind === 'raster' ? { type: 'raster', url: c.url, tileSize: 256 } : { type: 'vector', url: c.url };
}

function styleOf(colours: MapColours): StyleSpecification {
  const sources: StyleSpecification['sources'] = {
    graticule: { type: 'geojson', data: graticule() },
    places: { type: 'geojson', data: EMPTY },
    area: { type: 'geojson', data: EMPTY },
  };
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': colours.background } },
  ];
  if (current !== null) {
    sources['basemap'] = basemapSource(current);
    layers.push(...(basemapLayers(current.info.kind, current.info.layers, colours) as LayerSpecification[]));
  }
  layers.push(
    {
      id: 'graticule',
      type: 'line',
      source: 'graticule',
      paint: { 'line-color': colours.lines, 'line-width': 0.5, 'line-opacity': current === null ? 0.9 : 0.4 },
    },
    {
      id: 'places-fill',
      type: 'fill',
      source: 'places',
      filter: isType('Polygon', 'MultiPolygon') as never,
      paint: { 'fill-color': colours.places, 'fill-opacity': 0.2 },
    },
    {
      id: 'places-line',
      type: 'line',
      source: 'places',
      filter: isType('LineString', 'MultiLineString', 'Polygon', 'MultiPolygon') as never,
      paint: { 'line-color': colours.places, 'line-width': 1.5 },
    },
    {
      id: 'places-point',
      type: 'circle',
      source: 'places',
      filter: isType('Point', 'MultiPoint') as never,
      paint: {
        'circle-color': colours.places,
        'circle-radius': 4,
        'circle-stroke-color': colours.background,
        'circle-stroke-width': 1,
      },
    },
    {
      id: 'selected-line',
      type: 'line',
      source: 'places',
      filter: ['==', ['get', 'rowId'], NONE],
      paint: { 'line-color': colours.selected, 'line-width': 3 },
    },
    {
      id: 'selected-point',
      type: 'circle',
      source: 'places',
      filter: ['all', isType('Point', 'MultiPoint'), ['==', ['get', 'rowId'], NONE]] as never,
      paint: {
        'circle-color': colours.selected,
        'circle-radius': 7,
        'circle-stroke-color': colours.background,
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'area-fill',
      type: 'fill',
      source: 'area',
      paint: { 'fill-color': colours.area, 'fill-opacity': 0.08 },
    },
    {
      id: 'area-line',
      type: 'line',
      source: 'area',
      paint: { 'line-color': colours.area, 'line-width': 1.5, 'line-dasharray': [3, 2] },
    },
  );
  return { version: 8, sources, layers };
}

export interface MapEvents {
  /** A place was clicked. */
  select(rowId: RowId): void;
  /** A box was drawn. */
  area(box: LonLatBox): void;
  /** The places are drawn; `count` rows show in the current view. */
  rendered(count: number): void;
  /** The basemap's first tiles were read and drawn. */
  basemapLoaded(): void;
}

export interface MapController {
  setPlaces(p: PlacesWindow | null, fit: boolean): void;
  setSelected(rowId: RowId | null): void;
  setDrawing(on: boolean): void;
  clearArea(): void;
  /** Draws the basemap chosen since the map was made. */
  refreshBasemap(): void;
  destroy(): void;
}

export function createMap(container: HTMLElement, colours: MapColours, events: MapEvents): MapController {
  const map = new MapLibre({
    container,
    style: styleOf(colours),
    center: [0, 20],
    zoom: 1,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    renderWorldCopies: false,
  });
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
  let attribution: AttributionControl | null = null;
  const credit = () => {
    if (attribution !== null) map.removeControl(attribution);
    attribution = null;
    const text = current?.info.attribution;
    if (text) {
      attribution = new AttributionControl({ compact: true, customAttribution: text });
      map.addControl(attribution, 'bottom-right');
    }
  };
  credit();

  let loaded = false;
  let pending: { places: PlacesWindow | null; fit: boolean } | null = null;
  let drawing = false;
  let start: [number, number] | null = null;

  const placesSource = () => map.getSource('places') as GeoJSONSource | undefined;
  const areaSource = () => map.getSource('area') as GeoJSONSource | undefined;

  const show = (p: PlacesWindow | null, fit: boolean) => {
    void placesSource()?.setData(placesCollection(p) as never);
    const box = fit ? boundsOf(p) : null;
    if (box !== null) {
      map.fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        { padding: 40, maxZoom: 12, duration: 0 },
      );
    }
    void map.once('idle', () => {
      const shown = new Set(map.queryRenderedFeatures({ layers: PLACE_LAYERS }).map((f) => f.properties['rowId']));
      events.rendered(shown.size);
    });
  };

  map.on('load', () => {
    loaded = true;
    if (pending !== null) show(pending.places, pending.fit);
    pending = null;
  });
  map.on('sourcedata', (e) => {
    if (e.sourceId === 'basemap' && e.isSourceLoaded && e.tile !== undefined) events.basemapLoaded();
  });

  const hits = (e: MapMouseEvent) =>
    map.queryRenderedFeatures(
      [
        [e.point.x - 4, e.point.y - 4],
        [e.point.x + 4, e.point.y + 4],
      ],
      { layers: PLACE_LAYERS },
    );
  map.on('click', (e) => {
    if (drawing) return;
    const rowId = hits(e)[0]?.properties['rowId'];
    if (typeof rowId === 'number') events.select(rowId);
  });
  map.on('mousemove', (e) => {
    if (drawing && start !== null) {
      void areaSource()?.setData(boxFeature(boxBetween(start, [e.lngLat.lng, e.lngLat.lat])) as never);
      return;
    }
    map.getCanvas().style.cursor = drawing ? 'crosshair' : hits(e).length > 0 ? 'pointer' : '';
  });
  map.on('mousedown', (e) => {
    if (!drawing) return;
    e.preventDefault();
    start = [e.lngLat.lng, e.lngLat.lat];
  });
  map.on('mouseup', (e) => {
    if (!drawing || start === null) return;
    const box = boxBetween(start, [e.lngLat.lng, e.lngLat.lat]);
    start = null;
    void areaSource()?.setData(boxFeature(box) as never);
    events.area(box);
  });

  return {
    setPlaces(p, fit) {
      if (loaded) show(p, fit);
      else pending = { places: p, fit };
    },
    setSelected(rowId) {
      const id = rowId ?? NONE;
      const apply = () => {
        map.setFilter('selected-line', ['==', ['get', 'rowId'], id]);
        map.setFilter('selected-point', ['all', isType('Point', 'MultiPoint'), ['==', ['get', 'rowId'], id]] as never);
      };
      if (loaded) apply();
      else void map.once('load', apply);
    },
    setDrawing(on) {
      drawing = on;
      start = null;
      if (on) map.dragPan.disable();
      else map.dragPan.enable();
      map.getCanvas().style.cursor = on ? 'crosshair' : '';
    },
    clearArea() {
      void areaSource()?.setData(EMPTY as never);
    },
    refreshBasemap() {
      const apply = () => {
        for (const layer of map.getStyle().layers.filter((l) => l.id.startsWith('basemap-'))) map.removeLayer(layer.id);
        if (map.getSource('basemap') !== undefined) map.removeSource('basemap');
        if (current === null) return;
        map.addSource('basemap', basemapSource(current));
        for (const layer of basemapLayers(current.info.kind, current.info.layers, colours)) {
          map.addLayer(layer as LayerSpecification, 'graticule');
        }
        map.setPaintProperty('graticule', 'line-opacity', 0.4);
        credit();
      };
      if (loaded) apply();
      else void map.once('load', apply);
    },
    destroy() {
      map.remove();
    },
  };
}
