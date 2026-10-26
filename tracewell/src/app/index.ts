// Public entry point of the app module, imported elsewhere as '@tw/app': the bootstrap that starts
// the engine worker and mounts the workbench, and the protocol check it applies.
export { bootstrap } from './bootstrap';
export { checkProtocol } from './protocol';
export { PROFILE_KEY, loadProfile, saveProfile } from './profile';
