/**
 * Config — чтение config.yaml без внешних зависимостей
 * Поддерживается простой YAML: ключ: значение, комментарии через #
 */
const Config = (() => {
    const DEFAULTS = {
        test_local: false,
        local_api: 'http://127.0.0.1:8787'
    };

    function parse(text) {
        const result = {};
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.replace(/\s+#.*$/, '').trim();
            if (!line || line.startsWith('#')) continue;

            const sep = line.indexOf(':');
            if (sep === -1) continue;

            const key = line.slice(0, sep).trim();
            let value = line.slice(sep + 1).trim();
            if (!key) continue;

            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }

            if (value === 'true') result[key] = true;
            else if (value === 'false') result[key] = false;
            else result[key] = value;
        }
        return result;
    }

    async function load() {
        try {
            const res = await fetch('config.yaml', { cache: 'no-store' });
            if (!res.ok) throw new Error(`config.yaml: ${res.status}`);
            return Object.assign({}, DEFAULTS, parse(await res.text()));
        } catch (e) {
            return Object.assign({}, DEFAULTS, { error: e.message });
        }
    }

    return { load, parse };
})();
