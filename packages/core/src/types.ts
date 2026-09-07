export type TransactionType = 'in' | 'out' | 'adjust';

export interface Product {
  id: number;
  name: string;
  barcode: string | null;
  category: string | null;
  unit: string;
  currentStock: number;
  targetStock: number;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface NewProductInput {
  name: string;
  barcode?: string | null;
  category?: string | null;
  unit?: string;
  targetStock?: number;
  currentStock?: number;
  memo?: string | null;
}

export interface UpdateProductInput {
  name?: string;
  barcode?: string | null;
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

/** APIレスポンス用に在庫の充足状況を付加した商品情報 */
export interface ProductWithStatus extends Product {
  needed: number;
  lowStock: boolean;
}
