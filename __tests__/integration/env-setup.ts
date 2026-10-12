// Runs before each integration suite loads. `src/config/env.ts` calls dotenv at
// import time, which logs a line to stderr on every load unless told otherwise.
process.env.DOTENV_CONFIG_QUIET = "true";
