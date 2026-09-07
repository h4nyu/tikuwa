export class NotFoundError extends Error {
  readonly kind = 'not_found' as const;
  constructor(message = '対象が見つかりません') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class DuplicateBarcodeError extends Error {
  readonly kind = 'duplicate_barcode' as const;
  constructor(message = 'このバーコードは既に登録されています') {
    super(message);
    this.name = 'DuplicateBarcodeError';
  }
}

export class ValidationError extends Error {
  readonly kind = 'validation' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 成功時はT、失敗時はErrorサブクラスを返す(instanceofで判別する) */
export type Result<T, E extends Error = Error> = T | E;
