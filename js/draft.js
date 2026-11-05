/**
 * Draft — черновик несохранённых изменений в localStorage
 * Ключ привязан к URL SPA (origin + pathname).
 */
const Draft = (() => {
    let timer = null;

    function key() {
        return 'excel-viewer:draft:' + location.origin + location.pathname;
    }

    function save(state) {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                localStorage.setItem(key(), JSON.stringify({
                    workbook: state.workbook,
                    dirtyKeys: state.dirtyKeys || [],
                    structuralDirty: !!state.structuralDirty,
                    activeIndex: state.activeIndex || 0,
                    core: state.core || null,
                    savedAt: new Date().toISOString()
                }));
            } catch (e) {
                // localStorage может быть недоступен или переполнен — не мешаем работе
            }
        }, 300);
    }

    function load() {
        try {
            const raw = localStorage.getItem(key());
            if (!raw) return null;
            const state = JSON.parse(raw);
            if (!state || !state.workbook) return null;
            return state;
        } catch (e) {
            return null;
        }
    }

    function clear() {
        clearTimeout(timer);
        try {
            localStorage.removeItem(key());
        } catch (e) {
            // ignore
        }
    }

    return { key, save, load, clear };
})();
