import { Html5Qrcode } from 'html5-qrcode';
import './styles.css';

interface ProductDto {
  id: number;
  name: string;
  barcode: string | null;
  category: string | null;
  unit: string;
  currentStock: number;
  targetStock: number;
  memo: string | null;
  needed: number;
  lowStock: boolean;
}

interface TransactionDto {
  id: number;
  productId: number;
  type: 'in' | 'out' | 'adjust';
  delta: number;
  resultingStock: number;
  note: string | null;
  createdAt: string;
}

type ViewName = 'list' | 'scan' | 'replenishment';

// ---- DOM helpers -----------------------------------------------------

function qs<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`要素が見つかりません: ${selector}`);
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

let toastTimer: number | undefined;
function showToast(message: string): void {
  const toast = qs<HTMLDivElement>('#toast');
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

// ---- API ---------------------------------------------------------------

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body && (body as { message?: string }).message) || `エラーが発生しました (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

const Api = {
  list: (q?: string) => api<ProductDto[]>(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  replenishment: () => api<ProductDto[]>('/api/products/replenishment'),
  byId: (id: number) => api<ProductDto>(`/api/products/${id}`),
  byBarcode: (code: string) => api<ProductDto>(`/api/products/barcode/${encodeURIComponent(code)}`),
  create: (data: Record<string, unknown>) =>
    api<ProductDto>('/api/products', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Record<string, unknown>) =>
    api<ProductDto>(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: number) => api<void>(`/api/products/${id}`, { method: 'DELETE' }),
  transactions: (id: number) => api<TransactionDto[]>(`/api/products/${id}/transactions`),
  addTransaction: (id: number, data: Record<string, unknown>) =>
    api<ProductDto>(`/api/products/${id}/transactions`, { method: 'POST', body: JSON.stringify(data) }),
};

// ---- View switching ------------------------------------------------------

const state: { view: ViewName } = { view: 'list' };

function showView(view: ViewName): void {
  const previous = state.view;
  state.view = view;

  for (const section of Array.from(document.querySelectorAll<HTMLElement>('.view'))) {
    section.hidden = section.id !== `view-${view}`;
  }
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-btn'))) {
    btn.classList.toggle('active', btn.dataset.view === view);
    if (btn.dataset.view === view) qs('#page-title').textContent = btn.dataset.title || '';
  }

  if (previous === 'scan' && view !== 'scan') void stopScanner();
  if (view === 'list') void loadProductList();
  if (view === 'replenishment') void loadReplenishmentList();
  if (view === 'scan') void startScanner();
}

// ---- Product list --------------------------------------------------------

function renderProductCard(p: ProductDto, opts: { showNeeded?: boolean } = {}): HTMLLIElement {
  const li = el('li', { class: `product-card${p.lowStock ? ' low-stock' : ''}`, 'data-id': String(p.id) });
  const info = el('div', { class: 'product-info' }, [
    el('div', { class: 'product-name' }, [p.name]),
    el('div', { class: 'product-meta' }, [[p.category, p.barcode].filter(Boolean).join(' ・ ') || '未分類']),
  ]);
  const stock = el('div', { class: 'product-stock' }, [
    el('div', { class: 'stock-num' }, [`${p.currentStock} ${p.unit}`]),
    el('div', { class: 'stock-target' }, [`目標 ${p.targetStock} ${p.unit}`]),
  ]);
  if (opts.showNeeded && p.needed > 0) {
    stock.append(el('div', { class: 'needed-badge' }, [`+${p.needed} 必要`]));
  }
  li.append(info, stock);
  li.addEventListener('click', () => void openProductDetail(p.id));
  return li;
}

async function loadProductList(query?: string): Promise<void> {
  const list = qs<HTMLUListElement>('#product-list');
  const empty = qs<HTMLParagraphElement>('#list-empty');
  try {
    const products = await Api.list(query);
    list.innerHTML = '';
    empty.hidden = products.length > 0;
    for (const p of products) list.append(renderProductCard(p));
  } catch (err) {
    showToast((err as Error).message);
  }
}

async function loadReplenishmentList(): Promise<void> {
  const list = qs<HTMLUListElement>('#replenishment-list');
  const empty = qs<HTMLParagraphElement>('#replenishment-empty');
  try {
    const products = await Api.replenishment();
    list.innerHTML = '';
    empty.hidden = products.length > 0;
    for (const p of products) list.append(renderProductCard(p, { showNeeded: true }));
  } catch (err) {
    showToast((err as Error).message);
  }
}

// ---- Modal ----------------------------------------------------------------

function openModal(contentHtml: string): HTMLDivElement {
  const backdrop = qs<HTMLDivElement>('#modal-backdrop');
  const modal = qs<HTMLDivElement>('#modal');
  modal.innerHTML = contentHtml;
  backdrop.hidden = false;
  return modal;
}

function closeModal(): void {
  qs<HTMLDivElement>('#modal-backdrop').hidden = true;
  qs<HTMLDivElement>('#modal').innerHTML = '';
}

qs<HTMLDivElement>('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

// ---- Product detail / quick stock actions ---------------------------------

function txLabel(type: TransactionDto['type']): string {
  return type === 'in' ? '入庫' : type === 'out' ? '出庫' : '調整';
}

async function openProductDetail(id: number): Promise<void> {
  try {
    const [product, txs] = await Promise.all([Api.byId(id), Api.transactions(id)]);
    renderProductDetail(product, txs);
  } catch (err) {
    showToast((err as Error).message);
  }
}

function renderProductDetail(p: ProductDto, txs: TransactionDto[]): void {
  const modal = openModal(`
    <h2>${escapeHtml(p.name)}</h2>
    <p class="product-meta">${escapeHtml([p.category, p.barcode].filter(Boolean).join(' ・ ') || '未分類')}</p>
    <div class="detail-stock-row">
      <div><span class="big">${p.currentStock}</span><span class="small">現在庫(${escapeHtml(p.unit)})</span></div>
      <div><span class="big">${p.targetStock}</span><span class="small">目標在庫</span></div>
      <div><span class="big">${p.needed}</span><span class="small">補充必要数</span></div>
    </div>
    <div class="stepper">
      <button class="btn btn-secondary" data-action="dec">−1</button>
      <div class="stepper-value" id="detail-stock-value">${p.currentStock}</div>
      <button class="btn btn-primary" data-action="inc">+1</button>
    </div>
    <div class="form-row-inline">
      <div class="form-row">
        <label for="tx-type">種別</label>
        <select id="tx-type">
          <option value="in">入庫</option>
          <option value="out">出庫</option>
          <option value="adjust">在庫数を直接設定</option>
        </select>
      </div>
      <div class="form-row">
        <label for="tx-qty">数量</label>
        <input id="tx-qty" type="number" inputmode="numeric" min="0" value="1" />
      </div>
    </div>
    <div class="form-row">
      <label for="tx-note">メモ(任意)</label>
      <input id="tx-note" type="text" placeholder="例: スーパーで購入" />
    </div>
    <button class="btn btn-primary btn-block" id="tx-submit">記録する</button>

    <ul class="tx-list">
      ${
        txs.length
          ? txs
              .map(
                (t) => `
        <li>
          <span><span class="tx-badge ${t.type}">${txLabel(t.type)}</span> ${escapeHtml(t.note || '')}</span>
          <span>${t.delta > 0 ? '+' : ''}${t.delta} → ${t.resultingStock}${escapeHtml(p.unit)} ・ ${escapeHtml(
                  t.createdAt.slice(5, 16)
                )}</span>
        </li>`
              )
              .join('')
          : '<li style="color:var(--text-muted)">履歴はまだありません</li>'
      }
    </ul>

    <div class="btn-row">
      <button class="btn btn-secondary" id="edit-btn">編集する</button>
      <button class="btn btn-danger" id="delete-btn">削除</button>
    </div>
  `);

  const stockValueEl = qs<HTMLDivElement>('#detail-stock-value', modal);

  async function applyDelta(type: 'in' | 'out', qty: number): Promise<void> {
    try {
      const updated = await Api.addTransaction(p.id, { type, quantity: qty });
      p = updated;
      stockValueEl.textContent = String(updated.currentStock);
      showToast(`${txLabel(type)}を記録しました`);
    } catch (err) {
      showToast((err as Error).message);
    }
  }

  qs<HTMLButtonElement>('[data-action="inc"]', modal).addEventListener('click', () => void applyDelta('in', 1));
  qs<HTMLButtonElement>('[data-action="dec"]', modal).addEventListener('click', () => void applyDelta('out', 1));

  qs<HTMLButtonElement>('#tx-submit', modal).addEventListener('click', () => {
    const type = qs<HTMLSelectElement>('#tx-type', modal).value as TransactionDto['type'];
    const qty = Number(qs<HTMLInputElement>('#tx-qty', modal).value);
    const note = qs<HTMLInputElement>('#tx-note', modal).value.trim();
    if (!Number.isFinite(qty) || qty < 0) return showToast('数量を正しく入力してください');
    void (async () => {
      try {
        const updated = await Api.addTransaction(p.id, { type, quantity: qty, note: note || undefined });
        showToast('記録しました');
        renderProductDetail(updated, await Api.transactions(p.id));
      } catch (err) {
        showToast((err as Error).message);
      }
    })();
  });

  qs<HTMLButtonElement>('#edit-btn', modal).addEventListener('click', () => openProductForm(p));

  qs<HTMLButtonElement>('#delete-btn', modal).addEventListener('click', () => {
    if (!window.confirm(`「${p.name}」を削除しますか?`)) return;
    void (async () => {
      try {
        await Api.remove(p.id);
        closeModal();
        showToast('削除しました');
        refreshCurrentView();
      } catch (err) {
        showToast((err as Error).message);
      }
    })();
  });
}

function refreshCurrentView(): void {
  if (state.view === 'list') void loadProductList(qs<HTMLInputElement>('#search-input').value.trim());
  if (state.view === 'replenishment') void loadReplenishmentList();
}

// ---- Add / edit product form ------------------------------------------

function openProductForm(existing?: ProductDto, prefillBarcode?: string): void {
  const isEdit = !!existing;
  const modal = openModal(`
    <h2>${isEdit ? '商品を編集' : '商品を登録'}</h2>
    <div class="form-row">
      <label for="f-name">商品名 *</label>
      <input id="f-name" type="text" value="${escapeHtml(existing?.name || '')}" />
    </div>
    <div class="form-row">
      <label for="f-barcode">バーコード</label>
      <input id="f-barcode" type="text" inputmode="numeric" value="${escapeHtml(
        existing?.barcode || prefillBarcode || ''
      )}" />
    </div>
    <div class="form-row-inline">
      <div class="form-row">
        <label for="f-category">カテゴリ</label>
        <input id="f-category" type="text" value="${escapeHtml(existing?.category || '')}" />
      </div>
      <div class="form-row">
        <label for="f-unit">単位</label>
        <input id="f-unit" type="text" value="${escapeHtml(existing?.unit || '個')}" />
      </div>
    </div>
    <div class="form-row-inline">
      ${
        isEdit
          ? ''
          : `<div class="form-row">
              <label for="f-current">現在の在庫数</label>
              <input id="f-current" type="number" inputmode="numeric" min="0" value="0" />
            </div>`
      }
      <div class="form-row">
        <label for="f-target">目標在庫数</label>
        <input id="f-target" type="number" inputmode="numeric" min="0" value="${existing?.targetStock ?? 0}" />
      </div>
    </div>
    <div class="form-row">
      <label for="f-memo">メモ</label>
      <input id="f-memo" type="text" value="${escapeHtml(existing?.memo || '')}" />
    </div>
    <button class="btn btn-primary btn-block" id="f-submit">${isEdit ? '更新する' : '登録する'}</button>
  `);

  qs<HTMLButtonElement>('#f-submit', modal).addEventListener('click', () => {
    const name = qs<HTMLInputElement>('#f-name', modal).value.trim();
    if (!name) return showToast('商品名を入力してください');
    const payload: Record<string, unknown> = {
      name,
      barcode: qs<HTMLInputElement>('#f-barcode', modal).value.trim() || null,
      category: qs<HTMLInputElement>('#f-category', modal).value.trim() || null,
      unit: qs<HTMLInputElement>('#f-unit', modal).value.trim() || '個',
      target_stock: Number(qs<HTMLInputElement>('#f-target', modal).value) || 0,
      memo: qs<HTMLInputElement>('#f-memo', modal).value.trim() || null,
    };
    if (!isEdit) {
      payload.current_stock = Number(qs<HTMLInputElement>('#f-current', modal).value) || 0;
    }
    void (async () => {
      try {
        if (isEdit && existing) await Api.update(existing.id, payload);
        else await Api.create(payload);
        closeModal();
        showToast(isEdit ? '更新しました' : '登録しました');
        refreshCurrentView();
      } catch (err) {
        showToast((err as Error).message);
      }
    })();
  });
}

// ---- Barcode scanning ----------------------------------------------------

let scanner: Html5Qrcode | null = null;
let scannerBusy = false;

async function startScanner(): Promise<void> {
  const resultPanel = qs<HTMLDivElement>('#scan-result');
  resultPanel.hidden = true;
  qs<HTMLParagraphElement>('#scan-hint').hidden = false;

  try {
    // Android Chrome等のネイティブBarcodeDetectorはOS/端末依存で無反応になることがあるため、
    // 実績のあるZXingベースのJSデコーダーに固定する。
    scanner = new Html5Qrcode('scan-reader', { useBarCodeDetectorIfSupported: false, verbose: false });
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 280, height: 180 } },
      (decodedText) => void onScanSuccess(decodedText),
      undefined
    );
  } catch (err) {
    showToast('カメラを起動できませんでした(権限・HTTPS接続を確認してください)');
    console.error(err);
  }
}

async function stopScanner(): Promise<void> {
  if (scanner) {
    try {
      if (scanner.isScanning) await scanner.stop();
      scanner.clear();
    } catch {
      /* ignore */
    }
    scanner = null;
  }
}

async function onScanSuccess(code: string): Promise<void> {
  if (scannerBusy) return;
  scannerBusy = true;
  scanner?.pause(true);

  const resultPanel = qs<HTMLDivElement>('#scan-result');
  qs<HTMLParagraphElement>('#scan-hint').hidden = true;
  resultPanel.hidden = false;

  try {
    const product = await Api.byBarcode(code);
    resultPanel.innerHTML = `
      <h3>${escapeHtml(product.name)}</h3>
      <p class="product-meta">現在庫: ${product.currentStock}${escapeHtml(product.unit)}(目標 ${
      product.targetStock
    })</p>
      <div class="btn-row">
        <button class="btn btn-primary" id="scan-in">+1 入庫</button>
        <button class="btn btn-secondary" id="scan-out">−1 出庫</button>
      </div>
      <button class="link-btn" id="scan-detail">詳細・数量指定を開く</button>
      <button class="link-btn" id="scan-resume">スキャンを再開する</button>
    `;
    qs<HTMLButtonElement>('#scan-in', resultPanel).addEventListener('click', () => void quickScanTx(product.id, 'in'));
    qs<HTMLButtonElement>('#scan-out', resultPanel).addEventListener('click', () =>
      void quickScanTx(product.id, 'out')
    );
    qs<HTMLButtonElement>('#scan-detail', resultPanel).addEventListener('click', () =>
      void openProductDetail(product.id)
    );
    qs<HTMLButtonElement>('#scan-resume', resultPanel).addEventListener('click', () => resumeScanning());
  } catch {
    resultPanel.innerHTML = `
      <p class="not-found">未登録のバーコードです: ${escapeHtml(code)}</p>
      <button class="btn btn-primary btn-block" id="scan-register">この商品を登録する</button>
      <button class="link-btn" id="scan-resume">スキャンを再開する</button>
    `;
    qs<HTMLButtonElement>('#scan-register', resultPanel).addEventListener('click', () =>
      openProductForm(undefined, code)
    );
    qs<HTMLButtonElement>('#scan-resume', resultPanel).addEventListener('click', () => resumeScanning());
  }
}

async function quickScanTx(productId: number, type: 'in' | 'out'): Promise<void> {
  try {
    const updated = await Api.addTransaction(productId, { type, quantity: 1 });
    showToast(`${txLabel(type)}: 現在 ${updated.currentStock}${updated.unit}`);
    resumeScanning();
  } catch (err) {
    showToast((err as Error).message);
  }
}

function resumeScanning(): void {
  qs<HTMLDivElement>('#scan-result').hidden = true;
  qs<HTMLParagraphElement>('#scan-hint').hidden = false;
  scannerBusy = false;
  scanner?.resume();
}

// ---- Init ------------------------------------------------------------

function init(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-btn'))) {
    btn.addEventListener('click', () => showView(btn.dataset.view as ViewName));
  }

  qs<HTMLButtonElement>('#fab-add').addEventListener('click', () => openProductForm());

  let searchTimer: number | undefined;
  qs<HTMLInputElement>('#search-input').addEventListener('input', (e) => {
    window.clearTimeout(searchTimer);
    const value = (e.target as HTMLInputElement).value.trim();
    searchTimer = window.setTimeout(() => void loadProductList(value), 250);
  });

  void loadProductList();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* オフライン利用は必須ではないため失敗しても無視する */
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
