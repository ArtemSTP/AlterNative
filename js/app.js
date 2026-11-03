/**
 * App — связка DOM и модулей
 */
(() => {
    const $ = (id) => document.getElementById(id);

    const btnLoad = $('btn-load');
    const btnOpen = $('btn-open');
    const btnSave = $('btn-save');
    const btnUpload = $('btn-upload');
    const btnDownload = $('btn-download');
    const fileInput = $('file-input');
    const commandInput = $('command-input');
    const commandError = $('command-error');

    let commandErrorTimer = null;

    function showCommandError(message) {
        if (!commandError) return;
        commandError.textContent = message || 'ошибка синтаксиса';
        commandError.hidden = false;
        clearTimeout(commandErrorTimer);
        commandErrorTimer = setTimeout(() => { commandError.hidden = true; }, 4000);
    }

    function hideCommandError() {
        if (!commandError) return;
        commandError.hidden = true;
        clearTimeout(commandErrorTimer);
    }

    const helpBanner = $('help-banner');

    function showHelp() {
        if (!helpBanner) return;
        helpBanner.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'help-title';
        title.textContent = 'Команды (клик — закрыть)';
        helpBanner.appendChild(title);

        const items = Complete.getHelp();
        if (!items.length) {
            const line = document.createElement('div');
            line.textContent = 'Справочник commands.yaml не загружен';
            helpBanner.appendChild(line);
        }
        for (const line of items) {
            const row = document.createElement('div');
            row.textContent = line;
            helpBanner.appendChild(row);
        }
        helpBanner.hidden = false;
    }

    function hideHelp() {
        if (helpBanner) helpBanner.hidden = true;
    }

    if (helpBanner) helpBanner.addEventListener('click', hideHelp);

    let statusEl = $('status');
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'status';
        $('app').appendChild(statusEl);
    }

    function setStatus(text, cls) {
        statusEl.textContent = text || '';
        statusEl.className = cls || '';
    }

    function updateButtons() {
        const hasDoc = !!SheetView.getActiveSheet();
        // Новую таблицу можно сохранить, даже если она ещё пустая
        btnSave.disabled = !hasDoc || (!SheetView.hasChanges() && !!Core.getCurrentPath());
        btnDownload.disabled = !hasDoc;
        if (btnOpen) btnOpen.disabled = false;
    }

    function defaultName() {
        const sheet = SheetView.getActiveSheet();
        const current = Core.getCurrentPath();
        const base = current
            ? current.split('/').pop().replace(/\.json$/i, '')
            : (sheet && sheet.name) || 'таблица';
        return base + '.json';
    }

    async function ensureTreeItems(force) {
        let items = Core.getTreeItems();
        if (force || !items.length) items = await Core.reloadTree();
        return items;
    }

    async function saveToPath(path) {
        if (await Core.pathExists(path)) {
            if (!(await Dialog.confirmOverwrite(path))) return false;
        }
        await Core.saveAs(path);
        return true;
    }

    async function saveFlow() {
        if (!Core.getCurrentPath()) {
            const items = await ensureTreeItems();
            const path = await Dialog.saveAs(defaultName(), Dialog.foldersFrom(items));
            if (!path) return false;
            if (!(await saveToPath(path))) return false;
        } else {
            await Core.save();
        }
        Draft.clear();
        updateButtons();
        return true;
    }

    async function resolveUnsaved(message) {
        if (!SheetView.hasChanges()) return true;

        const items = Core.getTreeItems();
        const res = await Dialog.unsavedChanges(
            defaultName(),
            Dialog.foldersFrom(items),
            message
        );

        if (!res || res.action === 'cancel') return false;
        if (res.action === 'save') {
            if (!(await saveToPath(res.path))) return false;
            Draft.clear();
            updateButtons();
        } else {
            // «Удалить»: убираем черновик, таблица заменится следующим действием
            SheetView.clearDirty();
            Draft.clear();
        }
        return true;
    }

    async function openFlow() {
        if (!(await resolveUnsaved())) return;

        // Дерево могло измениться после сохранения — перечитываем
        const items = await ensureTreeItems(true);
        const path = await Dialog.openJson(items);
        if (!path) return;

        await Core.openFile(path);
        Draft.clear();
        updateButtons();
    }

    async function uploadFlow() {
        try {
            if (!(await resolveUnsaved())) return;
            fileInput.value = '';
            fileInput.click();
        } catch (e) {
            setStatus(e.message, 'error');
        }
    }

    async function boot() {
        const config = await Config.load();
        const localMode = config.test_local === true;

        // Справочник операторов для автодополнения (Tab)
        Complete.load();

        Core.init({
            status: setStatus,
            mode: localMode ? 'local' : 'gitlab',
            localUrl: config.local_api
        });
        document.body.classList.toggle('local-mode', localMode);

        SheetView.init($('sheet-tabs'), $('table-container'), (count) => {
            updateButtons();
            if (count > 0) {
                setStatus(`Изменено ячеек: ${count}`, 'saving');
                Draft.save({
                    workbook: SheetView.getWorkbook(),
                    dirtyKeys: SheetView.getDirtyKeys(),
                    structuralDirty: SheetView.isStructuralDirty(),
                    activeIndex: SheetView.getActiveIndex(),
                    core: Core.getState()
                });
            }
        });

        SheetView.setWorkbook(SheetView.emptyWorkbook());

        let draftRestored = false;
        const draft = Draft.load();
        if (draft) {
            SheetView.setWorkbook(draft.workbook);
            SheetView.setActiveIndex(draft.activeIndex || 0);
            SheetView.setDirtyKeys(draft.dirtyKeys || []);
            SheetView.setStructuralDirty(!!draft.structuralDirty);
            Core.restoreState(draft.core);
            draftRestored = true;
        }

        updateButtons();

        if (localMode) {
            btnLoad.textContent = 'Обновить дерево';
            if (config.error) {
                setStatus('Не удалось прочитать config.yaml: ' + config.error, 'error');
            } else {
                try {
                    await Core.reloadTree();
                } catch (e) {
                    setStatus(e.message, 'error');
                }
            }
        }

        if (draftRestored) {
            setStatus('Восстановлен несохранённый черновик', 'saving');
        }
    }

    TreeView.init($('tree'), async (path) => {
        try {
            if (!(await resolveUnsaved())) return;
            await Core.openFile(path);
            Draft.clear();
            updateButtons();
        } catch (e) {
            setStatus(e.message, 'error');
        }
    });

    btnLoad.addEventListener('click', async () => {
        btnLoad.disabled = true;
        try {
            if (Core.getMode() === 'local') {
                await Core.reloadTree();
            } else {
                if (!(await resolveUnsaved())) return;
                await Core.loadProject({
                    projectUrl: $('project-url').value.trim(),
                    token: $('token').value.trim(),
                    ref: $('ref').value.trim() || 'main',
                    folder: $('folder').value.trim()
                });
                Draft.clear();
                updateButtons();
            }
        } catch (e) {
            setStatus(e.message, 'error');
        } finally {
            btnLoad.disabled = false;
        }
    });

    if (btnOpen) {
        btnOpen.addEventListener('click', async () => {
            try {
                await openFlow();
            } catch (e) {
                setStatus(e.message, 'error');
            }
        });
    }

    btnSave.addEventListener('click', async () => {
        btnSave.disabled = true;
        try {
            await saveFlow();
        } catch (e) {
            setStatus(e.message, 'error');
        } finally {
            updateButtons();
        }
    });

    btnUpload.addEventListener('click', () => {
        uploadFlow();
    });

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
            await Core.importXlsx(file);
            updateButtons();
        } catch (e) {
            setStatus(e.message, 'error');
        }
    });

    btnDownload.addEventListener('click', async () => {
        btnDownload.disabled = true;
        try {
            // Сохраняем только если путь ещё не выбран или есть правки
            if (!Core.getCurrentPath() || SheetView.hasChanges()) {
                if (!(await saveFlow())) return;
            }
            await Core.exportXlsx();
        } catch (e) {
            setStatus(e.message, 'error');
        } finally {
            updateButtons();
        }
    });

    Complete.attach(commandInput, $('command-hint'));

    if (commandInput) {
        commandInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();

            const line = commandInput.value;
            commandInput.value = '';

            if (!line.trim()) {
                hideCommandError();
                return;
            }

            if (/^help\s*$/i.test(line.trim())) {
                showHelp();
                return;
            }

            hideHelp();

            try {
                Commands.execute(line);
                hideCommandError();
            } catch (err) {
                showCommandError(err.message || 'ошибка синтаксиса');
            }
        });
    }

    window.addEventListener('beforeunload', (e) => {
        if (SheetView.hasChanges()) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    boot();
})();
