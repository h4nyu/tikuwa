import fs from 'fs';
import path from 'path';
import { createServer as createHttpsServer } from 'https';
import { serve } from '@hono/node-server';
import { openDatabase, SqliteProductRepository } from '@tikuwa/db';
import { createApp } from './app';
import { env } from './env';

function run(): void {
  const db = openDatabase(env.dbPath);
  const repo = SqliteProductRepository(db);
  const app = createApp(repo, env.webPublicDir);

  const keyPath = path.join(env.certDir, 'key.pem');
  const certPath = path.join(env.certDir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    serve(
      {
        fetch: app.fetch,
        port: env.httpsPort,
        hostname: '0.0.0.0',
        createServer: createHttpsServer,
        serverOptions: {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath),
        },
      },
      () => {
        console.log(`[tikuwa] HTTPS server: https://<このマシンのIP>:${env.httpsPort}`);
        console.log('  カメラでバーコードを読み取るにはHTTPSでアクセスしてください。');
      }
    );
  } else {
    console.log('[tikuwa] 証明書が見つかりません。"npm run gen-cert" を実行するとHTTPSが有効になります。');
  }

  serve({ fetch: app.fetch, port: env.httpPort, hostname: '0.0.0.0' }, () => {
    console.log(`[tikuwa] HTTP server:  http://<このマシンのIP>:${env.httpPort}`);
  });
}

run();
