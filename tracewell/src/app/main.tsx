// Browser entry point referenced by index.html: mounts Tracewell into #root.
import { bootstrap } from './bootstrap';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html must contain <div id="root">.');
void bootstrap(root);
