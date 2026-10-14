// Runs scripts/exportScenery.ts through Vite, so it can import the app's
// TypeScript modules as they are.
import { runnerImport } from 'vite';

const { module } = await runnerImport('./scripts/exportScenery.ts');
await module.exportAll();
