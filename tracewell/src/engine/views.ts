/** The working and output views of a dataset state. */
import { buildOutputView, buildWorkingView } from '@tw/steps';
import type { View } from '@tw/table';
import type { DatasetState } from './state';

export function workingView(ds: DatasetState): View {
  return buildWorkingView(ds.dataset, { overlay: ds.overlay, excluded: ds.excluded, steps: ds.steps });
}

export function outputView(ds: DatasetState): View {
  return buildOutputView(ds.dataset, { overlay: ds.overlay, excluded: ds.excluded, steps: ds.steps });
}

export function viewFor(ds: DatasetState, stage: 'working' | 'output'): View {
  return stage === 'working' ? workingView(ds) : outputView(ds);
}
