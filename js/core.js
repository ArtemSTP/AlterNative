/**
 * Core — оркестратор: связывает адаптер, конвертер, дерево и таблицу
 */
const Core = (() => {
    let setStatus = () => {};
    let api = GitLabAPI;
    let mode = 'gitlab';
    let folder = '';
    let treeItems = [];

    let currentPath = null;
    let baseCommitId = null;
    let forceCreate = false;

    function init(options) {
        const opts = options || {};
        if (opts.status) setStatus = opts.status;

        if (opts.mode === 'local') {
            mode = 'local';
            api = LocalAPI;
            LocalAPI.init(opts.localUrl);
            folder = '';
        } else {
            mode = 'gitlab';
            api = GitLabAPI;
        }
    }

    function status(text, cls) {
        setStatus(text, cls);
    }

    function getMode() {
        return mode;
    }

    function getCurrentPath() {
        return currentPath;
    }

    function getTreeItems() {
        return treeItems;
    }

    function normalizePath(value) {
        let path = String(value || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
        path = path.replace(/^\/+/, '');
        if (!path) return '';

        const parts = path.split('/');
        if (parts.some(p => !p || p === '.' || p === '..')) return '';

        if (!/\.json$/i.test(path)) path += '.json';
        return path;
    }

    function ensureReady() {
        if (!api.isInitialized()) {
            throw new Error(mode === 'local'
                ? 'Локальный сервис не настроен. Проверьте local_api в config.yaml.'
                : 'Сначала загрузите проект GitLab (URL и Private Token).');
        }
    }

    async function reloadTree() {
        ensureReady();
        status('Загрузка дерева файлов…', 'saving');
        const items = await api.getTree(mode === 'local' ? '' : folder);
        treeItems = items;
        TreeView.render(items);

        const files = items.filter(i => i.type === 'blob');
        status(`Файлов JSON: ${files.length}`, 'saved');
        return items;
    }

    async function loadProject({ projectUrl, token, ref, folder: projectFolder }) {
        if (mode === 'local') {
            return reloadTree();
        }

        if (!projectUrl || !token) {
            throw new Error('Укажите URL проекта и Private Token');
        }

        GitLabAPI.init(projectUrl, token, ref);
        folder = (projectFolder || '').replace(/^\/+|\/+$/g, '');

        // Документ предыдущего проекта больше не актуален
        currentPath = null;
        baseCommitId = null;
        forceCreate = false;
        SheetView.setWorkbook(SheetView.emptyWorkbook());

        return reloadTree();
    }

    async function openFile(path) {
        ensureReady();
        status(`Чтение ${path}…`, 'saving');
        const file = await api.readFile(path);
        const json = Converter.parse(file.content);

        SheetView.setWorkbook(json);
        currentPath = path;
        baseCommitId = file.lastCommitId;
        forceCreate = false;

        status(`${path} — листов: ${json.sheets.length}`, 'saved');
        return true;
    }

    function buildJson() {
        return JSON.stringify(SheetView.getWorkbook(), null, 2) + '\n';
    }

    async function save() {
        ensureReady();
        if (!currentPath) {
            throw new Error('Не указан путь сохранения');
        }

        // Если базовая версия неизвестна — узнаём актуальный last_commit_id,
        // чтобы не перезаписать чужие правки вслепую.
        let commitId = baseCommitId;
        if (!commitId && !forceCreate) {
            try {
                commitId = (await api.readFile(currentPath)).lastCommitId;
            } catch (e) {
                if (e.status !== 404) throw e;
                forceCreate = true;
            }
        }

        status('Сохранение…', 'saving');
        await api.saveFile(
            currentPath,
            buildJson(),
            `Update ${currentPath} via Excel Viewer`,
            commitId,
            forceCreate
        );

        // Обновляем базовую версию, чтобы следующий коммит делался поверх нашего.
        baseCommitId = null;
        forceCreate = false;
        try {
            baseCommitId = (await api.readFile(currentPath)).lastCommitId;
        } catch (e) {
            // Не критично: при следующем сохранении id будет запрошен заново.
        }

        SheetView.markSaved();
        status(`Сохранено: ${currentPath}`, 'saved');
        return currentPath;
    }

    async function pathExists(path) {
        ensureReady();
        try {
            await api.readFile(normalizePath(path));
            return true;
        } catch (e) {
            if (e.status === 404) return false;
            throw e;
        }
    }

    async function saveAs(path) {
        ensureReady();
        const target = normalizePath(path);
        if (!target) throw new Error('Недопустимый путь сохранения');

        currentPath = target;
        baseCommitId = null;
        forceCreate = false;

        try {
            const existing = await api.readFile(target);
            baseCommitId = existing.lastCommitId;
        } catch (e) {
            if (e.status !== 404) {
                currentPath = null;
                throw e;
            }
            forceCreate = true;
        }

        return save();
    }

    async function importXlsx(file) {
        if (!/\.xlsx$/i.test(file.name)) {
            throw new Error('Поддерживается только формат .xlsx');
        }

        status(`Чтение ${file.name}…`, 'saving');
        const buffer = await Converter.readFile(file);
        const json = Converter.parse(await Converter.xlsxToJson(buffer));

        SheetView.setWorkbook(json);
        currentPath = null;
        baseCommitId = null;
        forceCreate = false;

        status(`Импортирован ${file.name}. Нажмите «Сохранить», чтобы выбрать путь в папке json.`, 'saved');
        return true;
    }

    async function exportXlsx() {
        ensureReady();
        if (!currentPath) {
            throw new Error('Сначала сохраните таблицу в папку json');
        }
        if (SheetView.hasChanges()) {
            throw new Error('Сначала сохраните изменения');
        }

        status('Формирование .xlsx…', 'saving');
        const file = await api.readFile(currentPath);
        const json = Converter.parse(file.content);
        const buffer = await Converter.jsonToXlsx(json);

        const name = currentPath.split('/').pop().replace(/\.json$/i, '') + '.xlsx';
        Converter.download(buffer, name);
        status(`Скачано: ${name}`, 'saved');
    }

    function getState() {
        return { currentPath, baseCommitId, forceCreate };
    }

    function restoreState(state) {
        if (!state) return;
        currentPath = state.currentPath || null;
        baseCommitId = state.baseCommitId || null;
        forceCreate = !!state.forceCreate;
    }

    return {
        init,
        loadProject,
        reloadTree,
        openFile,
        save,
        saveAs,
        pathExists,
        importXlsx,
        exportXlsx,
        getMode,
        getCurrentPath,
        getTreeItems,
        normalizePath,
        getState,
        restoreState
    };
})();
