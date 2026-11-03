/**
 * SheetView — рендер листов и редактирование ячеек
 *
 * Модель: { sheets: [ { name, data: string[][], fonts?, colWidths?, rows?, cols?,
 *                      rowHeights?, merges?, zoom? } ] }
 * rows/cols — видимый размер сетки (необязательно).
 * fonts и colWidths — разреженные объекты: "row:col" и "1" (номер столбца).
 * rowHeights — разреженный объект "1" → высота строки в px (по умолчанию 20).
 * merges — список объединённых диапазонов {r0,c0,r1,c1}; zoom — масштаб 0.2..5.
 * fill в fonts — цвет фона ячейки (RRGGBB); borders — рамки "r:c" → {up,down,left,right}.
 */
const SheetView = (() => {
    const DEFAULT_ROWS = 50;
    const DEFAULT_COLS = 10;
    const MIN_COL_PX = 80;        // ширина столбца по умолчанию
    const MIN_COL_NARROW_PX = 20; // пол явно заданной ширины
    const DEFAULT_ROW_PX = 20;    // высота строки по умолчанию (Excel 15pt)
    const MIN_ROW_PX = 10;
    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 5;
    const ROW_PADDING_PX = 8;     // вертикальные отступы td
    const ROW_HEADER_PX = 44;
    const PADDING_PX = 18;

    let tabsEl = null;
    let containerEl = null;
    let onChange = null;

    let workbook = { sheets: [] };
    let activeIndex = 0;
    const dirty = new Set(); // "sheet:row:col"
    let structuralDirty = false;

    const measureCtx = document.createElement('canvas').getContext('2d');

    function init(tabs, container, callback) {
        tabsEl = tabs;
        containerEl = container;
        onChange = callback;

        // Ctrl + колесо над таблицей — масштаб; обычное колесо — обычный скролл
        if (containerEl && !containerEl.dataset.zoomBound) {
            containerEl.dataset.zoomBound = '1';
            containerEl.addEventListener('wheel', (e) => {
                if (!e.ctrlKey || !e.deltaY || !getActiveSheet()) return;
                e.preventDefault(); // не даём браузеру зумить всю страницу
                setZoom(getZoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
            }, { passive: false });
        }
    }

    function emptyWorkbook() {
        return { sheets: [{ name: 'Лист1', data: [], fonts: {}, colWidths: {} }] };
    }

    function setWorkbook(json) {
        workbook = json && Array.isArray(json.sheets) ? json : { sheets: [] };
        if (!workbook.sheets.length) workbook = emptyWorkbook();
        activeIndex = 0;
        dirty.clear();
        structuralDirty = false;
        render();
        notify();
    }

    function getWorkbook() {
        return workbook;
    }

    function getActiveSheet() {
        return workbook.sheets[activeIndex] || null;
    }

    function getActiveIndex() {
        return activeIndex;
    }

    function setActiveIndex(index) {
        if (index >= 0 && index < workbook.sheets.length) {
            activeIndex = index;
            render();
        }
    }

    function hasChanges() {
        return dirty.size > 0 || structuralDirty;
    }

    function isStructuralDirty() {
        return structuralDirty;
    }

    function setStructuralDirty(value) {
        structuralDirty = !!value;
        notify();
    }

    function getDirtyCount() {
        return dirty.size + (structuralDirty ? 1 : 0);
    }

    function getDirtyKeys() {
        return Array.from(dirty);
    }

    function setDirtyKeys(keys) {
        dirty.clear();
        (keys || []).forEach(k => dirty.add(k));
        render();
        notify();
    }

    function clearDirty() {
        dirty.clear();
        structuralDirty = false;
        render();
        notify();
    }

    function markSaved() {
        clearDirty();
    }

    function notify() {
        if (onChange) onChange(getDirtyCount());
    }

    function render() {
        renderTabs();
        renderTable();
    }

    function renderTabs() {
        if (!tabsEl) return;
        tabsEl.innerHTML = '';

        workbook.sheets.forEach((sheet, index) => {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'sheet-tab' + (index === activeIndex ? ' active' : '');
            tab.textContent = sheet.name || `Лист${index + 1}`;
            tab.addEventListener('click', () => {
                activeIndex = index;
                render();
            });
            tabsEl.appendChild(tab);
        });
    }

    function colName(n) {
        // 1 → A, 26 → Z, 27 → AA
        let name = '';
        let num = n;
        while (num > 0) {
            const rem = (num - 1) % 26;
            name = String.fromCharCode(65 + rem) + name;
            num = Math.floor((num - rem - 1) / 26);
        }
        return name;
    }

    function getGridSize(sheet) {
        const maxDataCols = sheet.data.reduce((max, row) => Math.max(max, row.length), 0);
        return {
            rows: Math.max(sheet.data.length, Number(sheet.rows) || 0, DEFAULT_ROWS),
            cols: Math.max(maxDataCols, Number(sheet.cols) || 0, DEFAULT_COLS)
        };
    }

    function colWidthPx(sheet, oneBased) {
        const width = sheet.colWidths && sheet.colWidths[String(oneBased)];
        if (!Number.isFinite(Number(width))) return MIN_COL_PX;
        // Ширина Excel ≈ символы, переводим в пиксели; явную можно сузить до пола
        return Math.max(MIN_COL_NARROW_PX, Math.round(Number(width) * 7 + 5));
    }

    function rowHeightPx(sheet, oneBased) {
        const h = sheet.rowHeights && sheet.rowHeights[String(oneBased)];
        if (!Number.isFinite(Number(h)) || Number(h) <= 0) return DEFAULT_ROW_PX;
        return Math.max(MIN_ROW_PX, Number(h));
    }

    function pxToChars(px) {
        return Math.round(((px - 5) / 7) * 100) / 100;
    }

    function getFont(sheet, r, c) {
        return (sheet.fonts && sheet.fonts[`${r}:${c}`]) || null;
    }

    function getMerges(sheet) {
        return Array.isArray(sheet.merges) ? sheet.merges : [];
    }

    // Карты объединений для отрисовки: якоря (с colspan/rowspan) и покрытые ячейки
    function buildMergeMaps(sheet, cols, rows) {
        const anchors = new Map();
        const covered = new Set();

        for (const m of getMerges(sheet)) {
            if (!m || !(m.r0 >= 0) || !(m.c0 >= 0) || m.r1 < m.r0 || m.c1 < m.c0) continue;
            anchors.set(`${m.r0}:${m.c0}`, m);
            for (let r = m.r0; r <= Math.min(m.r1, rows - 1); r++) {
                for (let c = m.c0; c <= Math.min(m.c1, cols - 1); c++) {
                    if (r !== m.r0 || c !== m.c0) covered.add(`${r}:${c}`);
                }
            }
        }

        return { anchors, covered };
    }

    const BORDER_CSS = '1pt solid #000';

    function applyBorder(td, b) {
        if (!b) return;
        if (b.left) td.style.borderLeft = BORDER_CSS;
        if (b.right) td.style.borderRight = BORDER_CSS;
        if (b.up) td.style.borderTop = BORDER_CSS;
        if (b.down) td.style.borderBottom = BORDER_CSS;
    }

    function applyFont(td, font) {
        if (!font) return;
        if (font.bold) td.style.fontWeight = '700';
        if (font.italic) td.style.fontStyle = 'italic';
        if (font.underline) td.style.textDecoration = 'underline';
        if (font.color) td.style.color = font.color;
        if (font.fill) td.style.backgroundColor = '#' + font.fill;
        if (font.size) td.style.fontSize = font.size + 'pt';
        if (font.name) td.style.fontFamily = font.name;
        if (font.url) {
            td.style.color = '#0563c1';
            td.style.textDecoration = 'underline';
        }
    }

    function renderTable() {
        if (!containerEl) return;
        containerEl.innerHTML = '';

        const sheet = getActiveSheet();
        if (!sheet) {
            const p = document.createElement('p');
            p.className = 'placeholder';
            p.textContent = 'Выберите файл из дерева слева';
            containerEl.appendChild(p);
            return;
        }

        const data = sheet.data;
        const { rows, cols } = getGridSize(sheet);

        const table = document.createElement('table');
        table.className = 'excel-table';

        const colgroup = document.createElement('colgroup');
        const cornerCol = document.createElement('col');
        cornerCol.style.width = ROW_HEADER_PX + 'px';
        colgroup.appendChild(cornerCol);

        let totalWidth = ROW_HEADER_PX;
        for (let c = 0; c < cols; c++) {
            const colEl = document.createElement('col');
            const width = colWidthPx(sheet, c + 1);
            colEl.dataset.col = String(c);
            colEl.style.width = width + 'px';
            totalWidth += width;
            colgroup.appendChild(colEl);
        }
        table.appendChild(colgroup);
        table.style.width = totalWidth + 'px';
        table.style.zoom = getZoom();

        // Заголовки: буквы столбцов + кнопка добавления
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const corner = document.createElement('th');
        corner.className = 'row-header';
        headRow.appendChild(corner);

        for (let c = 0; c < cols; c++) {
            const th = document.createElement('th');
            th.textContent = colName(c + 1);
            headRow.appendChild(th);
        }

        thead.appendChild(headRow);
        table.appendChild(thead);

        const merges = buildMergeMaps(sheet, cols, rows);

        const tbody = document.createElement('tbody');
        for (let r = 0; r < rows; r++) {
            const tr = document.createElement('tr');
            tr.dataset.row = String(r);

            const rowH = rowHeightPx(sheet, r + 1) !== DEFAULT_ROW_PX
                ? rowHeightPx(sheet, r + 1)
                : 0;
            if (rowH) tr.style.height = rowH + 'px';

            const rowHeader = document.createElement('th');
            rowHeader.className = 'row-header';
            rowHeader.textContent = String(r + 1);
            tr.appendChild(rowHeader);

            for (let c = 0; c < cols; c++) {
                const key = `${r}:${c}`;
                if (merges.covered.has(key)) continue;

                const td = document.createElement('td');
                const merge = merges.anchors.get(key);
                if (merge) {
                    td.colSpan = Math.min(merge.c1, cols - 1) - merge.c0 + 1;
                    td.rowSpan = Math.min(merge.r1, rows - 1) - merge.r0 + 1;
                }
                td.contentEditable = 'true';
                td.spellcheck = false;
                td.dataset.row = String(r);
                td.dataset.col = String(c);
                const cellText = data[r] && data[r][c] != null ? String(data[r][c]) : '';
                if (rowH) {
                    // Явная высота: оборачиваем, чтобы содержимое обрезалось, а не растягивало строку
                    const inner = document.createElement('div');
                    inner.className = 'cell-inner';
                    inner.style.maxHeight = Math.max(2, rowH - ROW_PADDING_PX) + 'px';
                    inner.textContent = cellText;
                    td.appendChild(inner);
                } else {
                    td.textContent = cellText;
                }

                applyFont(td, getFont(sheet, r, c));
                applyBorder(td, sheet.borders && sheet.borders[`${r}:${c}`]);
                if (dirty.has(cellKey(sheet, r, c))) td.classList.add('modified');

                td.addEventListener('input', () => commitCell(td, sheet, r, c));
                td.addEventListener('paste', (e) => {
                    // Вставляем только текст, сохраняя переводы строк
                    e.preventDefault();
                    const text = (e.clipboardData || window.clipboardData).getData('text');
                    document.execCommand('insertText', false, text.replace(/\r\n/g, '\n'));
                });

                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        containerEl.appendChild(table);
    }

    function cellKey(sheet, r, c) {
        return `${workbook.sheets.indexOf(sheet)}:${r}:${c}`;
    }

    function normalizeCellText(text) {
        return String(text || '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n+$/, '');
    }

    function commitCell(td, sheet, r, c) {
        const value = normalizeCellText(td.innerText);

        while (sheet.data.length <= r) sheet.data.push([]);
        const row = sheet.data[r];
        while (row.length <= c) row.push('');
        row[c] = value;

        dirty.add(cellKey(sheet, r, c));
        td.classList.add('modified');
        fitColumn(sheet, c);
        notify();
    }

    function fitColumn(sheet, c) {
        const colEl = containerEl.querySelector(`colgroup col[data-col="${c}"]`);
        if (!colEl) return;

        // <col> не имеет собственного бокса — меряем реальную ячейку,
        // с учётом масштаба таблицы
        const sample = containerEl.querySelector(`tbody td[data-col="${c}"]`);
        const current = sample
            ? sample.getBoundingClientRect().width / getZoom()
            : MIN_COL_PX;
        // Не расширяем колонку, пока текст помещается в текущую ширину
        let needed = current || MIN_COL_PX;

        const cells = containerEl.querySelectorAll(`tbody td[data-col="${c}"]`);
        for (const cell of cells) {
            const text = cell.innerText;
            if (!text) continue;

            measureCtx.font = getComputedStyle(cell).font;
            for (const line of text.split('\n')) {
                const width = measureCtx.measureText(line).width + PADDING_PX;
                if (width > needed) needed = width;
            }
        }

        if (needed > current + 1) {
            const widthPx = Math.ceil(needed);
            colEl.style.width = widthPx + 'px';
            sheet.colWidths = sheet.colWidths || {};
            sheet.colWidths[String(c + 1)] = pxToChars(widthPx);
            structuralDirty = true;
            updateTableWidth();
        }
    }

    function updateTableWidth() {
        const table = containerEl.querySelector('table.excel-table');
        if (!table) return;

        let total = ROW_HEADER_PX;
        table.querySelectorAll('colgroup col[data-col]').forEach(col => {
            total += parseFloat(col.style.width) || MIN_COL_PX;
        });
        table.style.width = total + 'px';
    }

    // ---------- API для команд ----------

    function getGrid() {
        const sheet = getActiveSheet();
        return sheet ? getGridSize(sheet) : { rows: 0, cols: 0 };
    }

    function ensureSize(rows, cols) {
        const sheet = getActiveSheet();
        if (!sheet) return;

        const size = getGridSize(sheet);
        if (rows > size.rows) {
            sheet.rows = rows;
            structuralDirty = true;
        }
        if (cols > size.cols) {
            sheet.cols = cols;
            structuralDirty = true;
        }
    }

    function getCellValue(r, c) {
        const sheet = getActiveSheet();
        if (!sheet || !sheet.data[r]) return '';
        return sheet.data[r][c] != null ? String(sheet.data[r][c]) : '';
    }

    function setCellValue(r, c, value) {
        const sheet = getActiveSheet();
        if (!sheet) return;

        ensureSize(r + 1, c + 1);
        while (sheet.data.length <= r) sheet.data.push([]);
        const row = sheet.data[r];
        while (row.length <= c) row.push('');
        row[c] = value;

        dirty.add(cellKey(sheet, r, c));
    }

    function getCellFont(r, c) {
        const sheet = getActiveSheet();
        if (!sheet) return null;
        return getFont(sheet, r, c);
    }

    function setCellFont(r, c, font) {
        const sheet = getActiveSheet();
        if (!sheet) return;

        ensureSize(r + 1, c + 1);
        sheet.fonts = sheet.fonts || {};
        const key = `${r}:${c}`;
        if (font && Object.keys(font).length) sheet.fonts[key] = font;
        else delete sheet.fonts[key];

        dirty.add(cellKey(sheet, r, c));
    }

    function remapIndex(old, from, to) {
        if (old === from) return to;
        const index = old < from ? old : old - 1;
        return index >= to ? index + 1 : index;
    }

    // ---------- объединения: поддержание sheet.merges при структуре ----------

    function shiftMergesInsert(sheet, isRow, at) {
        const list = getMerges(sheet);
        if (!list.length) return;
        const k0 = isRow ? 'r0' : 'c0';
        const k1 = isRow ? 'r1' : 'c1';
        sheet.merges = list.map(m => {
            if (m[k0] < at && at <= m[k1]) return Object.assign({}, m, { [k1]: m[k1] + 1 });
            if (m[k0] >= at) return Object.assign({}, m, { [k0]: m[k0] + 1, [k1]: m[k1] + 1 });
            return m;
        });
    }

    function shiftMergesDelete(sheet, isRow, at) {
        const list = getMerges(sheet);
        if (!list.length) return;
        const k0 = isRow ? 'r0' : 'c0';
        const k1 = isRow ? 'r1' : 'c1';
        sheet.merges = list
            .filter(m => !(m[k0] <= at && at <= m[k1]))
            .map(m => m[k0] > at ? Object.assign({}, m, { [k0]: m[k0] - 1, [k1]: m[k1] - 1 }) : m);
    }

    function shiftMergesMove(sheet, isRow, from, to) {
        const list = getMerges(sheet);
        if (!list.length) return;
        const k0 = isRow ? 'r0' : 'c0';
        const k1 = isRow ? 'r1' : 'c1';
        sheet.merges = list.map(m => {
            const a = remapIndex(m[k0], from, to);
            const b = remapIndex(m[k1], from, to);
            return Object.assign({}, m, { [k0]: Math.min(a, b), [k1]: Math.max(a, b) });
        });
    }

    function insertColumnAt(index) {
        const sheet = getActiveSheet();
        if (!sheet) return;

        const { rows, cols } = getGridSize(sheet);
        const at = Math.max(0, Math.min(cols, index));

        // В конец столбца просто увеличиваем сетку, не раздувая data
        if (at < cols) {
            for (const row of sheet.data) row.splice(at, 0, '');
        }

        const widths = {};
        for (const [key, value] of Object.entries(sheet.colWidths || {})) {
            const n = Number(key) - 1;
            widths[String(n >= at ? n + 2 : n + 1)] = value;
        }
        sheet.colWidths = widths;

        const fonts = {};
        for (const [key, value] of Object.entries(sheet.fonts || {})) {
            const [r, c] = key.split(':').map(Number);
            fonts[`${r}:${c >= at ? c + 1 : c}`] = value;
        }
        sheet.fonts = fonts;

        shiftMergesInsert(sheet, false, at);

        sheet.cols = cols + 1;
        structuralDirty = true;
    }

    function insertRowAt(index) {
        const sheet = getActiveSheet();
        if (!sheet) return;

        const { rows } = getGridSize(sheet);
        const at = Math.max(0, Math.min(rows, index));

        // В конец добавляем только видимую строку
        if (at < sheet.data.length) {
            sheet.data.splice(at, 0, []);
        }

        const fonts = {};
        for (const [key, value] of Object.entries(sheet.fonts || {})) {
            const [r, c] = key.split(':').map(Number);
            fonts[`${r >= at ? r + 1 : r}:${c}`] = value;
        }
        sheet.fonts = fonts;

        shiftMergesInsert(sheet, true, at);

        sheet.rows = rows + 1;
        structuralDirty = true;
    }

    function moveColumn(from, to) {
        const sheet = getActiveSheet();
        if (!sheet) return false;

        const { cols } = getGridSize(sheet);
        if (from < 0 || from >= cols || to < 0 || to >= cols || from === to) return false;

        for (const row of sheet.data) {
            if (from >= row.length && to >= row.length) continue;
            const value = from < row.length ? row.splice(from, 1)[0] : '';
            while (row.length < to) row.push('');
            row.splice(to, 0, value);
        }

        const widths = {};
        for (const [key, value] of Object.entries(sheet.colWidths || {})) {
            const c = Number(key) - 1;
            widths[String(remapIndex(c, from, to) + 1)] = value;
        }
        sheet.colWidths = widths;

        const fonts = {};
        for (const [key, value] of Object.entries(sheet.fonts || {})) {
            const [r, c] = key.split(':').map(Number);
            fonts[`${r}:${remapIndex(c, from, to)}`] = value;
        }
        sheet.fonts = fonts;

        shiftMergesMove(sheet, false, from, to);

        structuralDirty = true;
        return true;
    }

    function moveRow(from, to) {
        const sheet = getActiveSheet();
        if (!sheet) return false;

        const { rows } = getGridSize(sheet);
        if (from < 0 || from >= rows || to < 0 || to >= rows || from === to) return false;

        if (from < sheet.data.length) {
            const row = sheet.data.splice(from, 1)[0];
            // Цель может лежать за пределами data (пустые строки сетки) —
            // достраиваем data до нужной позиции, иначе строка встанет в конец data
            while (sheet.data.length < to) sheet.data.push([]);
            sheet.data.splice(to, 0, row);
        }

        const fonts = {};
        for (const [key, value] of Object.entries(sheet.fonts || {})) {
            const [r, c] = key.split(':').map(Number);
            fonts[`${remapIndex(r, from, to)}:${c}`] = value;
        }
        sheet.fonts = fonts;

        shiftMergesMove(sheet, true, from, to);

        structuralDirty = true;
        return true;
    }

    function deleteColumnAt(index) {
        const sheet = getActiveSheet();
        if (!sheet) return false;

        const { cols } = getGridSize(sheet);
        if (index < 0 || index >= cols || cols <= 1) return false;

        for (const row of sheet.data) {
            if (index < row.length) row.splice(index, 1);
        }

        const widths = {};
        for (const [key, value] of Object.entries(sheet.colWidths || {})) {
            const c = Number(key) - 1;
            if (c === index) continue;
            widths[String(c > index ? c : c + 1)] = value;
        }
        sheet.colWidths = widths;

        const fonts = {};
        for (const [key, value] of Object.entries(sheet.fonts || {})) {
            const parts = key.split(':').map(Number);
            if (parts[1] === index) continue;
            fonts[`${parts[0]}:${parts[1] > index ? parts[1] - 1 : parts[1]}`] = value;
        }
        sheet.fonts = fonts;

        shiftMergesDelete(sheet, false, index);

        sheet.cols = cols - 1;
        structuralDirty = true;
        return true;
    }

    function deleteRowAt(index) {
        const sheet = getActiveSheet();
        if (!sheet) return false;

        const { rows } = getGridSize(sheet);
        if (index < 0 || index >= rows || rows <= 1) return false;

        if (index < sheet.data.length) sheet.data.splice(index, 1);

        const fonts = {};
        for (const [key, value] of Object.entries(sheet.fonts || {})) {
            const parts = key.split(':').map(Number);
            if (parts[0] === index) continue;
            fonts[`${parts[0] > index ? parts[0] - 1 : parts[0]}:${parts[1]}`] = value;
        }
        sheet.fonts = fonts;

        shiftMergesDelete(sheet, true, index);

        sheet.rows = rows - 1;
        structuralDirty = true;
        return true;
    }

    // ---------- ширина/высота: scale-хелперы для width|height|size ----------

    function scaleColumnWidth(oneBased, factor) {
        const sheet = getActiveSheet();
        if (!sheet) return;
        const px = colWidthPx(sheet, oneBased) * factor;
        sheet.colWidths = sheet.colWidths || {};
        sheet.colWidths[String(oneBased)] = pxToChars(px);
        structuralDirty = true;
    }

    // Суммарная ширина диапазона столбцов × factor, поровну на каждый столбец
    function scaleColumnsEqual(c0, c1, factor) {
        const sheet = getActiveSheet();
        if (!sheet) return;
        let total = 0;
        for (let c = c0; c <= c1; c++) total += colWidthPx(sheet, c + 1);
        const per = total * factor / (c1 - c0 + 1);
        sheet.colWidths = sheet.colWidths || {};
        for (let c = c0; c <= c1; c++) sheet.colWidths[String(c + 1)] = pxToChars(per);
        structuralDirty = true;
    }

    function scaleRowHeight(oneBased, factor) {
        const sheet = getActiveSheet();
        if (!sheet) return;
        sheet.rowHeights = sheet.rowHeights || {};
        const px = Math.max(MIN_ROW_PX, Math.round(rowHeightPx(sheet, oneBased) * factor));
        sheet.rowHeights[String(oneBased)] = px;
        structuralDirty = true;
    }

    function scaleRowsEqual(r0, r1, factor) {
        const sheet = getActiveSheet();
        if (!sheet) return;
        let total = 0;
        for (let r = r0; r <= r1; r++) total += rowHeightPx(sheet, r + 1);
        const per = Math.max(MIN_ROW_PX, Math.round(total * factor / (r1 - r0 + 1)));
        sheet.rowHeights = sheet.rowHeights || {};
        for (let r = r0; r <= r1; r++) sheet.rowHeights[String(r + 1)] = per;
        structuralDirty = true;
    }

    // normalize: ширины столбцов по тексту, высоты строк — снова авто
    function normalizeSizes() {
        const sheet = getActiveSheet();
        if (!sheet) return;

        render();
        const { cols } = getGridSize(sheet);
        const sample = containerEl && containerEl.querySelector('tbody td');
        measureCtx.font = sample ? getComputedStyle(sample).font : '14px sans-serif';

        const widths = {};
        for (let c = 0; c < cols; c++) {
            let needed = MIN_COL_NARROW_PX;
            for (const row of sheet.data) {
                const text = row && row[c];
                if (text == null || text === '') continue;
                for (const line of String(text).split('\n')) {
                    const width = measureCtx.measureText(line).width + PADDING_PX;
                    if (width > needed) needed = width;
                }
            }
            widths[String(c + 1)] = pxToChars(Math.ceil(needed));
        }

        sheet.colWidths = widths;
        sheet.rowHeights = {};
        structuralDirty = true;
    }

    // ---------- масштаб (wheel), хранится в sheet.zoom, в xlsx не едет ----------

    function clampZoom(value) {
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    }

    function getZoom() {
        const sheet = getActiveSheet();
        const z = Number(sheet && sheet.zoom);
        return Number.isFinite(z) && z > 0 ? clampZoom(z) : 1;
    }

    function setZoom(value) {
        const sheet = getActiveSheet();
        if (!sheet) return 1;

        const z = clampZoom(Number(value) || 1);
        if (Number(sheet.zoom) === z) return z;

        if (z === 1) delete sheet.zoom;
        else sheet.zoom = Math.round(z * 100) / 100;

        const table = containerEl && containerEl.querySelector('table.excel-table');
        if (table) table.style.zoom = z;

        structuralDirty = true;
        notify();
        return z;
    }

    // ---------- border: рамки по периметру области ----------

    function setBorders(ranges, sides) {
        const sheet = getActiveSheet();
        if (!sheet) return;

        sheet.borders = sheet.borders || {};
        for (const rg of ranges) {
            for (let r = rg.r0; r <= rg.r1; r++) {
                for (let c = rg.c0; c <= rg.c1; c++) {
                    const key = `${r}:${c}`;
                    const b = sheet.borders[key] || (sheet.borders[key] = {});
                    if (r === rg.r0 && sides.has('up')) b.up = 1;
                    if (r === rg.r1 && sides.has('down')) b.down = 1;
                    if (c === rg.c0 && sides.has('left')) b.left = 1;
                    if (c === rg.c1 && sides.has('right')) b.right = 1;
                    if (!b.up && !b.down && !b.left && !b.right) delete sheet.borders[key];
                }
            }
        }

        structuralDirty = true;
    }

    function clearBorders(ranges) {
        const sheet = getActiveSheet();
        if (!sheet || !sheet.borders) return;

        for (const rg of ranges) {
            for (let r = rg.r0; r <= rg.r1; r++) {
                for (let c = rg.c0; c <= rg.c1; c++) delete sheet.borders[`${r}:${c}`];
            }
        }

        structuralDirty = true;
    }

    // ---------- union / split ----------

    function mergeCells(r0, c0, r1, c1) {
        const sheet = getActiveSheet();
        if (!sheet || !(r0 >= 0) || !(c0 >= 0) || r1 < r0 || c1 < c0) return false;

        ensureSize(r1 + 1, c1 + 1);

        // Площадь забирает якорь (верхняя левая ячейка), остальных очищаем
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                if (r === r0 && c === c0) continue;
                if (sheet.data[r] && sheet.data[r][c]) {
                    sheet.data[r][c] = '';
                    dirty.add(cellKey(sheet, r, c));
                }
            }
        }

        const kept = getMerges(sheet).filter(m =>
            m && !(r0 <= m.r1 && m.r0 <= r1 && c0 <= m.c1 && m.c0 <= c1));
        kept.push({ r0, c0, r1, c1 });
        sheet.merges = kept;

        structuralDirty = true;
        return true;
    }

    function splitCells(r0, c0, r1, c1) {
        const sheet = getActiveSheet();
        if (!sheet) return false;

        const list = getMerges(sheet);
        const index = list.findIndex(m =>
            m && m.r0 === r0 && m.c0 === c0 && m.r1 === r1 && m.c1 === c1);
        if (index < 0) return false;

        list.splice(index, 1);
        if (list.length) sheet.merges = list;
        else delete sheet.merges;

        structuralDirty = true;
        return true;
    }

    function refresh() {
        render();

        const sheet = getActiveSheet();
        if (sheet) {
            const { cols } = getGridSize(sheet);
            for (let c = 0; c < cols; c++) fitColumn(sheet, c);
        }
        notify();
    }

    return {
        init,
        emptyWorkbook,
        setWorkbook,
        getWorkbook,
        getActiveSheet,
        getActiveIndex,
        setActiveIndex,
        hasChanges,
        isStructuralDirty,
        setStructuralDirty,
        getDirtyCount,
        getDirtyKeys,
        setDirtyKeys,
        clearDirty,
        markSaved,
        getGrid,
        ensureSize,
        getCellValue,
        setCellValue,
        getCellFont,
        setCellFont,
        insertColumnAt,
        insertRowAt,
        moveColumn,
        moveRow,
        deleteColumnAt,
        deleteRowAt,
        mergeCells,
        splitCells,
        scaleColumnWidth,
        scaleColumnsEqual,
        scaleRowHeight,
        scaleRowsEqual,
        normalizeSizes,
        getZoom,
        setZoom,
        setBorders,
        clearBorders,
        refresh
    };
})();
