import crypto from 'crypto';

// 快递鳥(kdniao.com)の即時査询インターフェース(RequestType=1002)クライアント。
// 運送会社名(自由入力)を快递鳥の配送業者コードに対応させるための表。
// 中国国内の主要な快递会社のみを対象とする(このアプリで実際に使われている表記に合わせて追加)。
const SHIPPER_CODE_MAP: Record<string, string> = {
  '顺丰': 'SF',
  '顺丰速运': 'SF',
  'sf': 'SF',
  '中通': 'ZTO',
  '中通快递': 'ZTO',
  '圆通': 'YTO',
  '圆通速递': 'YTO',
  '韵达': 'YD',
  '韵达快递': 'YD',
  '韵达速递': 'YD',
  '申通': 'STO',
  '申通快递': 'STO',
  '邮政': 'EMS',
  'ems': 'EMS',
  '中国邮政': 'EMS',
  '中国邮政速递': 'EMS',
  '极兔': 'JTSD',
  '极兔速递': 'JTSD',
  '天天': 'HHTT',
  '天天快递': 'HHTT',
  '百世': 'HTKY',
  '百世快递': 'HTKY',
  '德邦': 'DBL',
  '德邦快递': 'DBL',
  '京东': 'JD',
  '京东物流': 'JD',
};

export function resolveShipperCode(carrier: string): string | null {
  const key = carrier.trim().toLowerCase();
  for (const [name, code] of Object.entries(SHIPPER_CODE_MAP)) {
    if (name.toLowerCase() === key) return code;
  }
  return null;
}

// 即時査询(RequestType=1002)が返すState値の日本語ラベル。
export const KDNIAO_STATE_LABELS: Record<string, string> = {
  '1': '集荷済み',
  '2': '輸送中',
  '201': '配達都市に到着',
  '202': '配達中',
  '211': '宅配ボックス/受取窓口に到着',
  '3': '受取済み(サイン確認)',
  '311': '宅配ボックス/受取窓口から受取済み',
  '4': '異常あり',
  '401': '発送情報なし',
  '402': '受取期限超過',
  '403': '長期間更新なし',
  '404': '受取拒否(返送)',
  '412': '宅配ボックス/受取窓口での受取期限超過',
};

interface KdniaoTrace {
  AcceptTime: string;
  AcceptStation: string;
}

interface KdniaoResponse {
  Success: boolean;
  Reason?: string;
  State?: string;
  Traces?: KdniaoTrace[];
}

function computeDataSign(requestData: string, appKey: string): string {
  // 快递鳥の仕様: (リクエスト内容+AppKey)をMD5し、その16進文字列をBase64エンコードする
  // (MD5の生バイト列ではなく16進文字列をエンコードする点に注意)。
  const md5Hex = crypto.createHash('md5').update(requestData + appKey, 'utf8').digest('hex');
  return Buffer.from(md5Hex, 'utf8').toString('base64');
}

export async function queryKdniaoTracking(
  ebusinessId: string,
  appKey: string,
  shipperCode: string,
  logisticCode: string
): Promise<KdniaoResponse> {
  const requestData = JSON.stringify({ OrderCode: '', ShipperCode: shipperCode, LogisticCode: logisticCode });
  const dataSign = computeDataSign(requestData, appKey);
  const body = new URLSearchParams({
    RequestData: requestData,
    EBusinessID: ebusinessId,
    RequestType: '1002',
    DataSign: dataSign,
    DataType: '2',
  });
  const res = await fetch('https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`快递鳥APIの呼び出しに失敗しました(HTTP ${res.status})`);
  return (await res.json()) as KdniaoResponse;
}
