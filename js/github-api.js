/**
 * GitHubAPI — адаптер GitHub Contents API.
 * Интерфейс совпадает с GitLabAPI: getTree / readFile / saveFile / isInitialized.
 *
 * projectUrl: owner/repo или https://github.com/owner/repo
 * token: Personal Access Token (Contents: read/write или classic repo)
 * branch: ветка, по умолчанию main
 */
const GitHubAPI = (() => {
    let baseUrl = 'https://api.github.com';
    let owner = '';
    let repo = '';
    let token = '';
    let ref = 'main';
    let branchesCache = null;

    function init(projectUrl, privateToken, branch) {
        const raw = String(projectUrl || '').trim()
            .replace(/\.git$/i, '')
            .replace(/\/+$/, '');
        let rest = raw;

        if (/^https?:\/\//i.test(raw)) {
            const url = new URL(raw);
            rest = url.pathname.replace(/^\/+|\/+$/g, '');
            baseUrl = /(^|\.)github\.com$/i.test(url.hostname)
                ? 'https://api.github.com'
                : url.origin + '/api/v3'; // GitHub Enterprise
        } else {
            baseUrl = 'https://api.github.com';
        }

        const parts = rest.split('/').filter(Boolean);
        if (parts.length < 2) {
            throw new Error('Укажите репозиторий GitHub: owner/repo или https://github.com/owner/repo');
        }

        owner = parts[0];
        repo = parts[1];
        token = privateToken || '';
        ref = branch || 'main';
        branchesCache = null;
    }

    async function branchNames() {
        if (branchesCache) return branchesCache;
        try {
            const res = await request(`${baseUrl}/repos/${owner}/${repo}/branches?per_page=100`,
                { headers: headers() });
            if (!res.ok) return [];
            const list = await res.json();
            branchesCache = Array.isArray(list) ? list.map(b => b.name) : [];
        } catch (e) {
            branchesCache = [];
        }
        return branchesCache;
    }

    function headers(extra) {
        return Object.assign({
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }, token ? { Authorization: 'Bearer ' + token } : {}, extra || {});
    }

    const TIMEOUT_MS = 30000;

    // Без таймаута зависший запрос оставляет кнопку «Сохранить» в вечной загрузке.
    async function request(url, options) {
        if (typeof AbortController === 'undefined') return fetch(url, options);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
        } catch (e) {
            if (e && e.name === 'AbortError') {
                const err = new Error('GitHub API: превышено время ожидания (30 с)');
                err.status = 0;
                throw err;
            }
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    async function apiError(operation, res) {
        let body = null;
        try { body = await res.json(); } catch (e) { /* ignore */ }
        const err = new Error(`${operation}: ${res.status} ${res.statusText}` +
            (body && body.message ? ` — ${body.message}` : ''));
        err.status = res.status;
        return err;
    }

    function encodePath(filePath) {
        return String(filePath).split('/').map(encodeURIComponent).join('/');
    }

    function decodeBase64Utf8(b64) {
        const binary = atob(String(b64).replace(/\s/g, ''));
        const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    }

    function encodeBase64Utf8(text) {
        const bytes = new TextEncoder().encode(String(text));
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    /**
     * Дерево файлов ветки (рекурсивно).
     * Возвращает только папки и .json — остальные файлы приложению не нужны.
     */
    async function getTree(folder) {
        const url = `${baseUrl}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
        const res = await request(url, { headers: headers() });
        if (res.status === 409) return []; // пустой репозиторий
        if (!res.ok) {
            if (res.status === 404) {
                const names = await branchNames();
                const suffix = names.length ? ` Доступные ветки: ${names.join(', ')}.` : '';
                const err = new Error(`GitHub API tree: ветка «${ref}» не найдена.${suffix}`);
                err.status = 404;
                throw err;
            }
            throw await apiError('GitHub API tree', res);
        }

        const data = await res.json();
        const prefix = String(folder || '').replace(/^\/+|\/+$/g, '');
        const items = [];

        for (const entry of data.tree || []) {
            if (entry.type !== 'tree' && entry.type !== 'blob') continue;
            if (entry.type === 'blob' && !/\.json$/i.test(entry.path)) continue;
            if (prefix && entry.path !== prefix && !entry.path.startsWith(prefix + '/')) continue;

            items.push({
                name: entry.path.split('/').pop(),
                path: entry.path,
                type: entry.type
            });
        }

        return items;
    }

    async function readFile(filePath) {
        const url = `${baseUrl}/repos/${owner}/${repo}/contents/${encodePath(filePath)}` +
            `?ref=${encodeURIComponent(ref)}`;
        const res = await request(url, { headers: headers() });
        if (!res.ok) throw await apiError('GitHub API read', res);

        const data = await res.json();
        if (Array.isArray(data)) {
            throw new Error('GitHub API read: по этому пути находится папка, а не файл');
        }
        return {
            content: decodeBase64Utf8(data.content),
            lastCommitId: data.sha
        };
    }

    async function saveFile(filePath, content, message, lastCommitId, forceCreate) {
        const url = `${baseUrl}/repos/${owner}/${repo}/contents/${encodePath(filePath)}`;
        const body = {
            message: message || `Update ${filePath} via Excel Viewer`,
            content: encodeBase64Utf8(content),
            branch: ref
        };
        if (!forceCreate && lastCommitId) body.sha = lastCommitId;

        const res = await request(url, {
            method: 'PUT',
            headers: headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.json().catch(() => null);
            const text = String((err && err.message) || '');
            if (res.status === 422 && /branch .+ not found/i.test(text)) {
                throw new Error(`GitHub API save: ветка «${ref}» не найдена. ` +
                    'Проверьте поле «ветка» (например, gh-pages).');
            }
            if (res.status === 409 ||
                (res.status === 422 && /sha|already exists|does not match/i.test(text))) {
                const conflict = new Error(
                    'Файл был изменён в GitHub после открытия. Перезагрузите его и повторите правки.'
                );
                conflict.status = res.status;
                conflict.conflict = true;
                throw conflict;
            }
            throw new Error(`GitHub API save: ${res.status} ${res.statusText}` +
                (text ? ` — ${text}` : ''));
        }

        return res.json();
    }

    function isInitialized() {
        return !!(owner && repo && token);
    }

    return {
        init,
        getTree,
        readFile,
        saveFile,
        isInitialized,
        get owner() { return owner; },
        get repo() { return repo; },
        get ref() { return ref; }
    };
})();
