const path = require('path');
const SOURCE_DIR_SEGMENT = '/src/';

module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (error) {
    if ((request.startsWith('./') || request.startsWith('../')) && request.endsWith('.js')) {
      const tsRequest = `${request.slice(0, -3)}.ts`;
      const candidates = [tsRequest, path.resolve(options.basedir, tsRequest)];
      const normalizedRequest = request.replace(/\\/g, '/');
      const srcIndex = normalizedRequest.indexOf(SOURCE_DIR_SEGMENT);

      if (srcIndex !== -1) {
        const srcRelativePath = normalizedRequest.slice(srcIndex + SOURCE_DIR_SEGMENT.length, -3);
        candidates.push(path.join(options.rootDir, 'src', `${srcRelativePath}.ts`));
      }

      for (const candidate of candidates) {
        try {
          return options.defaultResolver(candidate, options);
        } catch {
          // Try the next candidate path.
          continue;
        }
      }
    }

    throw error;
  }
};
