import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

register('ts-node/esm', pathToFileURL(__dirname)); 
