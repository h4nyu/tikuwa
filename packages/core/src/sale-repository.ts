import type { NewSaleRecordInput, SaleRecord, UpdateSaleRecordInput } from './types';
import type { NotFoundError, Result, ValidationError } from './errors';

/** 売上記録(確定申告の記帳データの元)の永続化ポート。 */
export interface SaleRepository {
  findAll(): SaleRecord[];
  create(input: NewSaleRecordInput): Result<SaleRecord, ValidationError>;
  update(id: number, input: UpdateSaleRecordInput): Result<SaleRecord, NotFoundError | ValidationError>;
  remove(id: number): Result<true, NotFoundError>;
}
