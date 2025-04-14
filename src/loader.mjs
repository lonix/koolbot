import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

register('ts-node/esm/transpile-only', pathToFileURL('./')); 
