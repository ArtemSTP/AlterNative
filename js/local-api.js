/**
 * LocalAPI — адаптер локального стенда (test/server.py → sandbox/json)
 * Интерфейс совпадает с GitLabAPI.
 */
const LocalAPI = (() => {
    let baseUrl = '';
    let initialized = false;

    function init(url) {
        baseUrl = String(url || '').replace(/\/+$/, '');
        initialized = !!baseUrl;
    }

    function apiError(operation, res, body) {
        const err = new Error(`${operation}: ${res.status} ${res.statusText}` +
            (body && body.message ? ` — ${body.message}` : ''));
        err.status = res.status;
        return err;
    }

    function decodeBase64Utf8(b64) {
        const binary = atob(String(b64).replace(/\s/g, ''));
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    }

    async function getTree(folder) {
        const params = new URLSearchParams({ recursive: 'true' });
        if (folder) params.set('path', folder);

        const res = await fetch(`${baseUrl}/api/tree?${params}`);
        if (!res.ok) throw apiError('Local API tree', res, await res.json().catch(() => null));
        return res.json();
    }

    async function readFile(filePath) {
        const encoded = encodeURIComponent(filePath);
        const res = await fetch(`${baseUrl}/api/files/${encoded}`);
        if (!res.ok) throw apiError('Local API read', res, await res.json().catch(() => null));

        const data = await res.json();
        return {
            content: decodeBase64Utf8(data.content),
            lastCommitId: data.last_commit_id
        };
    }

    async function saveFile(filePath, content, message, lastCommitId, forceCreate) {
        const encoded = encodeURIComponent(filePath);
        const url = `${baseUrl}/api/files/${encoded}`;

        const body = { content };
        if (lastCommitId) body.last_commit_id = lastCommitId;

        const res = await fetch(url, {
            method: forceCreate ? 'POST' : 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.json().catch(() => null);
            const text = String((err && err.message) || '');
            if (res.status === 409 || /changed since you started editing/i.test(text)) {
                const conflict = new Error(
                    'Файл был изменён после открытия. Перезагрузите его и повторите правки.'
                );
                conflict.status = res.status;
                conflict.conflict = true;
                throw conflict;
            }
            throw apiError('Local API save', res, err);
        }
        return res.json();
    }

    function isInitialized() {
        return initialized;
    }

    return { init, getTree, readFile, saveFile, isInitialized };
})();
