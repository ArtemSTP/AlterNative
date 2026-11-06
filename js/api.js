/**
 * API Adapter — работа с GitLab Repository API
 */
const GitLabAPI = (() => {
    let baseUrl = '';
    let projectId = '';
    let token = '';
    let ref = 'main';

    /**
     * Инициализация адаптера
     * @param {string} projectUrl — URL проекта, напр. https://gitlab.example.com/group/project
     * @param {string} privateToken — Personal Access Token с write_repository
     * @param {string} branch
     */
    function init(projectUrl, privateToken, branch) {
        const url = new URL(projectUrl.replace(/\/+$/, ''));
        baseUrl = url.origin + '/api/v4';
        const path = url.pathname.replace(/^\/|\/$/g, '');
        projectId = encodeURIComponent(path);
        token = privateToken;
        ref = branch || 'main';
    }

    function headers() {
        return {
            'PRIVATE-TOKEN': token,
            'Content-Type': 'application/json'
        };
    }

    function apiError(operation, res, body) {
        const err = new Error(`${operation}: ${res.status} ${res.statusText}` +
            (body && body.message ? ` — ${body.message}` : ''));
        err.status = res.status;
        return err;
    }

    /**
     * Получить дерево файлов (рекурсивно, с обходом пагинации)
     * @param {string} folder — путь к папке
     * @returns {Promise<Array<{name, path, type}>>}
     */
    async function getTree(folder) {
        const all = [];
        let page = 1;

        while (true) {
            const params = new URLSearchParams({
                ref,
                recursive: 'true',
                per_page: '100',
                page: String(page)
            });
            if (folder) params.set('path', folder);

            const res = await fetch(
                `${baseUrl}/projects/${projectId}/repository/tree?${params}`,
                { headers: { 'PRIVATE-TOKEN': token } }
            );
            if (!res.ok) throw apiError('GitLab API tree', res, await res.json().catch(() => null));

            all.push(...await res.json());

            const next = res.headers.get('X-Next-Page');
            if (!next) break;
            page = Number(next);
        }
        return all;
    }

    function decodeBase64Utf8(b64) {
        const binary = atob(String(b64).replace(/\s/g, ''));
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    }

    /**
     * Прочитать файл: содержимое + last_commit_id для защиты от перезаписи
     * @param {string} filePath — путь к файлу в репозитории
     * @returns {Promise<{content: string, lastCommitId: string}>}
     */
    async function readFile(filePath) {
        const encoded = encodeURIComponent(filePath);
        const res = await fetch(
            `${baseUrl}/projects/${projectId}/repository/files/${encoded}?ref=${encodeURIComponent(ref)}`,
            { headers: { 'PRIVATE-TOKEN': token } }
        );
        if (!res.ok) throw apiError('GitLab API read', res, await res.json().catch(() => null));

        const data = await res.json();
        return {
            content: decodeBase64Utf8(data.content),
            lastCommitId: data.last_commit_id
        };
    }

    /**
     * Сохранить (создать/обновить) файл коммитом
     * @param {string} filePath
     * @param {string} content — содержимое
     * @param {string} message — commit message
     * @param {string|null} lastCommitId — id версии, которую редактировали (защита от перезаписи)
     * @param {boolean} forceCreate — создать файл (POST), не пытаясь обновить
     */
    async function saveFile(filePath, content, message, lastCommitId, forceCreate) {
        const encoded = encodeURIComponent(filePath);
        const url = `${baseUrl}/projects/${projectId}/repository/files/${encoded}`;

        const body = {
            branch: ref,
            content,
            commit_message: message || `Update ${filePath} via Excel Viewer`
        };
        if (lastCommitId) body.last_commit_id = lastCommitId;

        // PUT — обновление; если файла ещё нет — POST — создание
        let res;
        if (forceCreate) {
            res = await fetch(url, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({
                    branch: ref,
                    content,
                    commit_message: body.commit_message
                })
            });
        } else {
            res = await fetch(url, {
                method: 'PUT',
                headers: headers(),
                body: JSON.stringify(body)
            });

            if (res.status === 404) {
                res = await fetch(url, {
                    method: 'POST',
                    headers: headers(),
                    body: JSON.stringify({
                        branch: ref,
                        content,
                        commit_message: body.commit_message
                    })
                });
            }
        }

        if (!res.ok) {
            const err = await res.json().catch(() => null);
            const message = String((err && err.message) || '');
            const isConflict = res.status === 409 ||
                /changed since you started editing|file has changed/i.test(message);

            if (isConflict) {
                const conflict = new Error(
                    'Файл был изменён в GitLab после открытия. Перезагрузите его и повторите правки.'
                );
                conflict.status = res.status;
                conflict.conflict = true;
                throw conflict;
            }
            throw apiError('GitLab API save', res, err);
        }
        return res.json();
    }

    function isInitialized() {
        return !!(baseUrl && projectId && token);
    }

    return { init, getTree, readFile, saveFile, isInitialized, get ref() { return ref; } };
})();