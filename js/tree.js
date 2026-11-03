/**
 * Tree — рендер дерева JSON-файлов из результатов API
 * Поддерживает несколько независимых экземпляров (панель + модальное окно).
 */
const TreeView = (() => {

    /**
     * Создать экземпляр дерева
     * @param {HTMLElement} container
     * @param {function(string)} onSelect — вызывается при клике на файл, передаёт path
     */
    function create(container, onSelect) {

        function render(items) {
            // Фильтруем: только JSON-файлы и папки
            const filtered = items.filter(i =>
                i.type === 'tree' || i.name.toLowerCase().endsWith('.json')
            );

            // Строим вложенную структуру из path
            const root = { children: {}, name: '' };
            for (const item of filtered) {
                const parts = item.path.split('/');
                let node = root;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!node.children[parts[i]]) {
                        node.children[parts[i]] = { children: {}, name: parts[i], type: 'tree' };
                    }
                    node = node.children[parts[i]];
                    if (!node.children) node.children = {};
                }
                const fileName = parts[parts.length - 1];
                // Папка может прийти отдельной записью раньше файлов:
                // сохраняем уже собранных потомков.
                const existing = node.children[fileName];
                node.children[fileName] = {
                    children: item.type === 'tree' ? (existing && existing.children) || {} : undefined,
                    name: fileName,
                    type: item.type,
                    path: item.path
                };
            }

            container.innerHTML = '';
            container.appendChild(buildNode(root));
        }

        function buildNode(node) {
            const frag = document.createDocumentFragment();

            const keys = Object.keys(node.children).sort((a, b) => {
                const aIsFolder = node.children[a].type === 'tree';
                const bIsFolder = node.children[b].type === 'tree';
                if (aIsFolder && !bIsFolder) return -1;
                if (!aIsFolder && bIsFolder) return 1;
                return a.localeCompare(b);
            });

            for (const key of keys) {
                const child = node.children[key];
                if (child.type === 'tree') {
                    const folder = document.createElement('div');
                    folder.className = 'tree-folder';

                    const toggle = document.createElement('div');
                    toggle.className = 'tree-toggle';
                    toggle.textContent = child.name;
                    toggle.addEventListener('click', () => {
                        folder.classList.toggle('open');
                    });

                    const childrenDiv = document.createElement('div');
                    childrenDiv.className = 'tree-children';
                    childrenDiv.appendChild(buildNode(child));

                    folder.appendChild(toggle);
                    folder.appendChild(childrenDiv);
                    frag.appendChild(folder);
                } else {
                    const fileEl = document.createElement('div');
                    fileEl.className = 'tree-file';
                    fileEl.textContent = child.name;
                    fileEl.dataset.path = child.path;
                    fileEl.addEventListener('click', () => {
                        container.querySelectorAll('.tree-file.active').forEach(el =>
                            el.classList.remove('active')
                        );
                        fileEl.classList.add('active');
                        if (onSelect) onSelect(child.path);
                    });
                    frag.appendChild(fileEl);
                }
            }
            return frag;
        }

        function clear() {
            container.innerHTML = '';
        }

        return { render, clear };
    }

    // Обратная совместимость: один экземпляр через init/render
    let singleton = null;

    function init(el, callback) {
        singleton = create(el, callback);
    }

    function render(items) {
        if (singleton) singleton.render(items);
    }

    function clear() {
        if (singleton) singleton.clear();
    }

    return { create, init, render, clear };
})();
