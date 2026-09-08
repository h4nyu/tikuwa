import { Html5Qrcode } from 'html5-qrcode';
import './styles.css';

interface ProductBarcodeDto {
  id: number;
  productId: number;
  barcode: string;
  quantityPerScan: number;
  label: string | null;
}

interface ProductDto {
  id: number;
  name: string;
  category: string | null;
  unit: string;
  currentStock: number;
  targetStock: number;
  memo: string | null;
  needed: number;
  lowStock: boolean;
  barcodes: ProductBarcodeDto[];
}

interface BarcodeMatchDto extends ProductDto {
  matchedBarcode: ProductBarcodeDto;
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

function productMetaLine(p: ProductDto): string {
  const barcodeNote = p.barcodes.length ? `バーコード${p.barcodes.length}件` : null;
  return [p.category, barcodeNote].filter(Boolean).join(' ・ ') || '未分類';
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
  byBarcode: (code: string) => api<BarcodeMatchDto>(`/api/products/barcode/${encodeURIComponent(code)}`),
  create: (data: Record<string, unknown>) =>
    api<ProductDto>('/api/products', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Record<string, unknown>) =>
    api<ProductDto>(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: number) => api<void>(`/api/products/${id}`, { method: 'DELETE' }),
  transactions: (id: number) => api<TransactionDto[]>(`/api/products/${id}/transactions`),
  addTransaction: (id: number, data: Record<string, unknown>) =>
    api<ProductDto>(`/api/products/${id}/transactions`, { method: 'POST', body: JSON.stringify(data) }),
  addBarcode: (productId: number, data: Record<string, unknown>) =>
    api<ProductBarcodeDto>(`/api/products/${productId}/barcodes`, { method: 'POST', body: JSON.stringify(data) }),
  removeBarcode: (productId: number, barcodeId: number) =>
    api<void>(`/api/products/${productId}/barcodes/${barcodeId}`, { method: 'DELETE' }),
};

// ---- View switching ------------------------------------------------------

type ReplenishmentSort = 'needed-desc' | 'needed-asc' | 'name' | 'category' | 'stock-asc';

const state: {
  view: ViewName;
  category: string | null;
  replenishmentCategory: string | null;
  replenishmentSort: ReplenishmentSort;
} = {
  view: 'list',
  category: null,
  replenishmentCategory: null,
  replenishmentSort: 'needed-desc',
};
let knownCategories: string[] = [];

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
  if (view === 'list') {
    void refreshListCategoryChips();
    void loadProductList();
  }
  if (view === 'replenishment') {
    void refreshReplenishmentCategoryChips();
    void loadReplenishmentList();
  }
  if (view === 'scan') void startScanner();
}

// ---- Category filter chips -------------------------------------------------

async function fetchKnownCategories(): Promise<string[]> {
  try {
    const all = await Api.list();
    const set = new Set<string>();
    for (const p of all) if (p.category) set.add(p.category);
    knownCategories = Array.from(set).sort((a, b) => a.localeCompare(b, 'ja'));
  } catch {
    /* 取得に失敗しても既存のチップ表示は維持する */
  }
  return knownCategories;
}

interface CategoryChipController {
  containerId: string;
  getSelected: () => string | null;
  setSelected: (cat: string | null) => void;
  onChange: () => void;
}

function renderCategoryChips(ctl: CategoryChipController): void {
  const bar = qs<HTMLDivElement>(`#${ctl.containerId}`);
  bar.innerHTML = '';
  if (!knownCategories.length) return;

  const selectCategory = (cat: string | null): void => {
    ctl.setSelected(ctl.getSelected() === cat ? null : cat);
    renderCategoryChips(ctl);
    ctl.onChange();
  };

  const allChip = el('button', { class: `chip${ctl.getSelected() === null ? ' active' : ''}`, type: 'button' }, [
    'すべて',
  ]);
  allChip.addEventListener('click', () => selectCategory(null));
  bar.append(allChip);

  for (const cat of knownCategories) {
    const chip = el('button', { class: `chip${ctl.getSelected() === cat ? ' active' : ''}`, type: 'button' }, [cat]);
    chip.addEventListener('click', () => selectCategory(cat));
    bar.append(chip);
  }
}

async function refreshListCategoryChips(): Promise<void> {
  await fetchKnownCategories();
  if (state.category && !knownCategories.includes(state.category)) state.category = null;
  renderCategoryChips({
    containerId: 'category-filter',
    getSelected: () => state.category,
    setSelected: (cat) => (state.category = cat),
    onChange: () => void loadProductList(qs<HTMLInputElement>('#search-input').value.trim()),
  });
}

async function refreshReplenishmentCategoryChips(): Promise<void> {
  await fetchKnownCategories();
  if (state.replenishmentCategory && !knownCategories.includes(state.replenishmentCategory)) {
    state.replenishmentCategory = null;
  }
  renderCategoryChips({
    containerId: 'category-filter-replenishment',
    getSelected: () => state.replenishmentCategory,
    setSelected: (cat) => (state.replenishmentCategory = cat),
    onChange: () => void loadReplenishmentList(),
  });
}

// ---- Product list --------------------------------------------------------

function renderProductCard(p: ProductDto, opts: { showNeeded?: boolean } = {}): HTMLLIElement {
  const li = el('li', { class: `product-card${p.lowStock ? ' low-stock' : ''}`, 'data-id': String(p.id) });
  const metaRow = el('div', { class: 'product-meta-row' });
  if (p.category) metaRow.append(el('span', { class: 'category-badge' }, [p.category]));
  if (p.barcodes.length) {
    metaRow.append(el('span', { class: 'product-meta' }, [`バーコード${p.barcodes.length}件`]));
  }
  const info = el('div', { class: 'product-info' }, [el('div', { class: 'product-name' }, [p.name]), metaRow]);
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
    let products = await Api.list(query);
    if (state.category) products = products.filter((p) => p.category === state.category);
    list.innerHTML = '';
    empty.hidden = products.length > 0;
    for (const p of products) list.append(renderProductCard(p));
  } catch (err) {
    showToast((err as Error).message);
  }
}

let currentReplenishmentProducts: ProductDto[] = [];

function sortReplenishmentProducts(products: ProductDto[], sort: ReplenishmentSort): ProductDto[] {
  const sorted = [...products];
  switch (sort) {
    case 'needed-asc':
      sorted.sort((a, b) => a.needed - b.needed);
      break;
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      break;
    case 'category':
      sorted.sort(
        (a, b) => (a.category ?? '').localeCompare(b.category ?? '', 'ja') || a.name.localeCompare(b.name, 'ja')
      );
      break;
    case 'stock-asc':
      sorted.sort((a, b) => a.currentStock - b.currentStock);
      break;
    case 'needed-desc':
    default:
      sorted.sort((a, b) => b.needed - a.needed);
      break;
  }
  return sorted;
}

async function loadReplenishmentList(): Promise<void> {
  const list = qs<HTMLUListElement>('#replenishment-list');
  const empty = qs<HTMLParagraphElement>('#replenishment-empty');
  try {
    let products = await Api.replenishment();
    if (state.replenishmentCategory) {
      products = products.filter((p) => p.category === state.replenishmentCategory);
    }
    products = sortReplenishmentProducts(products, state.replenishmentSort);
    currentReplenishmentProducts = products;
    list.innerHTML = '';
    empty.hidden = products.length > 0;
    for (const p of products) list.append(renderProductCard(p, { showNeeded: true }));
  } catch (err) {
    showToast((err as Error).message);
  }
}

function toCsvField(value: string | number): string {
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function exportReplenishmentCsv(): void {
  if (!currentReplenishmentProducts.length) {
    showToast('補充が必要な商品はありません');
    return;
  }
  const header = ['商品名', 'カテゴリ', '現在庫', '目標在庫', '不足数', '単位'];
  const rows = currentReplenishmentProducts.map((p) => [
    p.name,
    p.category ?? '',
    p.currentStock,
    p.targetStock,
    p.needed,
    p.unit,
  ]);
  const csv = [header, ...rows].map((row) => row.map(toCsvField).join(',')).join('\r\n');
  // ExcelがUTF-8と正しく認識できるようBOMを付与する
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `補充リスト_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- Modal ----------------------------------------------------------------

function openModal(contentHtml: string): HTMLDivElement {
  const backdrop = qs<HTMLDivElement>('#modal-backdrop');
  const modal = qs<HTMLDivElement>('#modal');
  qs<HTMLDivElement>('#modal-content').innerHTML = contentHtml;
  backdrop.hidden = false;
  return modal;
}

function closeModal(): void {
  qs<HTMLDivElement>('#modal-backdrop').hidden = true;
  qs<HTMLDivElement>('#modal-content').innerHTML = '';
  const resume = resumeScanningOnModalClose;
  resumeScanningOnModalClose = null;
  resume?.();
}

qs<HTMLDivElement>('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});
qs<HTMLButtonElement>('#modal-close-btn').addEventListener('click', () => closeModal());

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

function barcodeListHtml(p: ProductDto): string {
  if (!p.barcodes.length) {
    return '<li style="color:var(--text-muted)">バーコード未登録</li>';
  }
  return p.barcodes
    .map(
      (b) => `
    <li>
      <span>${escapeHtml(b.barcode)}${b.label ? ' ・ ' + escapeHtml(b.label) : ''}</span>
      <span>×${b.quantityPerScan} <button class="link-btn" data-remove-barcode="${b.id}">削除</button></span>
    </li>`
    )
    .join('');
}

function renderProductDetail(p: ProductDto, txs: TransactionDto[]): void {
  const modal = openModal(`
    <h2>${escapeHtml(p.name)}</h2>
    <p class="product-meta">${escapeHtml(productMetaLine(p))}</p>
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
          <span>${t.delta > 0 ? '+' : ''}${t.delta} → ${t.resultingStock} ${escapeHtml(p.unit)} ・ ${escapeHtml(
                  t.createdAt.slice(5, 16)
                )}</span>
        </li>`
              )
              .join('')
          : '<li style="color:var(--text-muted)">履歴はまだありません</li>'
      }
    </ul>

    <div class="section-desc" style="margin-top:18px;">バーコード</div>
    <ul class="tx-list" id="barcode-list">${barcodeListHtml(p)}</ul>
    <div class="form-row-inline">
      <div class="field-with-scan">
        <div class="form-row">
          <label for="new-barcode">コード</label>
          <input id="new-barcode" type="text" inputmode="numeric" placeholder="例: 4901234567890" />
        </div>
        <button type="button" class="field-scan-btn" id="new-barcode-scan-btn" aria-label="カメラで読み取る">📷</button>
      </div>
      <div class="form-row" style="flex:0 0 80px;">
        <label for="new-barcode-qty">数量</label>
        <input id="new-barcode-qty" type="number" inputmode="numeric" min="1" value="1" />
      </div>
    </div>
    <div class="form-row">
      <label for="new-barcode-label">ラベル(任意)</label>
      <input id="new-barcode-label" type="text" placeholder="例: 12本入り箱" />
    </div>
    <button class="btn btn-secondary btn-block" id="add-barcode-btn">バーコードを追加</button>

    <div class="btn-row" style="margin-top:18px;">
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

  qs<HTMLButtonElement>('#new-barcode-scan-btn', modal).addEventListener('click', () => {
    scanBarcodeInto(qs<HTMLInputElement>('#new-barcode', modal), () => {
      // 既存商品にバーコードを追加するだけの操作なので、読み取れたらそのまま登録まで進める。
      qs<HTMLButtonElement>('#add-barcode-btn', modal).click();
    });
  });

  qs<HTMLButtonElement>('#add-barcode-btn', modal).addEventListener('click', () => {
    const barcode = qs<HTMLInputElement>('#new-barcode', modal).value.trim();
    const qty = Number(qs<HTMLInputElement>('#new-barcode-qty', modal).value) || 1;
    const label = qs<HTMLInputElement>('#new-barcode-label', modal).value.trim() || null;
    if (!barcode) return showToast('バーコードを入力してください');
    void (async () => {
      try {
        await Api.addBarcode(p.id, { barcode, quantity_per_scan: qty, label });
        await Api.addTransaction(p.id, { type: 'in', quantity: qty, note: label || 'バーコード登録' });
        showToast(`バーコードを追加し、${qty}を在庫に反映しました`);
        renderProductDetail(await Api.byId(p.id), await Api.transactions(p.id));
      } catch (err) {
        showToast((err as Error).message);
      }
    })();
  });

  for (const btn of Array.from(modal.querySelectorAll<HTMLButtonElement>('[data-remove-barcode]'))) {
    btn.addEventListener('click', () => {
      const barcodeId = Number(btn.dataset.removeBarcode);
      void (async () => {
        try {
          await Api.removeBarcode(p.id, barcodeId);
          showToast('バーコードを削除しました');
          renderProductDetail(await Api.byId(p.id), txs);
        } catch (err) {
          showToast((err as Error).message);
        }
      })();
    });
  }

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
  if (state.view === 'list') {
    void refreshListCategoryChips();
    void loadProductList(qs<HTMLInputElement>('#search-input').value.trim());
  }
  if (state.view === 'replenishment') {
    void refreshReplenishmentCategoryChips();
    void loadReplenishmentList();
  }
}

// ---- Add / edit product form ------------------------------------------

function addBarcodeRow(container: HTMLElement, barcode = '', qty = 1): void {
  const row = el('div', { class: 'form-row-inline barcode-row' });
  row.innerHTML = `
    <div class="field-with-scan">
      <div class="form-row"><label>バーコード</label><input class="br-code" type="text" inputmode="numeric" value="${escapeHtml(
        barcode
      )}" /></div>
      <button type="button" class="field-scan-btn br-scan" aria-label="カメラで読み取る">📷</button>
    </div>
    <div class="form-row" style="flex:0 0 80px;"><label>数量</label><input class="br-qty" type="number" inputmode="numeric" min="1" value="${qty}" /></div>
  `;
  const scanBtn = row.querySelector<HTMLButtonElement>('.br-scan')!;
  scanBtn.addEventListener('click', () => scanBarcodeInto(row.querySelector<HTMLInputElement>('.br-code')!));

  const removeBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, ['×']);
  removeBtn.style.flex = '0 0 auto';
  removeBtn.style.alignSelf = 'flex-end';
  removeBtn.style.marginBottom = '12px';
  removeBtn.addEventListener('click', () => row.remove());
  row.append(removeBtn);
  container.append(row);
}

function collectBarcodeRows(container: HTMLElement): { barcode: string; quantity_per_scan: number }[] {
  return Array.from(container.querySelectorAll<HTMLDivElement>('.barcode-row'))
    .map((row) => ({
      barcode: row.querySelector<HTMLInputElement>('.br-code')!.value.trim(),
      quantity_per_scan: Number(row.querySelector<HTMLInputElement>('.br-qty')!.value) || 1,
    }))
    .filter((b) => b.barcode);
}

function openProductForm(existing?: ProductDto, prefillBarcode?: string): void {
  const isEdit = !!existing;
  const modal = openModal(`
    <h2>${isEdit ? '商品を編集' : '商品を登録'}</h2>
    ${
      prefillBarcode
        ? `<button type="button" class="link-btn" id="switch-to-attach">
             登録済みの商品に、このバーコードを追加する場合はこちら
           </button>`
        : ''
    }
    <div class="form-row">
      <label for="f-name">商品名 *</label>
      <input id="f-name" type="text" value="${escapeHtml(existing?.name || '')}" />
    </div>
    <div class="form-row-inline">
      <div class="form-row" style="position: relative;">
        <label for="f-category">カテゴリ</label>
        <input id="f-category" type="text" autocomplete="off" value="${escapeHtml(existing?.category || '')}" />
        <div id="category-suggestions" class="suggestion-list" hidden></div>
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
    ${
      isEdit
        ? '<p class="section-desc">バーコードの追加・削除は詳細画面から行えます。</p>'
        : `<div class="form-row">
            <label>バーコード(任意・複数可)</label>
            <div id="barcode-rows"></div>
            <button type="button" class="btn btn-secondary" id="add-barcode-row">+ バーコードを追加</button>
          </div>`
    }
    <button class="btn btn-primary btn-block" id="f-submit">${isEdit ? '更新する' : '登録する'}</button>
  `);

  if (!isEdit) {
    const rows = qs<HTMLDivElement>('#barcode-rows', modal);
    addBarcodeRow(rows, prefillBarcode || '', 1);
    qs<HTMLButtonElement>('#add-barcode-row', modal).addEventListener('click', () => addBarcodeRow(rows));
  }

  if (prefillBarcode) {
    modal.querySelector<HTMLButtonElement>('#switch-to-attach')?.addEventListener('click', () => {
      openAttachBarcodeFlow(prefillBarcode);
    });
  }

  void fetchKnownCategories();
  const categoryInput = qs<HTMLInputElement>('#f-category', modal);
  const suggestionBox = qs<HTMLDivElement>('#category-suggestions', modal);

  function renderCategorySuggestions(): void {
    const query = categoryInput.value.trim().toLowerCase();
    const matches = knownCategories.filter((c) => c.toLowerCase() !== query && (!query || c.toLowerCase().includes(query)));
    suggestionBox.innerHTML = '';
    if (!matches.length) {
      suggestionBox.hidden = true;
      return;
    }
    for (const cat of matches) {
      const item = el('div', { class: 'suggestion-item' }, [cat]);
      item.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        categoryInput.value = cat;
        suggestionBox.hidden = true;
      });
      suggestionBox.append(item);
    }
    suggestionBox.hidden = false;
  }

  categoryInput.addEventListener('focus', renderCategorySuggestions);
  categoryInput.addEventListener('input', renderCategorySuggestions);
  categoryInput.addEventListener('blur', () => {
    window.setTimeout(() => (suggestionBox.hidden = true), 150);
  });

  qs<HTMLButtonElement>('#f-submit', modal).addEventListener('click', () => {
    const name = qs<HTMLInputElement>('#f-name', modal).value.trim();
    if (!name) return showToast('商品名を入力してください');
    const payload: Record<string, unknown> = {
      name,
      category: qs<HTMLInputElement>('#f-category', modal).value.trim() || null,
      unit: qs<HTMLInputElement>('#f-unit', modal).value.trim() || '個',
      target_stock: Number(qs<HTMLInputElement>('#f-target', modal).value) || 0,
      memo: qs<HTMLInputElement>('#f-memo', modal).value.trim() || null,
    };
    if (!isEdit) {
      payload.current_stock = Number(qs<HTMLInputElement>('#f-current', modal).value) || 0;
      payload.barcodes = collectBarcodeRows(qs<HTMLDivElement>('#barcode-rows', modal));
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

// ---- Attach an existing barcode to an already-registered product ----------

function openAttachBarcodeFlow(code: string): void {
  const modal = openModal(`
    <h2>既存の商品にバーコードを追加</h2>
    <p class="product-meta">バーコード: ${escapeHtml(code)}</p>
    <div class="form-row">
      <label for="attach-search">商品を検索</label>
      <input id="attach-search" type="search" placeholder="商品名で検索" autocomplete="off" />
    </div>
    <ul id="attach-product-list" class="product-list"></ul>
  `);

  const listEl = qs<HTMLUListElement>('#attach-product-list', modal);

  async function search(q: string): Promise<void> {
    try {
      const products = await Api.list(q);
      listEl.innerHTML = '';
      for (const p of products) {
        const li = el('li', { class: 'product-card' }, [
          el('div', { class: 'product-info' }, [
            el('div', { class: 'product-name' }, [p.name]),
            el('div', { class: 'product-meta' }, [`現在庫 ${p.currentStock} ${p.unit}`]),
          ]),
        ]);
        li.addEventListener('click', () => openAttachBarcodeQuantityStep(code, p));
        listEl.append(li);
      }
    } catch (err) {
      showToast((err as Error).message);
    }
  }

  let timer: number | undefined;
  qs<HTMLInputElement>('#attach-search', modal).addEventListener('input', (e) => {
    window.clearTimeout(timer);
    const value = (e.target as HTMLInputElement).value.trim();
    timer = window.setTimeout(() => void search(value), 200);
  });

  void search('');
}

function openAttachBarcodeQuantityStep(code: string, product: ProductDto): void {
  const modal = openModal(`
    <h2>${escapeHtml(product.name)} にバーコードを追加</h2>
    <p class="product-meta">バーコード: ${escapeHtml(code)}</p>
    <div class="form-row-inline">
      <div class="form-row">
        <label for="attach-qty">1回のスキャンで増える数量</label>
        <input id="attach-qty" type="number" inputmode="numeric" min="1" value="1" />
      </div>
    </div>
    <div class="form-row">
      <label for="attach-label">ラベル(任意)</label>
      <input id="attach-label" type="text" placeholder="例: 12本入り箱" />
    </div>
    <button class="btn btn-primary btn-block" id="attach-submit">このバーコードを追加する</button>
  `);

  qs<HTMLButtonElement>('#attach-submit', modal).addEventListener('click', () => {
    const qty = Number(qs<HTMLInputElement>('#attach-qty', modal).value) || 1;
    const label = qs<HTMLInputElement>('#attach-label', modal).value.trim() || null;
    void (async () => {
      try {
        await Api.addBarcode(product.id, { barcode: code, quantity_per_scan: qty, label });
        await Api.addTransaction(product.id, { type: 'in', quantity: qty, note: label || 'バーコード登録' });
        closeModal();
        showToast(`「${product.name}」に${qty}を追加しました`);
      } catch (err) {
        showToast((err as Error).message);
      }
    })();
  });
}

// ---- Barcode scanning ----------------------------------------------------

let scanner: Html5Qrcode | null = null;
let scannerBusy = false;

/**
 * フォーム内のバーコード入力欄に、カメラで読み取った値をその場で入力するための
 * 使い切りスキャナー。スキャンタブの常駐スキャナーとは別インスタンスとして
 * フルスクリーンのオーバーレイ上で動かす。
 */
function scanBarcodeInto(targetInput: HTMLInputElement, onScanned?: () => void): void {
  const overlay = el('div', { class: 'scan-overlay' });
  const readerDiv = el('div', { id: 'inline-scan-reader', class: 'scan-reader' });
  const hint = el('p', { class: 'scan-hint' }, ['バーコードをカメラに写してください']);
  const cancelBtn = el('button', { class: 'btn btn-secondary btn-block', type: 'button' }, ['キャンセル']);
  overlay.append(readerDiv, hint, cancelBtn);
  document.body.append(overlay);

  let tempScanner: Html5Qrcode | null = null;
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    overlay.remove();
    void (async () => {
      if (!tempScanner) return;
      try {
        if (tempScanner.isScanning) await tempScanner.stop();
        tempScanner.clear();
      } catch {
        /* ignore */
      }
    })();
  };

  cancelBtn.addEventListener('click', cleanup);

  void (async () => {
    try {
      tempScanner = new Html5Qrcode('inline-scan-reader', { useBarCodeDetectorIfSupported: false, verbose: false });
      await tempScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 260, height: 160 } },
        (decodedText) => {
          targetInput.value = decodedText;
          targetInput.dispatchEvent(new Event('input', { bubbles: true }));
          cleanup();
          onScanned?.();
        },
        undefined
      );
    } catch (err) {
      showToast('カメラを起動できませんでした(権限・HTTPS接続を確認してください)');
      console.error(err);
      cleanup();
    }
  })();
}

async function startScanner(): Promise<void> {
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

// スキャンで開いたモーダルを閉じたときにスキャンを再開するためのコールバック。
// openProductDetail/openProductForm は他の画面からも使われるため、
// スキャン起点のときだけこれを一度だけセットしておく。
let resumeScanningOnModalClose: (() => void) | null = null;

async function onScanSuccess(code: string): Promise<void> {
  if (scannerBusy) return;
  scannerBusy = true;
  try {
    scanner?.pause(true);
  } catch {
    /* カメラが起動していない(手動入力のみ利用中)場合など、スキャン中でなければ無視する */
  }
  qs<HTMLParagraphElement>('#scan-hint').hidden = true;

  resumeScanningOnModalClose = resumeScanning;
  try {
    const match = await Api.byBarcode(code);
    void openProductDetail(match.id);
  } catch {
    openProductForm(undefined, code);
  }
}

function resumeScanning(): void {
  qs<HTMLParagraphElement>('#scan-hint').hidden = false;
  scannerBusy = false;
  try {
    scanner?.resume();
  } catch {
    /* カメラが起動していない(手動入力のみ利用中)場合など、一時停止中でなければ無視する */
  }
}

// カメラでの読み取りがうまくいかない場合(端末の不具合・破損したバーコード等)の手動入力。
// カメラが起動していない場合でも使えるフォールバックになる。
function openManualBarcodeEntry(): void {
  const modal = openModal(`
    <h2>バーコードを手動入力</h2>
    <div class="form-row">
      <label for="manual-barcode-input">バーコード番号</label>
      <input id="manual-barcode-input" type="text" inputmode="numeric" autocomplete="off" placeholder="例: 4901234567890" />
    </div>
    <button class="btn btn-primary btn-block" id="manual-barcode-submit">検索する</button>
  `);

  const input = qs<HTMLInputElement>('#manual-barcode-input', modal);
  input.focus();

  const submit = (): void => {
    const code = input.value.trim();
    if (!code) {
      showToast('バーコードを入力してください');
      return;
    }
    void onScanSuccess(code);
  };

  qs<HTMLButtonElement>('#manual-barcode-submit', modal).addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

// ---- Init ------------------------------------------------------------

function init(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-btn'))) {
    btn.addEventListener('click', () => showView(btn.dataset.view as ViewName));
  }

  qs<HTMLButtonElement>('#fab-add').addEventListener('click', () => openProductForm());
  qs<HTMLButtonElement>('#manual-barcode-btn').addEventListener('click', () => openManualBarcodeEntry());
  qs<HTMLButtonElement>('#export-replenishment-csv').addEventListener('click', () => exportReplenishmentCsv());

  function spinIcon(btn: HTMLButtonElement): void {
    btn.classList.remove('spinning');
    void btn.offsetWidth; // reflow to restart the animation on repeated clicks
    btn.classList.add('spinning');
  }

  qs<HTMLButtonElement>('#refresh-list').addEventListener('click', (e) => {
    spinIcon(e.currentTarget as HTMLButtonElement);
    void refreshListCategoryChips();
    void loadProductList(qs<HTMLInputElement>('#search-input').value.trim());
  });

  qs<HTMLButtonElement>('#refresh-replenishment').addEventListener('click', (e) => {
    spinIcon(e.currentTarget as HTMLButtonElement);
    void refreshReplenishmentCategoryChips();
    void loadReplenishmentList();
  });

  qs<HTMLSelectElement>('#replenishment-sort').addEventListener('change', (e) => {
    state.replenishmentSort = (e.target as HTMLSelectElement).value as ReplenishmentSort;
    void loadReplenishmentList();
  });

  let searchTimer: number | undefined;
  qs<HTMLInputElement>('#search-input').addEventListener('input', (e) => {
    window.clearTimeout(searchTimer);
    const value = (e.target as HTMLInputElement).value.trim();
    searchTimer = window.setTimeout(() => void loadProductList(value), 250);
  });

  void refreshListCategoryChips();
  void loadProductList();

  // Service Workerを登録しているとiOSでホーム画面追加(standalone)時に
  // カメラ映像が真っ黒になる既知のWebKit不具合があるため、登録しない。
  // 既にインストール済みの端末は既存の登録を解除して復旧させる。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) reg.unregister();
    }).catch(() => {
      /* ignore */
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
