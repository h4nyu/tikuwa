import crypto from 'crypto';

// 快递100(kuaidi100.com)の実時査询インターフェースクライアント。
// 運送会社名(自由入力)を快递100の快递会社コード(com)に対応させるための表。
// 中国国内の主要な快递会社のみを対象とする(このアプリで実際に使われている表記に合わせて追加)。
const COM_CODE_MAP: Record<string, string> = {
  '顺丰': 'shunfeng',
  '顺丰速运': 'shunfeng',
  'sf': 'shunfeng',
  '中通': 'zhongtong',
  '中通快递': 'zhongtong',
  '圆通': 'yuantong',
  '圆通速递': 'yuantong',
  '韵达': 'yunda',
  '韵达快递': 'yunda',
  '韵达速递': 'yunda',
  '申通': 'shentong',
  '申通快递': 'shentong',
  '邮政': 'youzhengguonei',
  'ems': 'ems',
  '中国邮政': 'youzhengguonei',
  '中国邮政速递': 'ems',
  '极兔': 'jtexpress',
  '极兔速递': 'jtexpress',
  '天天': 'tiantian',
  '天天快递': 'tiantian',
  '百世': 'baishiwuliu',
  '百世快递': 'baishiwuliu',
  '德邦': 'debangkuaidi',
  '德邦快递': 'debangkuaidi',
  '京东': 'jd',
  '京东物流': 'jd',
};

// 快递100では顺丰・中通の照会に受取人/送り主の電話番号が必要。未入力の場合は照会に失敗する。
const PHONE_REQUIRED_COMS = new Set(['shunfeng', 'zhongtong']);

export function resolveComCode(carrier: string): string | null {
  const key = carrier.trim().toLowerCase();
  for (const [name, code] of Object.entries(COM_CODE_MAP)) {
    if (name.toLowerCase() === key) return code;
  }
  return null;
}

export function requiresPhone(comCode: string): boolean {
  return PHONE_REQUIRED_COMS.has(comCode);
}

// 実時査询が返すstate値の日本語ラベル。
export const KUAIDI100_STATE_LABELS: Record<string, string> = {
  '0': '輸送中',
  '1': '集荷済み',
  '2': '異常あり',
  '3': '受取済み(サイン確認)',
  '4': 'サイン拒否(返送)',
  '5': '配達中',
  '6': '返送済み',
  '7': '転送済み',
  '8': '精算済み',
  '10': '通関待ち',
  '11': '通関中',
  '12': '通関済み',
  '13': '通関異常',
  '14': '受取拒否',
};

interface Kuaidi100Trace {
  context: string;
  time: string;
  ftime?: string;
}

interface Kuaidi100Response {
  message: string;
  state?: string;
  status?: string;
  data?: Kuaidi100Trace[];
}

function computeSign(param: string, key: string, customer: string): string {
  // 快递100の仕様: (param+key+customer)をMD5し、32桁の大文字16進文字列にする。
  return crypto
    .createHash('md5')
    .update(param + key + customer, 'utf8')
    .digest('hex')
    .toUpperCase();
}

export async function queryKuaidi100Tracking(
  customer: string,
  key: string,
  comCode: string,
  trackingNumber: string,
  phone?: string
): Promise<Kuaidi100Response> {
  const paramObj: Record<string, string> = { com: comCode, num: trackingNumber };
  if (phone) paramObj.phone = phone;
  const param = JSON.stringify(paramObj);
  const sign = computeSign(param, key, customer);
  const body = new URLSearchParams({ customer, sign, param });
  const res = await fetch('https://poll.kuaidi100.com/poll/query.do', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`快递100 APIの呼び出しに失敗しました(HTTP ${res.status})`);
  return (await res.json()) as Kuaidi100Response;
}
