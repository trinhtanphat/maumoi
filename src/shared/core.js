export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(`${code}: ${message}`);
    this.name = 'DomainError';
    this.code = code;
    this.publicMessage = message;
    this.status = status;
  }
}

export function normalizeVnPhone(input) {
  const raw = String(input ?? '').trim().replace(/[\s().-]/g, '');
  let digits = raw.startsWith('+') ? raw.slice(1) : raw;
  if (digits.startsWith('0')) digits = `84${digits.slice(1)}`;
  if (!/^84(3|5|7|8|9)\d{8}$/.test(digits)) {
    throw new DomainError('VALIDATION_ERROR', 'Số điện thoại Việt Nam không hợp lệ.');
  }
  return digits;
}

export function maskPhone(phone) {
  const value = String(phone ?? '');
  if (value.length < 8) return '***';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function asInt(value, field = 'quantity') {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new DomainError('VALIDATION_ERROR', `${field} phải là số nguyên.`);
  return n;
}

export function positiveInt(value, field = 'quantity') {
  const n = asInt(value, field);
  if (n <= 0) throw new DomainError('VALIDATION_ERROR', `${field} phải lớn hơn 0.`);
  return n;
}

export function nonNegativeInt(value, field = 'quantity') {
  const n = asInt(value, field);
  if (n < 0) throw new DomainError('VALIDATION_ERROR', `${field} không được âm.`);
  return n;
}

export function inventoryAvailable({ allocated = 0, adjustments = 0, distributed = 0 }) {
  return Number(allocated) + Number(adjustments) - Number(distributed);
}

export function reconciliationVariance({ assigned = 0, distributed = 0, returned = 0, damaged = 0, closing = 0 }) {
  return Number(assigned) - Number(distributed) - Number(returned) - Number(damaged) - Number(closing);
}

export function validateIdempotencyKey(input) {
  const value = String(input ?? '').trim();
  if (!/^[A-Za-z0-9:_-]{12,128}$/.test(value)) {
    throw new DomainError('VALIDATION_ERROR', 'Idempotency-Key không hợp lệ.');
  }
  return value;
}

export function newId(prefix = '') {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return prefix ? `${prefix}_${hex}` : hex;
}

export function randomDigits(length = 6) {
  const max = 10 ** length;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % max).padStart(length, '0');
}

export function nowIso() {
  return new Date().toISOString();
}

export function businessDateVn(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

export function parseJsonBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('VALIDATION_ERROR', 'JSON body không hợp lệ.');
  }
  return value;
}

export function requiredString(value, field, max = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new DomainError('VALIDATION_ERROR', `${field} không hợp lệ.`);
  return text;
}

export function optionalString(value, max = 500) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (text.length > max) throw new DomainError('VALIDATION_ERROR', 'Chuỗi quá dài.');
  return text;
}

function formulaSafe(value) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = formulaSafe(value).replace(/"/g, '""');
  return /[",\r\n]/.test(text) ? `"${text}"` : text;
}

export function toCsv(rows, columns) {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(','));
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''));
      if (row.some((v) => v !== '')) rows.push(row);
      row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new DomainError('VALIDATION_ERROR', 'CSV có dấu ngoặc kép chưa đóng.');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); if (row.some((v) => v !== '')) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((h) => h.trim());
  if (new Set(headers).size !== headers.length || headers.some((h) => !h)) {
    throw new DomainError('VALIDATION_ERROR', 'CSV header không hợp lệ.');
  }
  return rows.map((values, rowIndex) => {
    if (values.length !== headers.length) throw new DomainError('VALIDATION_ERROR', `CSV dòng ${rowIndex + 2} sai số cột.`);
    return Object.fromEntries(headers.map((h, i) => [h, values[i].trim()]));
  });
}
