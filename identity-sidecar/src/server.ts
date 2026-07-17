import { buildApp } from './app.js';
import { buildDeps } from './deps.js';
import { attachWsServer } from './wsServer.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const deps = buildDeps();
const app = buildApp(deps);
app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((addr) => {
    attachWsServer(app.server, deps, config.bearerToken);
    console.log(`identity-sidecar listening on ${addr} (+ /ws)`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
