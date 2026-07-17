import { buildApp } from './app.js';
import { buildDeps } from './deps.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp(buildDeps());
app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((addr) => console.log(`identity-sidecar listening on ${addr}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
