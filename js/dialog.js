/**
 * Dialog — модальные окна: выбор JSON, сохранение как, несохранённые изменения
 */
const Dialog = (() => {

    function normalizePath(value) {
        let path = String(value || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
        path = path.replace(/^\/+/, '');
        if (!path) return '';

        // Запрещаем выход за пределы папки json
        const parts = path.split('/');
        if (parts.some(p => !p || p === '.' || p === '..')) return '';

        if (!/\.json$/i.test(path)) path += '.json';
        return path;
    }

    function foldersFrom(items) {
        const folders = new Set(['']);
        for (const item of items || []) {
            if (item.type !== 'tree') continue;
            folders.add(item.path);
        }
        return Array.from(folders).sort();
    }

    function buildModal(title, bodyNodes, actions) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';

        const heading = document.createElement('h2');
        heading.className = 'modal-title';
        heading.textContent = title;
        modal.appendChild(heading);

        const body = document.createElement('div');
        body.className = 'modal-body';
        bodyNodes.forEach(n => body.appendChild(n));
        modal.appendChild(body);

        const footer = document.createElement('div');
        footer.className = 'modal-actions';
        modal.appendChild(footer);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        let closed = false;
        function close(result) {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(result);
        }

        let resolve;
        const promise = new Promise(r => { resolve = r; });

        function onKey(e) {
            if (e.key === 'Escape') close(null);
        }
        document.addEventListener('keydown', onKey);

        actions.forEach(action => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = action.label;
            btn.className = 'btn' + (action.kind ? ' btn-' + action.kind : '');
            if (action.disabled) btn.disabled = true;
            btn.addEventListener('click', () => {
                const result = action.onClick ? action.onClick(close) : null;
                if (result !== false) close(result !== undefined ? result : null);
            });
            footer.appendChild(btn);
            action.element = btn;
        });

        return { overlay, modal, body, footer, close, promise, actions };
    }

    /**
     * Выбор JSON-файла из дерева
     * @param {Array} items — элементы API
     * @returns {Promise<string|null>} — путь выбранного файла
     */
    async function openJson(items) {
        let selected = null;

        const hint = document.createElement('p');
        hint.className = 'modal-hint';
        hint.textContent = 'Выберите JSON-файл и нажмите «Открыть».';

        const treeEl = document.createElement('div');
        treeEl.className = 'modal-tree';

        const ui = buildModal('Открыть таблицу', [hint, treeEl], [
            { label: 'Отмена', kind: 'secondary', onClick: () => null },
            {
                label: 'Открыть', kind: 'primary', disabled: true,
                onClick: () => selected
            }
        ]);

        const tree = TreeView.create(treeEl, (path) => {
            selected = path;
            ui.actions[1].element.disabled = false;
        });
        tree.render(items);

        return ui.promise;
    }

    function pathField(defaultPath, folders) {
        const wrap = document.createElement('label');
        wrap.className = 'modal-field';

        const caption = document.createElement('span');
        caption.textContent = 'Путь внутри папки json';
        wrap.appendChild(caption);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultPath || '';
        input.placeholder = 'например: отчёты/продажи.json';
        input.className = 'modal-input';
        wrap.appendChild(input);

        if (folders && folders.length) {
            const datalist = document.createElement('datalist');
            datalist.id = 'folder-list-' + Math.random().toString(36).slice(2);
            folders.filter(Boolean).forEach(f => {
                const opt = document.createElement('option');
                opt.value = f + '/';
                datalist.appendChild(opt);
            });
            input.setAttribute('list', datalist.id);
            wrap.appendChild(datalist);
        }

        const error = document.createElement('div');
        error.className = 'modal-error';
        wrap.appendChild(error);

        return { wrap, input, error };
    }

    /**
     * Сохранить как — путь внутри папки json
     * @returns {Promise<string|null>}
     */
    async function saveAs(defaultPath, folders) {
        const hint = document.createElement('p');
        hint.className = 'modal-hint';
        hint.textContent = 'Укажите имя файла и, при необходимости, вложенную папку.';

        const field = pathField(defaultPath, folders);

        const ui = buildModal('Сохранить таблицу', [hint, field.wrap], [
            { label: 'Отмена', kind: 'secondary', onClick: () => null },
            {
                label: 'Сохранить', kind: 'primary',
                onClick: () => {
                    const path = normalizePath(field.input.value);
                    if (!path) {
                        field.error.textContent = 'Укажите имя файла';
                        return false;
                    }
                    return path;
                }
            }
        ]);

        field.input.focus();
        field.input.select();

        return ui.promise;
    }

    /**
     * Несохранённые изменения: сохранить / удалить / отмена
     * @returns {Promise<{action: 'save'|'discard'|'cancel', path?: string}>}
     */
    async function unsavedChanges(defaultPath, folders, message, onDecision) {
        const hint = document.createElement('p');
        hint.className = 'modal-hint';
        hint.textContent = message ||
            'В таблице есть несохранённые изменения. Сохраните их в папку json или удалите.';

        const field = pathField(defaultPath, folders);

        const decided = (result) => {
            // Синхронный вызов внутри клика сохраняет user activation
            // (нужно для открытия выбора файла сразу после диалога).
            if (onDecision) onDecision(result);
            return result;
        };

        const ui = buildModal('Несохранённые изменения', [hint, field.wrap], [
            {
                label: 'Отмена', kind: 'secondary',
                onClick: () => decided({ action: 'cancel' })
            },
            {
                label: 'Удалить', kind: 'danger',
                onClick: () => decided({ action: 'discard' })
            },
            {
                label: 'Сохранить', kind: 'primary',
                onClick: () => {
                    const path = normalizePath(field.input.value);
                    if (!path) {
                        field.error.textContent = 'Укажите имя файла';
                        return false;
                    }
                    return decided({ action: 'save', path });
                }
            }
        ]);

        field.input.focus();
        field.input.select();

        return ui.promise;
    }

    /**
     * Подтверждение перезаписи существующего файла
     * @returns {Promise<boolean>}
     */
    async function confirmOverwrite(path) {
        const hint = document.createElement('p');
        hint.className = 'modal-hint';
        hint.textContent = `Файл ${path} уже существует. Перезаписать его?`;

        const ui = buildModal('Перезапись файла', [hint], [
            { label: 'Отмена', kind: 'secondary', onClick: () => false },
            { label: 'Перезаписать', kind: 'danger', onClick: () => true }
        ]);

        return !!(await ui.promise);
    }

    return { normalizePath, foldersFrom, openJson, saveAs, unsavedChanges, confirmOverwrite };
})();
