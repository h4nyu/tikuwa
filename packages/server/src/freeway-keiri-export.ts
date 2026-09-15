import type { SaleRecord } from '@tikuwa/core';

// フリーウェイ経理(Lite含む)の標準勘定科目コード(個人事業主版)。
// ユーザー側でコードをカスタマイズしている場合は一致しない可能性があるため、
// エクスポート結果は必ず取り込み前に確認してもらう前提。
const ACCOUNT = {
  cash: '1100', // 現金
  bankDeposit: '1120', // 普通預金
  purchases: '8110', // 当期仕入高
  salesRevenue: '8000', // 売上高
  paymentFee: '8581', // 支払手数料
  shipping: '8421', // 運賃
} as const;

interface JournalRow {
  date: string;
  debitCode: string;
  creditCode: string;
  amount: number;
  memo: string;
}

// フリーウェイ経理の日付コードは西暦年から1988を引いた通し番号+MMDD
// (平成はそのまま西暦-1988、令和もこの式で連続する。例: 2019年→31、2026年→38)。
function encodeDateCode(isoDate: string): string {
  const [yearStr, monthStr, dayStr] = isoDate.split('-');
  const code = Number(yearStr) - 1988;
  return `${String(code).padStart(2, '0')}${monthStr}${dayStr}`;
}

const MEMO_MAX_LENGTH = 32;

// 摘要欄はカンマ不可のため置換する。
function cleanMemoText(text: string): string {
  return text.replace(/,/g, '、').replace(/[\r\n]+/g, ' ');
}

// 全角32文字までの制限に収める。sanitizeMemoは単純に末尾を切るが、
// buildMemoWithSuffixは"手数料"/"送料"等のサフィックスが切れ落ちないよう
// 商品名の方を先に短くする。
function sanitizeMemo(text: string): string {
  return Array.from(cleanMemoText(text)).slice(0, MEMO_MAX_LENGTH).join('');
}

function buildMemoWithSuffix(productName: string, suffix: string): string {
  const cleanedSuffix = cleanMemoText(suffix);
  const cleanedName = Array.from(cleanMemoText(productName));
  const budget = Math.max(0, MEMO_MAX_LENGTH - cleanedSuffix.length);
  return cleanedName.slice(0, budget).join('') + cleanedSuffix;
}

function buildJournalRows(sales: SaleRecord[]): JournalRow[] {
  const rows: JournalRow[] = [];
  for (const s of sales) {
    if (s.platform === '納品金額') {
      rows.push({
        date: s.saleDate,
        debitCode: ACCOUNT.purchases,
        creditCode: ACCOUNT.cash,
        amount: s.saleAmount,
        memo: s.productName,
      });
      continue;
    }
    rows.push({
      date: s.saleDate,
      debitCode: ACCOUNT.bankDeposit,
      creditCode: ACCOUNT.salesRevenue,
      amount: s.saleAmount,
      memo: s.productName,
    });
    if (s.fee > 0) {
      rows.push({
        date: s.saleDate,
        debitCode: ACCOUNT.paymentFee,
        creditCode: ACCOUNT.bankDeposit,
        amount: s.fee,
        memo: buildMemoWithSuffix(s.productName, ' 手数料'),
      });
    }
    if (s.shippingCost > 0) {
      rows.push({
        date: s.saleDate,
        debitCode: ACCOUNT.shipping,
        creditCode: ACCOUNT.bankDeposit,
        amount: s.shippingCost,
        memo: buildMemoWithSuffix(s.productName, ' 送料'),
      });
    }
  }
  return rows;
}

function toCsvLine(row: JournalRow): string {
  const cols = [
    '0', // A 伝票番号(未使用)
    '', // B 部門コード
    '', // C 工事番号
    encodeDateCode(row.date), // D 日付
    row.debitCode, // E 借方科目コード
    '', // F 借方科目名
    '', // G 借方補助コード
    row.creditCode, // H 貸方科目コード
    '', // I 貸方科目名
    '', // J 貸方補助コード
    String(Math.round(row.amount)), // K 金額
    sanitizeMemo(row.memo), // L 摘要
    '', // M 課税区分
    '', // N 税率区分
    '', // O 資金繰り科目コード
    '0', // P 手形期日(未使用)
    '', // Q 控除区分
  ];
  return cols.join(',');
}

/** フリーウェイ経理にインポートできる仕訳データCSV(改行はCRLF)を生成する。 */
export function buildFreewayKeiriCsv(sales: SaleRecord[]): string {
  return buildJournalRows(sales)
    .map(toCsvLine)
    .map((line) => line + '\r\n')
    .join('');
}

export const FREEWAY_KEIRI_EXPORT_FILENAME = 'KAI0001-Shiwake.CSV';
