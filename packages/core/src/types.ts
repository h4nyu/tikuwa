export type TransactionType = 'in' | 'out' | 'adjust';

export interface ProductBarcode {
  id: number;
  productId: number;
  barcode: string;
  /** このバーコードを1回スキャンしたときに増減する数量(例: 単体=1, 12本入り箱=12) */
  quantityPerScan: number;
  label: string | null;
  createdAt: string;
}

export interface Product {
  id: number;
  name: string;
  category: string | null;
  unit: string;
  currentStock: number;
  targetStock: number;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
  barcodes: ProductBarcode[];
}

export interface StockTransaction {
  id: number;
  productId: number;
  type: TransactionType;
  delta: number;
  resultingStock: number;
  note: string | null;
  createdAt: string;
}

export interface NewBarcodeInput {
  barcode: string;
  quantityPerScan?: number;
  label?: string | null;
}

export interface NewProductInput {
  name: string;
  category?: string | null;
  unit?: string;
  targetStock?: number;
  currentStock?: number;
  memo?: string | null;
  barcodes?: NewBarcodeInput[];
}

export interface UpdateProductInput {
  name?: string;
  category?: string | null;
  unit?: string;
  targetStock?: number;
  memo?: string | null;
}

export interface StockChangeInput {
  type: TransactionType;
  quantity: number;
  note?: string | null;
}

/** バーコード検索がマッチした商品と、実際にスキャンされたバーコードの情報 */
export interface BarcodeMatch {
  product: Product;
  matchedBarcode: ProductBarcode;
}

/** APIレスポンス用に在庫の充足状況を付加した商品情報 */
export interface ProductWithStatus extends Product {
  needed: number;
  lowStock: boolean;
}

/** 納品記録の進捗状態。発注してから手元に届くまでの4段階。 */
export const DELIVERY_STATUSES = ['発注済み', '上海到着', '国際発送', '到着済み'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** 発注した荷物が届いた際に、商品名と追跡番号を記録するための納品記録 */
export interface DeliveryRecord {
  id: number;
  productName: string;
  trackingNumber: string;
  carrier: string | null;
  status: DeliveryStatus;
  createdAt: string;
}

export interface NewDeliveryRecordInput {
  productName: string;
  trackingNumber: string;
  carrier?: string | null;
}

export interface UpdateDeliveryRecordInput {
  productName?: string;
  trackingNumber?: string;
  carrier?: string | null;
}
