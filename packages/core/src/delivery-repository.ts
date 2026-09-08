import type { DeliveryRecord, DeliveryStatus, NewDeliveryRecordInput, UpdateDeliveryRecordInput } from './types';
import type { NotFoundError, Result, ValidationError } from './errors';

/** 納品記録(商品名・追跡番号)の永続化ポート。 */
export interface DeliveryRepository {
  findAll(): DeliveryRecord[];
  create(input: NewDeliveryRecordInput): Result<DeliveryRecord, ValidationError>;
  update(id: number, input: UpdateDeliveryRecordInput): Result<DeliveryRecord, NotFoundError | ValidationError>;
  updateStatus(id: number, status: DeliveryStatus): Result<DeliveryRecord, NotFoundError | ValidationError>;
  remove(id: number): Result<true, NotFoundError>;
}
