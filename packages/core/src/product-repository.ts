import type {
  NewProductInput,
  Product,
  StockChangeInput,
  StockTransaction,
  UpdateProductInput,
} from './types';
import type { DuplicateBarcodeError, NotFoundError, Result, ValidationError } from './errors';

/** 商品と在庫の永続化ポート。実装はアダプタ(例: @tikuwa/db)側が持つ。 */
export interface ProductRepository {
  findAll(query?: string): Product[];
  findById(id: number): Result<Product, NotFoundError>;
  findByBarcode(barcode: string): Result<Product, NotFoundError>;
  findReplenishmentNeeded(): Product[];
  create(input: NewProductInput): Result<Product, ValidationError | DuplicateBarcodeError>;
  update(id: number, input: UpdateProductInput): Result<Product, NotFoundError | DuplicateBarcodeError>;
  remove(id: number): Result<true, NotFoundError>;
  listTransactions(productId: number): StockTransaction[];
  recordTransaction(
    productId: number,
    input: StockChangeInput
  ): Result<Product, NotFoundError | ValidationError>;
}
