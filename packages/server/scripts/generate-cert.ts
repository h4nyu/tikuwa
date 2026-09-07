import fs from 'fs';
import os from 'os';
import selfsigned from 'selfsigned';
import { env } from '../src/env';

const keyPath = `${env.certDir}/key.pem`;
const certPath = `${env.certDir}/cert.pem`;

function localIPs(): string[] {
  const ips: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

async function main(): Promise<void> {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('[tikuwa] 証明書は既に存在します:', env.certDir);
    return;
  }

  const altNames = [
    { type: 2 as const, value: 'localhost' },
    { type: 2 as const, value: 'raspberrypi.local' },
    { type: 7 as const, ip: '127.0.0.1' },
    ...localIPs().map((ip) => ({ type: 7 as const, ip })),
  ];

  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'tikuwa.local' }], {
    notAfterDate,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.mkdirSync(env.certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);

  console.log('[tikuwa] 自己署名証明書を作成しました:', env.certDir);
  console.log('  スマホのブラウザで初回アクセス時に警告が出ますが、');
  console.log('  「詳細設定」→「このサイトにアクセスする」等で進めば利用できます。');
  console.log('  ※ Dockerコンテナ内で実行する場合は --network host での実行を推奨します');
  console.log('    (実機のLAN IPをSANに含められるため)。');
}

main();
