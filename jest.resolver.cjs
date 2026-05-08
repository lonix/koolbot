const path = require('path');

module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (error) {
    if (request.startsWith('.') && request.endsWith('.js')) {
      const candidates = [`${request.slice(0, -3)}.ts`];
      const srcIndex = request.indexOf('/src/');

      if (srcIndex !== -1) {
        const srcRelativePath = request.slice(srcIndex + '/src/'.length, -3);
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
