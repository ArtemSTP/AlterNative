/**
 * Commands — язык команд для таблицы
 *
 * A1 = текст
 * A1, B2 = текст
 * A1 -> C3 = текст
 * type A1 = B and I
 * new column [between C and D]
 * new row [between 2 and 5]
 * move D between A and B | move D to start | move D to end
 * delete column D | delete row 3
 * color A1, 2, C = red | default|grey|red|yellow|green|blue
 * union A1 -> C3 | split A1 -> C3
 * B width = 150% | A1 width = 50% | B1->C3 width = 50%
 * 7 height = 120% | A1 height = 50% | B1->C3 height = 120%
 * B1->C3 size = 200% | normalize
 * border B12 = up, right | all | null | left/right/up/down
 * clear A1 -> C3 | clear E10, F11 — значения чисто, type = default
 * help — список команд
 */
const Commands = (() => {
    const SYNTAX = 'ошибка синтаксиса';
    const MAX_ROWS = 5000;
    const MAX_COLS = 200;
    const MAX_CELLS = 10000;

    const CYRILLIC = {
        'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'К': 'K', 'М': 'M',
        'О': 'O', 'Р': 'P', 'Т': 'T', 'У': 'Y', 'Х': 'X'
    };

    function syntaxError(message) {
        return new Error(message || SYNTAX);
    }

    function normalizeLetters(text) {
        return String(text).toUpperCase().split('').map(ch => CYRILLIC[ch] || ch).join('');
    }

    function colToIndex(letters) {
        const normalized = normalizeLetters(letters);
        let value = 0;
        for (const ch of normalized) {
            const code = ch.charCodeAt(0);
            if (code < 65 || code > 90) throw syntaxError();
            value = value * 26 + (code - 64);
        }
        if (value < 1 || value > MAX_COLS) throw syntaxError();
        return value;
    }

    function indexToCol(value) {
        let name = '';
        let num = value;
        while (num > 0) {
            const rem = (num - 1) % 26;
            name = String.fromCharCode(65 + rem) + name;
            num = Math.floor((num - rem - 1) / 26);
        }
        return name;
    }

    function skipSpaces(text, index) {
        while (index < text.length && /\s/.test(text[index])) index++;
        return index;
    }

    function readCellRef(text, index) {
        const match = /^([A-Za-z\u0410-\u044F\u0401\u0451]+)([0-9]+)/.exec(text.slice(index));
        if (!match) return null;

        const col = colToIndex(match[1]);
        const row = Number(match[2]);
        if (!Number.isInteger(row) || row < 1 || row > MAX_ROWS) throw syntaxError();

        return { col, row, end: index + match[0].length };
    }

    /**
     * Разобрать список «A1, B2 -> C3»
     * @returns {Array<{r0,c0,r1,c1}>} 0-based прямоугольники
     */
    function parseRefList(input) {
        const text = String(input || '').trim();
        if (!text) throw syntaxError();

        const ranges = [];
        let index = 0;

        while (true) {
            index = skipSpaces(text, index);
            const start = readCellRef(text, index);
            if (!start) throw syntaxError();
            index = skipSpaces(text, start.end);

            if (text.startsWith('->', index)) {
                index = skipSpaces(text, index + 2);
                const end = readCellRef(text, index);
                if (!end) throw syntaxError();
                index = skipSpaces(text, end.end);

                if (end.col < start.col || end.row < start.row) throw syntaxError();
                ranges.push({
                    r0: start.row - 1, c0: start.col - 1,
                    r1: end.row - 1, c1: end.col - 1
                });
            } else {
                ranges.push({
                    r0: start.row - 1, c0: start.col - 1,
                    r1: start.row - 1, c1: start.col - 1
                });
            }

            if (index >= text.length) break;
            if (text[index] === ',') {
                index++;
                continue;
            }
            if (/[A-Za-z0-9\u0410-\u044F\u0401\u0451]/.test(text[index])) {
                throw new Error('отсутствует разделитель');
            }
            throw syntaxError();
        }

        return ranges;
    }

    function checkCellCount(ranges) {
        let total = 0;
        for (const range of ranges) {
            total += (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
            if (total > MAX_CELLS) throw syntaxError();
        }
    }

    function forEachCell(ranges, callback) {
        checkCellCount(ranges);
        for (const range of ranges) {
            for (let r = range.r0; r <= range.r1; r++) {
                for (let c = range.c0; c <= range.c1; c++) {
                    callback(r, c);
                }
            }
        }
    }

    // ---------- helpers for refs ----------

    const LETTERS_RE = /^[A-Za-z\u0410-\u044F\u0401\u0451]+$/;
    const DIGITS_RE = /^\d+$/;
    const CELL_RE = /^([A-Za-z\u0410-\u044F\u0401\u0451]+)([0-9]+)$/;

    function refKind(token) {
        if (DIGITS_RE.test(token)) return 'row';
        if (LETTERS_RE.test(token)) return 'column';
        if (CELL_RE.test(token)) return 'cell';
        return null;
    }

    // ---------- assignment ----------

    function execAssign(text) {
        const eq = text.indexOf('=');
        if (eq < 1) throw syntaxError();

        const ranges = parseRefList(text.slice(0, eq));
        const value = text.slice(eq + 1).trim();
        if (!value) throw syntaxError();

        forEachCell(ranges, (r, c) => SheetView.setCellValue(r, c, value));
        SheetView.refresh();
    }

    // ---------- type ----------

    function parseTypes(input) {
        const parts = String(input || '').split(/\s*(?:,|\band\b)\s*/i)
            .map(part => part.trim())
            .filter(Boolean);
        if (!parts.length) throw syntaxError();

        const flags = { bold: false, italic: false, underline: false, url: false };
        let hasBold = false;
        let hasDefault = false;

        for (const part of parts) {
            if (part === '_') {
                flags.underline = true;
                continue;
            }
            switch (part.toLowerCase()) {
                case 'b': flags.bold = true; hasBold = true; break;
                case 'i': flags.italic = true; break;
                case 'd': hasDefault = true; break;
                case 'url': flags.url = true; break;
                default: throw syntaxError();
            }
        }

        if (hasBold && hasDefault) {
            throw new Error('взаимоисключающие типы');
        }
        return flags;
    }

    function execType(text) {
        const match = /^type\s+(.+?)\s*=\s*(.+)$/i.exec(text);
        if (!match) throw syntaxError();

        const ranges = parseRefList(match[1]);
        const flags = parseTypes(match[2]);

        forEachCell(ranges, (r, c) => {
            const font = Object.assign({}, SheetView.getCellFont(r, c) || {});

            // Сбрасываем только типы шрифта; размер/имя/цвет сохраняем
            delete font.bold;
            delete font.italic;
            delete font.underline;
            delete font.url;

            if (flags.bold) font.bold = true;
            if (flags.italic) font.italic = true;
            if (flags.underline) font.underline = true;
            if (flags.url) font.url = true;

            SheetView.setCellFont(r, c, font);
        });

        SheetView.refresh();
    }

    // ---------- new ----------

    function execNew(text) {
        const match = /^new\s+(column|row)\s*(?:between\s+(\S+)\s+and\s+(\S+))?\s*$/i.exec(text);
        if (!match) throw syntaxError();

        const axis = match[1].toLowerCase();
        const { rows, cols } = SheetView.getGrid();
        const count = axis === 'column' ? cols : rows;

        if (!match[2]) {
            if (axis === 'column') SheetView.insertColumnAt(cols);
            else SheetView.insertRowAt(rows);
            SheetView.refresh();
            return;
        }

        let from;
        let to;
        if (axis === 'column') {
            if (!/^[A-Za-z\u0410-\u044F\u0401\u0451]+$/.test(match[2]) ||
                !/^[A-Za-z\u0410-\u044F\u0401\u0451]+$/.test(match[3])) {
                throw syntaxError();
            }
            from = colToIndex(match[2]);
            to = colToIndex(match[3]);
        } else {
            if (!/^\d+$/.test(match[2]) || !/^\d+$/.test(match[3])) throw syntaxError();
            from = Number(match[2]);
            to = Number(match[3]);
        }

        if (from < 1 || to > count || from >= to) throw syntaxError();

        if (axis === 'column') SheetView.insertColumnAt(to - 1);
        else SheetView.insertRowAt(to - 1);
        SheetView.refresh();
    }

    // ---------- move ----------

    function execMove(text) {
        const match = /^move\s+(?:(column|row)\s+)?(\S+)\s+(.+)$/i.exec(text);
        if (!match) throw syntaxError();

        const axisWord = match[1] ? match[1].toLowerCase() : null;
        const refToken = match[2];
        const rest = match[3].trim();

        let axis;
        if (axisWord) {
            axis = axisWord;
        } else if (/^\d+$/.test(refToken)) {
            axis = 'row';
        } else if (/^[A-Za-z\u0410-\u044F\u0401\u0451]+$/.test(refToken)) {
            axis = 'column';
        } else {
            throw syntaxError();
        }

        const { rows, cols } = SheetView.getGrid();
        const count = axis === 'column' ? cols : rows;

        let source;
        if (axis === 'column') {
            if (!/^[A-Za-z\u0410-\u044F\u0401\u0451]+$/.test(refToken)) throw syntaxError();
            source = colToIndex(refToken);
        } else {
            if (!/^\d+$/.test(refToken)) throw syntaxError();
            source = Number(refToken);
        }
        if (source < 1 || source > count) throw syntaxError();

        let target;
        const between = /^between\s+(\S+)\s+and\s+(\S+)$/i.exec(rest);

        if (between) {
            let from;
            let to;
            if (axis === 'column') {
                if (!/^[A-Za-z\u0410-\u044F\u0401\u0451]+$/.test(between[1]) ||
                    !/^[A-Za-z\u0410-\u044F\u0401\u0451]+$/.test(between[2])) {
                    throw syntaxError();
                }
                from = colToIndex(between[1]);
                to = colToIndex(between[2]);
            } else {
                if (!/^\d+$/.test(between[1]) || !/^\d+$/.test(between[2])) throw syntaxError();
                from = Number(between[1]);
                to = Number(between[2]);
            }
            if (from < 1 || to > count || from >= to) throw syntaxError();

            // Вставляем перед столбцом/строкой to, с поправкой на изъятие source
            target = (to - 1) - ((source - 1) < (to - 1) ? 1 : 0);
        } else if (/^to\s+start$/i.test(rest)) {
            target = 0;
        } else if (/^to\s+end$/i.test(rest)) {
            target = count - 1;
        } else {
            throw syntaxError();
        }

        if (axis === 'column') SheetView.moveColumn(source - 1, target);
        else SheetView.moveRow(source - 1, target);
        SheetView.refresh();
    }

    // ---------- clear ----------

    // Очищаем содержимое и type=default (bold/italic/underline/url);
    // fill и borders не трогаем — для них color default / border null
    function execClear(text) {
        const ranges = parseRefList(text.replace(/^clear\s+/i, ''));

        const { rows, cols } = SheetView.getGrid();
        for (const rg of ranges) {
            if (rg.r1 >= rows || rg.c1 >= cols) throw syntaxError();
        }

        forEachCell(ranges, (r, c) => {
            SheetView.setCellValue(r, c, '');

            const font = Object.assign({}, SheetView.getCellFont(r, c) || {});
            delete font.bold;
            delete font.italic;
            delete font.underline;
            delete font.url;
            SheetView.setCellFont(r, c, font);
        });

        SheetView.refresh();
    }

    // ---------- delete ----------

    function execDelete(text) {
        const match = /^delete\s+(?:(column|row)\s+)?([A-Za-z\u0410-\u044F\u0401\u0451]+|\d+)\s*$/i.exec(text);
        if (!match) throw syntaxError();

        const token = match[2];
        const isNumber = DIGITS_RE.test(token);
        const axis = match[1] ? match[1].toLowerCase() : (isNumber ? 'row' : 'column');
        if (axis === 'row' && !isNumber) throw syntaxError();
        if (axis === 'column' && isNumber) throw syntaxError();

        const { rows, cols } = SheetView.getGrid();
        let ok;
        if (axis === 'column') {
            const idx = colToIndex(token);
            ok = idx >= 1 && idx <= cols && SheetView.deleteColumnAt(idx - 1);
        } else {
            const idx = Number(token);
            ok = idx >= 1 && idx <= rows && SheetView.deleteRowAt(idx - 1);
        }
        if (!ok) throw syntaxError();

        SheetView.refresh();
    }

    // ---------- color ----------

    const COLORS = {
        default: 'FFFFFF',
        grey: 'B3B3B3',
        red: 'FF0000',
        yellow: 'FFFF00',
        green: '00FF00',
        blue: '007FFF'
    };

    // Список до «=»: ячейки, списки (", "), диапазоны ("->"), строки, столбцы.
    // Строки и столбцы вместе запрещены; ячейки — можно с ними вместе.
    // Общая грамматика для color и border.
    function parseRefAreas(input) {
        const { rows, cols } = SheetView.getGrid();
        const ranges = [];
        let hasRows = false;
        let hasCols = false;

        const items = String(input || '').split(',');
        for (const raw of items) {
            const item = raw.trim();
            if (!item) throw syntaxError();

            const sides = item.split('->').map(s => s.trim());
            const isRange = sides.length > 1;
            if (sides.length > 2 || sides.some(s => !s)) throw syntaxError();

            const kind = refKind(sides[0]);
            if (!kind || (isRange && refKind(sides[1]) !== kind)) throw syntaxError();

            const bounds = sides.map(token => {
                if (kind === 'cell') {
                    const m = CELL_RE.exec(token);
                    return { col: colToIndex(m[1]), row: Number(m[2]) };
                }
                if (kind === 'row') {
                    const n = Number(token);
                    if (n < 1 || n > rows) throw syntaxError();
                    return { row: n };
                }
                const col = colToIndex(token);
                if (col < 1 || col > cols) throw syntaxError();
                return { col };
            });

            if (isRange && (bounds[0].col > bounds[1].col || bounds[0].row > bounds[1].row)) {
                throw syntaxError();
            }

            const last = bounds[bounds.length - 1];
            if (kind === 'cell') {
                ranges.push({ r0: bounds[0].row - 1, c0: bounds[0].col - 1, r1: last.row - 1, c1: last.col - 1 });
            } else if (kind === 'row') {
                hasRows = true;
                ranges.push({ r0: bounds[0].row - 1, c0: 0, r1: last.row - 1, c1: cols - 1 });
            } else {
                hasCols = true;
                ranges.push({ r0: 0, c0: bounds[0].col - 1, r1: rows - 1, c1: last.col - 1 });
            }
        }

        if (hasRows && hasCols) {
            throw new Error('Укажите либо только строки либо только столбцы');
        }
        return ranges;
    }

    function execColor(text) {
        const eq = text.indexOf('=');
        if (eq < 1) throw syntaxError();

        const head = text.slice(0, eq).replace(/^color\s+/i, '').trim();
        const name = text.slice(eq + 1).trim().toLowerCase();
        if (!head || !Object.prototype.hasOwnProperty.call(COLORS, name)) throw syntaxError();

        const ranges = parseRefAreas(head);
        forEachCell(ranges, (r, c) => {
            const font = Object.assign({}, SheetView.getCellFont(r, c) || {});
            font.fill = COLORS[name];
            SheetView.setCellFont(r, c, font);
        });

        SheetView.refresh();
    }

    // ---------- union / split ----------

    const RANGE_MSG = 'Укажите диапазон ячеек в формате ячейка1->ячейка2';

    function readWholeCellRef(token) {
        const trimmed = String(token).trim();
        const ref = readCellRef(trimmed, 0);
        if (!ref || ref.end !== trimmed.length) return null;
        return ref;
    }

    // Строго «ячейка -> ячейка», иначе — RANGE_MSG
    function parseUnionRange(input) {
        const parts = String(input || '').split('->');
        if (parts.length !== 2) throw new Error(RANGE_MSG);

        let a;
        let b;
        try {
            a = readWholeCellRef(parts[0]);
            b = readWholeCellRef(parts[1]);
        } catch (e) {
            throw new Error(RANGE_MSG);
        }
        if (!a || !b) throw new Error(RANGE_MSG);

        const r0 = Math.min(a.row, b.row) - 1;
        const r1 = Math.max(a.row, b.row) - 1;
        const c0 = Math.min(a.col, b.col) - 1;
        const c1 = Math.max(a.col, b.col) - 1;
        if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_CELLS) throw syntaxError();

        return { r0, c0, r1, c1 };
    }

    function execUnion(text) {
        const range = parseUnionRange(text.replace(/^union\s+/i, ''));
        if (range.r0 === range.r1 && range.c0 === range.c1) throw new Error(RANGE_MSG);

        SheetView.mergeCells(range.r0, range.c0, range.r1, range.c1);
        SheetView.refresh();
    }

    function execSplit(text) {
        const range = parseUnionRange(text.replace(/^split\s+/i, ''));
        if (!SheetView.splitCells(range.r0, range.c0, range.r1, range.c1)) {
            throw new Error('Объединённая ячейка не найдена');
        }
        SheetView.refresh();
    }

    // ---------- border ----------

    const SIDES = ['left', 'right', 'up', 'down'];

    function execBorder(text) {
        const eq = text.indexOf('=');
        if (eq < 1) throw syntaxError();

        const head = text.slice(0, eq).replace(/^border\s+/i, '').trim();
        const sideRaw = text.slice(eq + 1).trim().toLowerCase();
        if (!head || !sideRaw) throw syntaxError();

        const parts = sideRaw.split(',').map(s => s.trim());
        for (const part of parts) {
            if (!part) throw syntaxError();
            if (SIDES.indexOf(part) === -1 && part !== 'all' && part !== 'null') throw syntaxError();
        }
        if (parts.length !== new Set(parts).size) throw syntaxError(); // дубли: left, left
        if (parts.length > 1 && (parts.indexOf('all') !== -1 || parts.indexOf('null') !== -1)) {
            throw syntaxError(); // all/null сами по себе
        }

        const ranges = parseRefAreas(head);
        checkCellCount(ranges);

        if (parts[0] === 'null') SheetView.clearBorders(ranges);
        else if (parts[0] === 'all') SheetView.setBordersAll(ranges);
        else SheetView.setBorders(ranges, new Set(parts));

        SheetView.refresh();
    }

    // ---------- width / height / size ----------

    const DIM_RE = /^(.+?)\s+(width|height|size)\s*=?\s*(\d+(?:[.,]\d+)?)\s*%?$/i;
    const WIDTH_MSG = 'оператор width работает только со столбцами';
    const HEIGHT_MSG = 'оператор height работает только со строками';

    // Процент от текущего размера; «=» и «%» факультативны
    function execDim(targetStr, op, pct) {
        if (!(pct > 0)) throw syntaxError();
        const factor = pct / 100;
        const { rows, cols } = SheetView.getGrid();

        const items = String(targetStr || '').split(',');
        if (!items.length || !items[0].trim()) throw syntaxError();

        for (const raw of items) {
            const item = raw.trim();
            if (!item) throw syntaxError();

            const sides = item.split('->').map(s => s.trim());
            const isRange = sides.length > 1;
            if (sides.length > 2 || sides.some(s => !s)) throw syntaxError();

            const kind = refKind(sides[0]);
            if (!kind || (isRange && refKind(sides[1]) !== kind)) throw syntaxError();
            if (op === 'width' && kind === 'row') throw new Error(WIDTH_MSG);
            if (op === 'height' && kind === 'column') throw new Error(HEIGHT_MSG);
            if (op === 'size' && kind !== 'cell') throw syntaxError();

            const cellOf = (token) => {
                const m = CELL_RE.exec(token);
                const col = colToIndex(m[1]);
                const row = Number(m[2]);
                if (col < 1 || col > cols || row < 1 || row > rows) throw syntaxError();
                return { col, row };
            };

            if (kind === 'cell') {
                const start = cellOf(sides[0]);
                const end = isRange ? cellOf(sides[1]) : start;
                if (end.col < start.col || end.row < start.row) throw syntaxError();

                if (op === 'width') {
                    if (isRange) SheetView.scaleColumnsEqual(start.col - 1, end.col - 1, factor);
                    else SheetView.scaleColumnWidth(start.col, factor);
                } else if (op === 'height') {
                    if (isRange) SheetView.scaleRowsEqual(start.row - 1, end.row - 1, factor);
                    else SheetView.scaleRowHeight(start.row, factor);
                } else {
                    if (isRange) {
                        SheetView.scaleColumnsEqual(start.col - 1, end.col - 1, factor);
                        SheetView.scaleRowsEqual(start.row - 1, end.row - 1, factor);
                    } else {
                        SheetView.scaleColumnWidth(start.col, factor);
                        SheetView.scaleRowHeight(start.row, factor);
                    }
                }
                continue;
            }

            if (kind === 'column') {
                const bounds = sides.map(token => {
                    const col = colToIndex(token);
                    if (col < 1 || col > cols) throw syntaxError();
                    return col;
                });
                if (isRange && bounds[0] > bounds[1]) throw syntaxError();
                for (let c = bounds[0]; c <= bounds[bounds.length - 1]; c++) {
                    SheetView.scaleColumnWidth(c, factor);
                }
                continue;
            }

            // kind === 'row'
            const bounds = sides.map(token => {
                const n = Number(token);
                if (n < 1 || n > rows) throw syntaxError();
                return n;
            });
            if (isRange && bounds[0] > bounds[1]) throw syntaxError();
            for (let r = bounds[0]; r <= bounds[bounds.length - 1]; r++) {
                SheetView.scaleRowHeight(r, factor);
            }
        }

        SheetView.refresh();
    }

    function executeOne(line) {
        const text = String(line || '').trim();
        if (!text) throw syntaxError();

        if (/^normalize\s*$/i.test(text)) {
            SheetView.normalizeSizes();
            SheetView.refresh();
            return;
        }

        const dim = DIM_RE.exec(text);
        // присваивание вида «A1 = ...» не должно попадать в width|height|size
        if (dim && dim[1].indexOf('=') === -1) {
            return execDim(dim[1], dim[2].toLowerCase(), Number(dim[3].replace(',', '.')));
        }

        if (/^type\s/i.test(text)) return execType(text);
        if (/^new\s/i.test(text)) return execNew(text);
        if (/^move\s/i.test(text)) return execMove(text);
        if (/^clear\s/i.test(text)) return execClear(text);
        if (/^delete\s/i.test(text)) return execDelete(text);
        if (/^color\s/i.test(text)) return execColor(text);
        if (/^border\s/i.test(text)) return execBorder(text);
        if (/^union\s/i.test(text)) return execUnion(text);
        if (/^split\s/i.test(text)) return execSplit(text);
        return execAssign(text);
    }

    // ---------- несколько команд: (…) + (…) ----------

    const ESCAPE_MSG = 'Команда должна быть экранирована "(" или ")"';
    const SEPARATOR_MSG = 'Отсутствует разделитель "+" между командами';
    const NO_CELLS_MSG = 'Не указаны ячейки';
    const FIRST_CELLS_MSG = 'Ячейки обязательно должны быть указаны в первой команде';

    const REF_OPS = ['type', 'color', 'border', 'clear', 'union', 'split'];

    // Похоже ли содержимое на команду, а не на произвольный текст значения
    function looksLikeCommand(text) {
        const trimmed = String(text || '').trim();
        if (/^(type|color|border|clear|new|move|delete|union|split|normalize)\b/i.test(trimmed)) {
            return true;
        }
        return trimmed.indexOf('=') !== -1 &&
            /^[A-Za-z\u0410-\u044F\u0401\u0451]+\s*\d*\b/.test(trimmed);
    }

    function groupLooksLikeCommand(text) {
        const trimmed = text.trim();
        if (trimmed.charAt(0) !== '(') return false;

        let depth = 0;
        for (let i = 0; i < trimmed.length; i++) {
            if (trimmed[i] === '(') depth++;
            else if (trimmed[i] === ')' && --depth === 0) {
                return looksLikeCommand(trimmed.slice(1, i));
            }
        }
        return false;
    }

    // Строка — цепочка команд, только если есть экранирование и/или «+» у групп.
    // Иначе «A1 = текст (с пояснением)» остаётся обычным присваиванием.
    function isStructured(text) {
        const trimmed = text.trim();
        if (trimmed.charAt(0) === '(') return true;
        if (trimmed.indexOf('+') === -1) return false;

        const operator = /^(type|color|border|clear|new|move|delete|union|split|normalize)\b/i;
        const parts = trimmed.split('+');

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i].trim();
            if (operator.test(part)) return true;
            if (part.charAt(0) === '(' && groupLooksLikeCommand(part)) return true;
        }

        // Группа перед «+» в значении: A1 = x+(color = red)+...
        const before = /\(([^()]*)\)\s*\+/.exec(trimmed);
        return !!before && looksLikeCommand(before[1]);
    }

    function matchingParen(text, open) {
        let depth = 0;
        for (let i = open; i < text.length; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')' && --depth === 0) return i;
        }
        return -1;
    }

    function parseLevel(text, start, depth, state) {
        const elements = [];
        let index = start;

        while (index < text.length) {
            index = skipSpaces(text, index);
            if (index >= text.length) break;

            if (text[index] === ')') {
                if (depth === 0) {
                    state.unescaped = true;
                    index++;
                    continue;
                }
                return { elements, next: index + 1 };
            }

            if (text[index] === '(') {
                const inner = parseLevel(text, index + 1, depth + 1, state);
                elements.push({ type: 'group', elements: inner.elements });
                index = skipSpaces(text, inner.next);
                if (index < text.length && text[index] !== '+' && text[index] !== ')') {
                    if (text[index] === '(') state.separator = true;
                    else state.unescaped = true;
                }
                continue;
            }

            const from = index;
            while (index < text.length && text[index] !== '+' && text[index] !== ')') {
                if (text[index] === '(') {
                    // Скобка в середине команды — часть значения,
                    // например: (A1 = текст (пояснение))+(color = red)
                    const close = matchingParen(text, index);
                    index = close === -1 ? index + 1 : close + 1;
                    continue;
                }
                index++;
            }
            const bare = text.slice(from, index).trim();
            if (bare) elements.push({ type: 'command', text: bare });

            index = skipSpaces(text, index);
            if (text[index] === '+') index++;
        }

        // Незакрытая скобка
        if (depth > 0) state.unescaped = true;

        return { elements, next: index };
    }

    function validateLevels(elements) {
        if (!elements.length) throw syntaxError();
        if (elements.length > 1 && elements.some(element => element.type === 'command')) {
            throw new Error(ESCAPE_MSG);
        }
        for (const element of elements) {
            if (element.type === 'group') validateLevels(element.elements);
        }
    }

    // Оператор команды и его ссылки (до «=»). null — ссылок нет.
    function commandInfo(text) {
        const match = /^\s*[A-Za-z\u0410-\u044F\u0401\u0451]+/.exec(text);
        const word = match ? match[0].trim().toLowerCase() : '';
        const known = ['type', 'color', 'border', 'clear', 'new', 'move', 'delete',
            'union', 'split', 'normalize'];
        const kind = known.indexOf(word) !== -1 ? word : 'other';

        if (kind === 'color' || kind === 'border' || kind === 'type') {
            const eq = text.indexOf('=');
            const headEnd = eq === -1 ? text.length : eq;
            const head = text.slice(match ? match[0].length : 0, headEnd).trim();
            return { kind, refs: head || null };
        }
        if (kind === 'clear' || kind === 'union' || kind === 'split') {
            const head = text.slice(match ? match[0].length : 0).trim();
            return { kind, refs: head || null };
        }
        if (kind === 'other') {
            // width/height/size — не присваивание
            const dim = DIM_RE.exec(text);
            if (dim && dim[1].indexOf('=') === -1) return { kind: 'dim', refs: null };

            const eq = text.indexOf('=');
            if (eq > 0) return { kind: 'assign', refs: text.slice(0, eq).trim() || null };
        }
        return { kind, refs: null };
    }

    function providesRefs(info) {
        return !!info.refs && (REF_OPS.indexOf(info.kind) !== -1 || info.kind === 'assign');
    }

    // Подставить унаследованные ячейки: «color = green» → «color A1, B1 = green»
    function withInheritedRefs(text, refs) {
        const match = /^\s*[A-Za-z\u0410-\u044F\u0401\u0451]+/.exec(text);
        if (!match) return text;
        return text.slice(0, match[0].length) + ' ' + refs + text.slice(match[0].length);
    }

    function rangesToText(ranges) {
        return ranges.map(rg => {
            const first = indexToCol(rg.c0 + 1) + (rg.r0 + 1);
            if (rg.r0 === rg.r1 && rg.c0 === rg.c1) return first;
            return first + ' -> ' + indexToCol(rg.c1 + 1) + (rg.r1 + 1);
        }).join(', ');
    }

    function refsToRanges(kind, refs) {
        if (!refs) return [];
        try {
            // color/border понимают строки и столбцы, остальные — только ячейки
            if (kind === 'color' || kind === 'border') return parseRefAreas(refs);
            return parseRefList(refs);
        } catch (e) {
            return []; // сообщит сама команда
        }
    }

    // Есть ли в элементе явно указанные ячейки (рекурсивно для групп)
    function hasExplicitRefs(element) {
        if (element.type === 'command') return providesRefs(commandInfo(element.text));
        return element.elements.some(hasExplicitRefs);
    }

    function countExplicitRefs(elements) {
        return elements.reduce((total, element) => total + (element.type === 'command'
            ? (hasExplicitRefs(element) ? 1 : 0)
            : countExplicitRefs(element.elements)), 0);
    }

    // Проверка до выполнения: первая команда с ячейками должна их указать.
    // state.seen/total — чтобы отличить «ячеек нет нигде» от «указаны позже».
    function validateLevel(elements, refsAvailable, state) {
        let available = !!refsAvailable;

        for (const element of elements) {
            if (element.type === 'group') {
                validateLevel(element.elements, available, state);
                if (hasExplicitRefs(element)) available = true;
                continue;
            }

            const info = commandInfo(element.text);
            if (providesRefs(info)) {
                state.seen++;
                available = true;
                continue;
            }
            if (REF_OPS.indexOf(info.kind) === -1) continue;
            if (available) continue;

            throw new Error(state.seen < state.total ? FIRST_CELLS_MSG : NO_CELLS_MSG);
        }
    }

    // Выполнение уровня; inheritedRefs — ячейки, унаследованные от родителя.
    // Порядок: вложенные группы выполняются по мере обхода, ячейки
    // наследуются от ближайшей команды/группы, где они указаны.
    function executeLevel(elements, inheritedRefs) {
        let currentRefs = inheritedRefs || null;
        const touched = [];

        for (const element of elements) {
            if (element.type === 'group') {
                const result = executeLevel(element.elements, currentRefs);
                touched.push(...result.ranges);
                if (result.ranges.length) currentRefs = rangesToText(result.ranges);
                continue;
            }

            const info = commandInfo(element.text);
            if (REF_OPS.indexOf(info.kind) !== -1) {
                const refs = info.refs || currentRefs;
                if (!refs) throw new Error(NO_CELLS_MSG); // страховка

                const line = info.refs ? element.text : withInheritedRefs(element.text, refs);
                executeOne(line);
                if (info.refs) currentRefs = info.refs;
                touched.push(...refsToRanges(info.kind, refs));
            } else {
                executeOne(element.text);
                if (info.kind === 'assign' && info.refs) {
                    currentRefs = info.refs;
                    touched.push(...refsToRanges(info.kind, info.refs));
                }
            }
        }

        return { ranges: touched };
    }

    function execute(line) {
        const text = String(line || '').trim();
        if (!text) throw syntaxError();

        if (!isStructured(text)) {
            const elements = [{ type: 'command', text }];
            validateLevel(elements, false, { seen: 0, total: countExplicitRefs(elements) });
            return executeLevel(elements);
        }

        const state = { unescaped: false, separator: false };
        const root = parseLevel(text, 0, 0, state);
        // Приоритет: ошибка экранирования важнее ошибки разделителя.
        if (state.unescaped) throw new Error(ESCAPE_MSG);
        if (state.separator) throw new Error(SEPARATOR_MSG);

        validateLevels(root.elements);
        validateLevel(root.elements, false, { seen: 0, total: countExplicitRefs(root.elements) });
        return executeLevel(root.elements);
    }

    return { execute, parseRefList, colToIndex, indexToCol };
})();
