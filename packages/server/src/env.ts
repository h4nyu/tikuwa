// すべてリポジトリルート(=プロセスの起動時cwd)からの相対パスとして扱う。
// npm scripts・Dockerfile(WORKDIR /app)のどちらもリポジトリルートで起動する前提。
export const env = {
  httpPort: Number(process.env.PORT) || 3000,
  httpsPort: Number(process.env.HTTPS_PORT) || 3443,
  dbPath: process.env.DB_PATH || 'data/tikuwa.db',
  certDir: process.env.CERT_DIR || 'certs',
  webPublicDir: process.env.WEB_PUBLIC_DIR || 'packages/web/dist',
};
