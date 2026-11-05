/**
 * Converter — JSON ↔ XLSX через ExcelJS
 * 
 * Формат JSON:
 * {
 *   "sheets": [
 *     {
 *       "name": "Лист1",
 *       "data": [["r1c1","r1c2"],["r2c1","r2c2"]],
 *       "fonts": { "0:0": { "bold": true, "fill": "FF0000" } },
 *       "colWidths": { "1": 16.45, "2": 10.27 },
 *       "rowHeights": { "1": 40 },
 *       "merges": [ { "r0": 0, "c0": 0, "r1": 0, "c1": 1 } ]
 *     }
 *   ]
 * }
 * fonts/colWidths/rowHeights/merges необязательны: старые файлы { name, data } читаются как есть.
 * fill в fonts — цвет фона ячейки, RRGGBB. rowHeights — высота строки в px.
 * borders — рамки "r:c" → {up,down,left,right}, в xlsx как thin (1pt черная).
 * zoom (масштаб экрана) в xlsx не экспортируется.
 */
const Converter = (() => {

    function cellText(value) {
        if (value === null || value === undefined) return '';
        if (value instanceof Date) return value.toISOString();
        if (typeof value === 'object' && value.richText) {
            return value.richText.map(t => t.text).join('');
        }
        if (typeof value === 'object' && value.result !== undefined) return String(value.result);
        if (typeof value === 'object' && value.text) return String(value.text);
        return String(value);
    }

    function fontToJson(font) {
        if (!font) return null;

        const out = {};
        if (font.bold) out.bold = true;
        if (font.italic) out.italic = true;
        if (font.underline) out.underline = true;
        if (typeof font.size === 'number' && font.size !== 11) out.size = font.size;
        if (font.name && font.name !== 'Calibri') out.name = font.name;
        if (font.color && font.color.argb) {
            out.color = '#' + String(font.color.argb).slice(-6).toUpperCase();
        }
        return Object.keys(out).length ? out : null;
    }

    function fontFromJson(font) {
        const out = {};
        if (font.bold) out.bold = true;
        if (font.italic) out.italic = true;
        if (font.underline) out.underline = true;
        if (font.size) out.size = font.size;
        if (font.name) out.name = font.name;
        if (font.color) out.color = { argb: 'FF' + String(font.color).replace('#', '').toUpperCase() };
        if (font.url) {
            out.color = out.color || { argb: 'FF0563C1' };
            out.underline = true;
        }
        return out;
    }

    function decodeColLetters(letters) {
        let value = 0;
        for (const ch of String(letters).toUpperCase()) {
            value = value * 26 + (ch.charCodeAt(0) - 64);
        }
        return value;
    }

    // Модель ExcelJS хранит объединения строками вида "A1:B2"
    function readMerges(ws) {
        const out = [];
        const list = (ws.model && Array.isArray(ws.model.merges)) ? ws.model.merges : [];
        for (const ref of list) {
            const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(String(ref));
            if (!m) continue;
            out.push({
                r0: Number(m[2]) - 1, c0: decodeColLetters(m[1]) - 1,
                r1: Number(m[4]) - 1, c1: decodeColLetters(m[3]) - 1
            });
        }
        return out;
    }

    /**
     * XLSX (ArrayBuffer) → JSON-строка
     * @param {ArrayBuffer} buffer
     * @returns {Promise<string>} — JSON-строка
     */
    async function xlsxToJson(buffer) {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);

        const sheets = [];
        workbook.eachSheet((ws) => {
            const data = [];
            const fonts = {};
            const rowHeights = {};
            const borders = {};

            ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
                // высота Excel в пунктах, у нас — пиксели
                if (typeof row.height === 'number' && row.height > 0) {
                    rowHeights[String(rowNumber)] = Math.round(row.height / 0.75);
                }
                const rowData = [];
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    rowData.push(cellText(cell.value));
                    const font = fontToJson(cell.font) || {};
                    if (cell.value && typeof cell.value === 'object' && cell.value.hyperlink) {
                        font.url = true;
                    }
                    const fill = cell.fill;
                    if (fill && fill.type === 'pattern' && fill.pattern === 'solid' &&
                        fill.fgColor && fill.fgColor.argb) {
                        font.fill = String(fill.fgColor.argb).slice(-6).toUpperCase();
                    }
                    const bd = cell.border;
                    if (bd && (bd.top || bd.bottom || bd.left || bd.right)) {
                        const entry = {};
                        if (bd.top && bd.top.style) entry.up = 1;
                        if (bd.bottom && bd.bottom.style) entry.down = 1;
                        if (bd.left && bd.left.style) entry.left = 1;
                        if (bd.right && bd.right.style) entry.right = 1;
                        if (Object.keys(entry).length) {
                            borders[`${rowNumber - 1}:${colNumber - 1}`] = entry;
                        }
                    }
                    if (Object.keys(font).length) {
                        fonts[`${rowNumber - 1}:${colNumber - 1}`] = font;
                    }
                });
                data.push(rowData);
            });

            const colWidths = {};
            const maxCol = Math.max(ws.columnCount || 0, (ws.columns && ws.columns.length) || 0);
            for (let i = 1; i <= maxCol; i++) {
                const width = ws.getColumn(i).width;
                if (typeof width === 'number' && width > 0) {
                    colWidths[String(i)] = Math.round(width * 10000) / 10000;
                }
            }

            const sheet = { name: ws.name, data };
            if (Object.keys(fonts).length) sheet.fonts = fonts;
            if (Object.keys(colWidths).length) sheet.colWidths = colWidths;
            if (Object.keys(rowHeights).length) sheet.rowHeights = rowHeights;
            if (Object.keys(borders).length) sheet.borders = borders;
            const merges = readMerges(ws);
            if (merges.length) sheet.merges = merges;
            sheets.push(sheet);
        });

        return JSON.stringify({ sheets }, null, 2);
    }

    /**
     * JSON (объект) → XLSX (ArrayBuffer)
     * @param {{sheets: Array<{name: string, data: string[][], fonts?: object, colWidths?: object}>}} json
     * @returns {Promise<ArrayBuffer>}
     */
    async function jsonToXlsx(json) {
        const workbook = new ExcelJS.Workbook();

        for (const sheet of json.sheets) {
            const ws = workbook.addWorksheet(sheet.name || 'Sheet');
            for (const rowData of sheet.data) {
                ws.addRow(rowData);
            }

            for (const [key, font] of Object.entries(sheet.fonts || {})) {
                const [r, c] = key.split(':').map(Number);
                if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
                const cell = ws.getCell(r + 1, c + 1);
                cell.font = Object.assign({}, cell.font || {}, fontFromJson(font));
                if (font.fill) {
                    cell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'FF' + String(font.fill).replace('#', '').toUpperCase() }
                    };
                }
            }

            for (const [col, width] of Object.entries(sheet.colWidths || {})) {
                const index = Number(col);
                if (Number.isInteger(index) && index > 0) {
                    ws.getColumn(index).width = Number(width);
                }
            }

            for (const [row, height] of Object.entries(sheet.rowHeights || {})) {
                const index = Number(row);
                const h = Number(height);
                if (Number.isInteger(index) && index > 0 && Number.isFinite(h) && h > 0) {
                    ws.getRow(index).height = Math.round(h * 0.75 * 100) / 100; // px → pt
                }
            }

            for (const [key, b] of Object.entries(sheet.borders || {})) {
                const parts = key.split(':').map(Number);
                if (!Number.isInteger(parts[0]) || !Number.isInteger(parts[1])) continue;
                const cell = ws.getCell(parts[0] + 1, parts[1] + 1);
                const border = cell.border || {};
                const thin = { style: 'thin', color: { argb: 'FF000000' } };
                if (b.up) border.top = thin;
                if (b.down) border.bottom = thin;
                if (b.left) border.left = thin;
                if (b.right) border.right = thin;
                cell.border = border;
            }

            for (const m of sheet.merges || []) {
                const r1 = Number(m.r0) + 1;
                const c1 = Number(m.c0) + 1;
                const r2 = Number(m.r1) + 1;
                const c2 = Number(m.c1) + 1;
                if (!(r1 >= 1) || !(c1 >= 1) || r2 < r1 || c2 < c1) continue;

                // В xlsx рамку объединённой ячейки задаёт только мастер-ячейка,
                // поэтому собираем внешний периметр со всех ячеек диапазона.
                const at = (r, c) => (sheet.borders || {})[`${r}:${c}`] || {};
                const outer = {};
                for (let c = m.c0; c <= m.c1; c++) {
                    if (at(m.r0, c).up) outer.up = 1;
                    if (at(m.r1, c).down) outer.down = 1;
                }
                for (let r = m.r0; r <= m.r1; r++) {
                    if (at(r, m.c0).left) outer.left = 1;
                    if (at(r, m.c1).right) outer.right = 1;
                }

                const thin = { style: 'thin', color: { argb: 'FF000000' } };
                const border = {};
                if (outer.up) border.top = thin;
                if (outer.down) border.bottom = thin;
                if (outer.left) border.left = thin;
                if (outer.right) border.right = thin;
                ws.getCell(r1, c1).border = border;

                try {
                    ws.mergeCells(r1, c1, r2, c2);
                } catch (e) {
                    // некорректный диапазон пропускаем, лист не роняем
                }
            }
        }

        const buffer = await workbook.xlsx.writeBuffer();
        return buffer;
    }

    /**
     * Скачать файл в браузере
     * @param {ArrayBuffer} buffer
     * @param {string} filename
     */
    function download(buffer, filename) {
        const blob = new Blob([buffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Прочитать файл как ArrayBuffer
     * @param {File} file
     * @returns {Promise<ArrayBuffer>}
     */
    function readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Парсить JSON-строку в структуру
     * @param {string} text
     * @returns {{sheets: Array}}
     */
    function parse(text) {
        const obj = JSON.parse(text);
        if (!obj.sheets || !Array.isArray(obj.sheets)) {
            throw new Error('Неверный формат: ожидается { "sheets": [...] }');
        }
        for (const s of obj.sheets) {
            if (!Array.isArray(s.data)) s.data = [];
            if (!s.name) s.name = 'Sheet';
            if (!s.fonts || typeof s.fonts !== 'object') s.fonts = {};
            if (!s.colWidths || typeof s.colWidths !== 'object') s.colWidths = {};
        }
        return obj;
    }

    return { xlsxToJson, jsonToXlsx, download, readFile, parse };
})();