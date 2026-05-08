const path = require('path');

module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (error) {
    if (request.startsWith('.') && request.endsWith('.js')) {
      const tsRequest = `${request.slice(0, -3)}.ts`;
      const candidates = [tsRequest, path.resolve(options.basedir, tsRequest)];
      const normalizedRequest = request.replace(/\\/g, '/');
      const srcPrefix = '/src/';
      const srcIndex = normalizedRequest.indexOf(srcPrefix);

      if (srcIndex !== -1) {
        const srcRelativePath = normalizedRequest.slice(srcIndex + srcPrefix.length, -3);
        candidates.push(path.join(options.rootDir, 'src', `${srcRelativePath}.ts`));
      }

      for (const candidate of candidates) {
        try {
          return options.defaultResolver(candidate, options);
        } catch {
          continue;
        }
      }
    }

    throw error;
  }
};
