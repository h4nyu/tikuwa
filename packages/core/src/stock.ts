import type { TransactionType } from './types';

/** 入出庫種別と数量から在庫増減(delta)を計算する。adjustは絶対値指定。 */
export function computeDelta(type: TransactionType, quantity: number, currentStock: number): number {
  if (type === 'in') return quantity;
  if (type === 'out') return -quantity;
  return quantity - currentStock;
}

export function isLowStock(currentStock: number, targetStock: number): boolean {
  return currentStock < targetStock;
}

export function neededQuantity(currentStock: number, targetStock: number): number {
  return Math.max(targetStock - currentStock, 0);
}
