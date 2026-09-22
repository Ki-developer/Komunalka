/**
 * Комуналка — серверная часть (Google Apps Script).
 *
 * Сервер хранит ТОЛЬКО зашифрованные данные. Пароль сюда не передаётся:
 * шифрование и расшифровка (AES-256-GCM, ключ защищён паролем через PBKDF2)
 * происходят на телефоне/компьютере, в самом приложении.
 *
 * Листы:
 *   «Данные (зашифровано)» — по строке на месяц + настройки;
 *   «Файлы (зашифровано)»  — фото и PDF квитанций, частями по 45 000 знаков;
 *   «Ключ»                 — соль и зашифрованный ключ данных.
 *
 * @OnlyCurrentDoc
 */

var DATA_SHEET = 'Данные (зашифровано)';
var FILES_SHEET = 'Файлы (зашифровано)';
var META_SHEET = 'Ключ';

// Иконка во вкладке браузера. Google принимает только публичную ссылку на .png
// (картинку внутри Index.html он игнорирует). Можно заменить на свою ссылку .png
// или оставить пустой строкой, чтобы вернуть стандартную иконку.
var FAVICON_URL = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f3e0.png';

function doGet() {
  var out = HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Комуналка')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  if (FAVICON_URL) {
    try {
      out.setFaviconUrl(FAVICON_URL);
    } catch (e) {
      // ссылка не подошла — остаётся стандартная иконка, приложение работает дальше
    }
  }
  return out;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Комуналка')
    .addItem('Снять блокировку входа', 'unlockLogin')
    .addItem('Удалить все данные (если забыт пароль)', 'resetAllData')
    .addToUi();
}

/** Единая точка входа для приложения: принимает и возвращает JSON-строку. */
function api(reqJson) {
  var req = JSON.parse(reqJson);
  var res;
  switch (req.op) {
    case 'load':
      res = load_();
      break;
    case 'init':
      res = withLock_(function () { return init_(req.meta); });
      break;
    case 'setmeta':
      res = withLock_(function () { return setMeta_(req.meta, req.oldSalt); });
      break;
    case 'put':
      res = withLock_(function () { return put_(req.records, req.salt); });
      break;
    case 'del':
      res = withLock_(function () { return del_(req.ids, req.salt); });
      break;
    case 'fput':
      res = withLock_(function () { return fput_(req.fileId, req.chunks, req.salt); });
      break;
    case 'fget':
      res = fget_(req.fileId, req.from || 0, req.count || 24);
      break;
    case 'fdel':
      res = withLock_(function () { return fdel_(req.ids, req.salt); });
      break;
    case 'lockfail':
      res = withLock_(lockFail_);
      break;
    case 'lockok':
      res = withLock_(lockOk_);
      break;
    case 'setlang':
      res = setLang_(req.lang);
      break;
    default:
      throw new Error('Неизвестная операция: ' + req.op);
  }
  return JSON.stringify(res);
}

/** Запускается из меню таблицы. Из веб-приложения не сработает (нет окна подтверждения). */
function resetAllData() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert(
    'Удалить все данные Комуналки?',
    'Все зашифрованные записи, файлы и ключ будут удалены без возможности восстановления. ' +
      'После этого в приложении можно будет задать новый пароль.',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;
  withLock_(function () {
    clearData_(dataSheet_());
    clearData_(filesSheet_());
    metaSheet_().getRange(1, 2).setValue('');
  });
  PropertiesService.getUserProperties().deleteProperty(LOCK_KEY);
  ui.alert('Готово. Откройте приложение и задайте новый пароль.');
}

// ---------------------------------------------------------------- записи

function load_() {
  var sheet = dataSheet_();
  var records = [];
  var last = sheet.getLastRow();
  if (last > 1) {
    var values = sheet.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < values.length; i++) {
      if (!values[i][0]) continue;
      records.push({ id: String(values[i][0]), data: String(values[i][1]), ts: toIso_(values[i][2]) });
    }
  }
  return {
    meta: readMeta_(),
    lock: lockView_(lockRead_()),
    lang: PropertiesService.getUserProperties().getProperty(LANG_KEY) || '',
    records: records,
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl()
  };
}

function init_(meta) {
  if (readMeta_()) throw new Error('already_initialized');
  checkMeta_(meta);
  writeMeta_(meta);
  return { ok: true };
}

/** Смена пароля: меняется только обёртка ключа данных, сами данные не трогаются. */
function setMeta_(meta, oldSalt) {
  var current = readMeta_();
  if (!current || current.salt !== oldSalt) throw new Error('stale_key');
  checkMeta_(meta);
  writeMeta_(meta);
  return { ok: true };
}

function put_(records, salt) {
  requireSalt_(salt);
  var sheet = dataSheet_();
  var index = rowIndex_(sheet);
  var now = new Date();
  var fresh = [];
  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    checkRecord_(rec);
    var row = [rec.id, rec.data, now];
    if (index[rec.id]) {
      sheet.getRange(index[rec.id], 1, 1, 3).setValues([row]);
    } else {
      fresh.push(row);
    }
  }
  if (fresh.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, 3).setValues(fresh);
  }
  return { ok: true, ts: now.toISOString() };
}

function del_(ids, salt) {
  requireSalt_(salt);
  var sheet = dataSheet_();
  var index = rowIndex_(sheet);
  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    if (index[ids[i]]) rows.push(index[ids[i]]);
  }
  rows.sort(function (a, b) { return b - a; });
  for (var j = 0; j < rows.length; j++) sheet.deleteRow(rows[j]);
  return { ok: true };
}

// ---------------------------------------------------------------- файлы

function fput_(fileId, chunks, salt) {
  requireSalt_(salt);
  checkFileId_(fileId);
  var rows = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    if (typeof c.i !== 'number' || c.i < 0 || c.i % 1 !== 0 ||
        !/^c:[A-Za-z0-9+\/=]+$/.test(c.data) || c.data.length > 45010) {
      throw new Error('bad_chunk');
    }
    rows.push([fileId, c.i, c.data]);
  }
  if (rows.length) {
    var sheet = filesSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  }
  return { ok: true };
}

function fget_(fileId, from, count) {
  checkFileId_(fileId);
  var sheet = filesSheet_();
  var wanted = {};
  wanted[fileId] = true;
  var rows = fileRows_(sheet, wanted).sort(function (a, b) { return a.i - b.i; });
  var page = rows.slice(from, from + Math.min(count, 40));
  var chunks = [];
  // подряд идущие строки читаем одним запросом
  var k = 0;
  while (k < page.length) {
    var start = k;
    while (k + 1 < page.length && page[k + 1].row === page[k].row + 1) k++;
    var vals = sheet.getRange(page[start].row, 3, k - start + 1, 1).getValues();
    for (var j = 0; j < vals.length; j++) chunks.push({ i: page[start + j].i, data: String(vals[j][0]) });
    k++;
  }
  return { total: rows.length, chunks: chunks };
}

function fdel_(ids, salt) {
  requireSalt_(salt);
  var wanted = {};
  for (var i = 0; i < ids.length; i++) {
    checkFileId_(ids[i]);
    wanted[ids[i]] = true;
  }
  var sheet = filesSheet_();
  var rows = fileRows_(sheet, wanted)
    .map(function (x) { return x.row; })
    .sort(function (a, b) { return b - a; });
  // удаляем снизу вверх, подряд идущие строки — одним вызовом
  var k = 0;
  while (k < rows.length) {
    var start = k;
    while (k + 1 < rows.length && rows[k + 1] === rows[k] - 1) k++;
    sheet.deleteRows(rows[k], k - start + 1);
    k++;
  }
  return { ok: true };
}

/** Строки листа файлов, относящиеся к указанным id: [{row, id, i}]. */
function fileRows_(sheet, wanted) {
  var out = [];
  var last = sheet.getLastRow();
  if (last < 2) return out;
  var vals = sheet.getRange(2, 1, last - 1, 2).getValues();
  for (var r = 0; r < vals.length; r++) {
    var id = String(vals[r][0]);
    if (wanted[id]) out.push({ row: r + 2, id: id, i: Number(vals[r][1]) });
  }
  return out;
}

// ---------------------------------------------------------------- листы

function dataSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DATA_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(DATA_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['id', 'Зашифрованные данные', 'Изменено']]).setFontWeight('bold');
    sheet.getRange('A:B').setNumberFormat('@');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 220);
    sheet.setColumnWidth(2, 420);
    sheet.setColumnWidth(3, 160);
  }
  return sheet;
}

function filesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(FILES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(FILES_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['Файл', 'Часть', 'Зашифрованные данные']]).setFontWeight('bold');
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange('C:C').setNumberFormat('@');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 220);
    sheet.setColumnWidth(3, 420);
  }
  return sheet;
}

function metaSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(META_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(META_SHEET);
    sheet.getRange('B1').setNumberFormat('@');
    sheet.getRange(1, 1).setValue('meta').setFontWeight('bold');
    sheet.getRange(3, 1).setValue(
      'Здесь хранится соль и зашифрованный ключ данных. Сам пароль нигде не хранится. ' +
        'Не редактируйте этот лист — иначе данные будет не расшифровать.'
    );
    sheet.setColumnWidth(2, 420);
  }
  return sheet;
}

function readMeta_() {
  var raw = metaSheet_().getRange(1, 2).getValue();
  if (!raw) return null;
  return JSON.parse(raw);
}

function writeMeta_(meta) {
  metaSheet_().getRange(1, 2).setValue(JSON.stringify(meta));
}

function clearData_(sheet) {
  var last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);
}

function rowIndex_(sheet) {
  var index = {};
  var last = sheet.getLastRow();
  if (last > 1) {
    var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0]) index[String(ids[i][0])] = i + 2;
    }
  }
  return index;
}

// ---------------------------------------------------------------- проверки

function requireSalt_(salt) {
  var meta = readMeta_();
  if (!meta) throw new Error('not_initialized');
  if (meta.salt !== salt) throw new Error('stale_key');
}

function checkMeta_(meta) {
  if (!meta || typeof meta.salt !== 'string' || typeof meta.dek !== 'string' || !meta.iter) {
    throw new Error('bad_meta');
  }
}

function checkRecord_(rec) {
  if (!rec || !/^[a-z0-9]{1,64}$/.test(rec.id) || !/^v1:[A-Za-z0-9+\/=]+$/.test(rec.data)) {
    throw new Error('bad_record');
  }
  if (rec.data.length > 45000) throw new Error('record_too_big');
}

function checkFileId_(id) {
  if (!/^f[a-z0-9]{10,40}$/.test(String(id))) throw new Error('bad_file_id');
}

// ---------------------------------------------------------------- блокировка входа
// Пароль сервер не видит, поэтому неверный ввод определяет приложение и сообщает сюда.
// Счётчик хранится в свойствах пользователя: у каждого Google-аккаунта свой,
// и его нельзя сбросить обновлением страницы или окном инкогнито.

var LOCK_KEY = 'komunalka.lock';
var LANG_KEY = 'komunalka.lang';
var LOCK_MAX_FAILS = 5;
var LOCK_MINUTES = [5, 15, 60];

function lockRead_() {
  var raw = PropertiesService.getUserProperties().getProperty(LOCK_KEY);
  var s = {};
  try {
    s = raw ? JSON.parse(raw) : {};
  } catch (e) {
    s = {};
  }
  return { fails: Number(s.fails) || 0, until: Number(s.until) || 0, level: Number(s.level) || 0 };
}

function lockView_(s) {
  var now = Date.now();
  return { fails: s.fails, until: s.until > now ? s.until : 0, now: now, max: LOCK_MAX_FAILS };
}

function lockFail_() {
  var s = lockRead_();
  var now = Date.now();
  if (s.until > now) return lockView_(s); // уже заблокировано — попытка не считается
  s.fails += 1;
  if (s.fails >= LOCK_MAX_FAILS) {
    s.until = now + LOCK_MINUTES[Math.min(s.level, LOCK_MINUTES.length - 1)] * 60000;
    s.level += 1;
    s.fails = 0;
  }
  PropertiesService.getUserProperties().setProperty(LOCK_KEY, JSON.stringify(s));
  return lockView_(s);
}

function lockOk_() {
  var v = lockView_(lockRead_());
  if (v.until) {
    v.ok = false; // во время блокировки не пускаем даже с верным паролем
    return v;
  }
  PropertiesService.getUserProperties().deleteProperty(LOCK_KEY);
  return { ok: true, fails: 0, until: 0, now: v.now, max: LOCK_MAX_FAILS };
}

/** Язык интерфейса запоминается у Google: в Safari внутри фрейма памяти браузера часто нет. */
function setLang_(lang) {
  var l = String(lang);
  if (l !== 'ru' && l !== 'uk' && l !== 'en') throw new Error('bad_lang');
  PropertiesService.getUserProperties().setProperty(LANG_KEY, l);
  return { ok: true };
}

/** Меню таблицы: снять блокировку входа для своего Google-аккаунта. */
function unlockLogin() {
  PropertiesService.getUserProperties().deleteProperty(LOCK_KEY);
  SpreadsheetApp.getUi().alert('Блокировка входа снята — можно снова вводить пароль.');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function toIso_(v) {
  if (v instanceof Date) return v.toISOString();
  return v ? String(v) : '';
}
