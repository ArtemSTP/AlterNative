/**
 * Mode — выбор источника данных: локальный стенд или GitLab.
 * Локальный режим имеет смысл только на loopback: на Pages он привёл бы
 * к запросам на 127.0.0.1 и ошибке CORS.
 */
const Mode = (() => {
    const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

    function isLocal(config, hostname) {
        const host = String(hostname || '').toLowerCase();
        return !!config && config.test_local === true && LOOPBACK.indexOf(host) !== -1;
    }

    return { isLocal, LOOPBACK };
})();
