/**
 * Complete — автодополнение команд по commands.yaml
 *
 * Ищет по текущему слову (разделитель — пробел), как только введено
 * хотя бы 1 письмо. Tab (→) подставляет кандидата текстом в поле.
 */
const Complete = (() => {
    let dict = { words: [], syntax: [] };
    let inputEl = null;
    let hintEl = null;

    // Минимальный YAML: секции words:/syntax:/help: со списком "- item"
    function parse(text) {
        const out = { words: [], syntax: [], help: [] };
        let section = null;

        for (const rawLine of String(text || '').split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;

            if (line.startsWith('-')) {
                const item = line.replace(/^-\s*/, '').replace(/^["']|["']$/g, '').trim();
                if (section && item) out[section].push(item);
                continue;
            }

            const sep = line.indexOf(':');
            if (sep === -1) continue;

            const key = line.slice(0, sep).trim();
            section = key === 'words' || key === 'syntax' || key === 'help' ? key : null;
        }

        return out;
    }

    async function load(path) {
        try {
            const res = await fetch(path || 'commands.yaml', { cache: 'no-store' });
            if (!res.ok) throw new Error(String(res.status));
            dict = parse(await res.text());
        } catch (e) {
            // нет справочника — нет подсказок, не критично
            dict = { words: [], syntax: [] };
        }
        return dict;
    }

    function currentToken(value, caret) {
        const upto = value.slice(0, caret);
        return upto.slice(upto.lastIndexOf(' ') + 1);
    }

    // Кандидат для слова под кареткой (по умолчанию — в конце строки)
    function suggest(value, caret) {
        const token = currentToken(value, caret == null ? value.length : caret);
        if (!token) return null;
        // ссылки на ячейки и числа не дополняем
        if (!/^[A-Za-z\u0410-\u044F\u0401\u0451]+$/.test(token)) return null;

        const lower = token.toLowerCase();
        for (const word of dict.words) {
            const w = String(word);
            if (w.toLowerCase().startsWith(lower) && w.toLowerCase() !== lower) return w;
        }
        return null;
    }

    function refreshHint() {
        if (!inputEl || !hintEl) return;
        const caret = inputEl.selectionStart == null ? inputEl.value.length : inputEl.selectionStart;
        const word = suggest(inputEl.value, caret);
        hintEl.textContent = word ? 'Tab → ' + word : '';
    }

    // Подставить текущего кандидата; true, если подставили
    function applySuggestion() {
        if (!inputEl) return false;

        const caret = inputEl.selectionStart == null ? inputEl.value.length : inputEl.selectionStart;
        const token = currentToken(inputEl.value, caret);
        const word = suggest(inputEl.value, caret);
        if (!word) return false;

        const before = inputEl.value.slice(0, caret - token.length);
        inputEl.value = before + word + inputEl.value.slice(caret);
        const pos = before.length + word.length;
        if (inputEl.setSelectionRange) inputEl.setSelectionRange(pos, pos);
        refreshHint();
        return true;
    }

    function attach(input, hint) {
        inputEl = input;
        hintEl = hint;
        if (!inputEl) return;

        inputEl.addEventListener('input', refreshHint);
        inputEl.addEventListener('click', refreshHint);
        inputEl.addEventListener('blur', () => { if (hintEl) hintEl.textContent = ''; });
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Tab' && applySuggestion()) e.preventDefault();
        });
    }

    // Строки справки для баннера help: "синтаксис — описание"
    function getHelp() {
        return dict.help.slice();
    }

    return { load, parse, suggest, applySuggestion, refreshHint, attach, getHelp };
})();