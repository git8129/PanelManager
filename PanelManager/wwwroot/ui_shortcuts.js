window.UIShortcuts = (() => {
    let activeShortcutCard = null;
    let shortcutDocListenerReady = false;

    function closeActions(except = null) {
        if (activeShortcutCard && activeShortcutCard !== except) {
            activeShortcutCard.classList.remove('show-actions');
            activeShortcutCard = null;
        }
    }

    function renderAddButton(onClick) {
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-base btn-glass shortcut-button shortcut-add-button';
        addBtn.type = 'button';

        const icon = document.createElement('div');
        icon.className = 'shortcut-add-icon';
        icon.textContent = '+';
        addBtn.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'shortcut-add-label';
        label.textContent = '添加';
        addBtn.appendChild(label);

        addBtn.addEventListener('click', () => onClick());
        return addBtn;
    }

    function renderShortcutGrid(grid, shortcuts, handlers) {
        const { onAdd, onTap, onEdit, onDelete } = handlers;
        if (!grid) return;

        grid.innerHTML = '';
        shortcuts.forEach((shortcut) => {
            const isLua = shortcut.lua && shortcut.lua.trim();
            const keyLabel = shortcut.key || (isLua ? 'LUA' : 'CUSTOM');
            const card = document.createElement('div');
            card.className = 'btn-base btn-glass shortcut-button';
            if (window.UIComponents?.renderShortcutCard) {
                window.UIComponents.renderShortcutCard(card, shortcut, keyLabel);
            }
            bindShortcutGestures(card, shortcut, { onTap, onEdit, onDelete });
            grid.appendChild(card);
        });

        grid.appendChild(renderAddButton(onAdd));
    }

    function bindShortcutGestures(card, shortcut, handlers) {
        const { onTap, onEdit, onDelete } = handlers;

        if (!shortcutDocListenerReady) {
            document.addEventListener('pointerdown', (event) => {
                if (activeShortcutCard && !activeShortcutCard.contains(event.target)) {
                    closeActions();
                }
            });
            shortcutDocListenerReady = true;
        }

        let pressTimer = null;
        let longPressTriggered = false;

        const clearPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            card.classList.remove('is-pressed');
        };

        const startPress = (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            longPressTriggered = false;
            card.classList.add('is-pressed');
            card.setPointerCapture(event.pointerId);
            pressTimer = setTimeout(() => {
                longPressTriggered = true;
                closeActions(card);
                card.classList.add('show-actions');
                activeShortcutCard = card;
                card.classList.remove('is-pressed');
            }, 650);
        };

        const endPress = async () => {
            const wasLongPress = longPressTriggered;
            clearPress();
            if (wasLongPress) return;
            await onTap(shortcut);
        };

        card.addEventListener('pointerdown', (event) => {
            if (event.target.closest('.shortcut-actions')) return;
            startPress(event);
        });

        card.addEventListener('pointerup', (event) => {
            if (event.target.closest('.shortcut-actions')) return;
            event.preventDefault();
            endPress();
        });

        card.addEventListener('pointercancel', clearPress);
        card.addEventListener('lostpointercapture', clearPress);

        const actions = card.querySelector('.shortcut-actions');
        actions.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });
        actions.addEventListener('click', (event) => {
            const actionBtn = event.target.closest('button');
            if (!actionBtn) return;
            event.preventDefault();
            event.stopPropagation();
            const action = actionBtn.dataset.action;
            if (action === 'edit') {
                onEdit(shortcut);
            }
            if (action === 'delete') {
                onDelete(shortcut);
            }
            closeActions();
        });
    }

    function buildShortcutModal(shortcut) {
        const data = shortcut || {};
        const root = document.createElement('div');
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        root.style.gap = '24px';

        function createSection(iconText, titleText) {
            const section = document.createElement('div');
            section.className = 'emoji-input-section';
            const label = document.createElement('label');
            label.style.display = 'block';
            label.style.marginBottom = '12px';
            label.style.fontWeight = '600';
            label.style.fontSize = 'var(--font-body-lg)';
            label.style.fontFamily = 'var(--font-family-base)';
            const icon = document.createElement('span');
            icon.style.fontSize = 'var(--font-icon-sm)';
            icon.textContent = iconText;
            label.appendChild(icon);
            label.appendChild(document.createTextNode(` ${titleText}`));
            section.appendChild(label);
            return section;
        }

        const nameSection = createSection('⚙️', '快捷键名称');
        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'input-base control-md';
        labelInput.id = 'shortcutLabel';
        labelInput.placeholder = '例如: 复制';
        labelInput.value = String(data.label || '');
        labelInput.style.border = '2px solid rgba(255,255,255,0.15)';
        labelInput.style.background = 'rgba(60,60,65,0.6)';
        nameSection.appendChild(labelInput);
        root.appendChild(nameSection);

        const keySection = createSection('⌨️', '按键组合');
        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.className = 'input-base control-md';
        keyInput.id = 'shortcutKey';
        keyInput.placeholder = '例如: Ctrl+C';
        keyInput.value = String(data.key || '');
        keyInput.style.border = '2px solid rgba(255,255,255,0.15)';
        keyInput.style.background = 'rgba(60,60,65,0.6)';
        keySection.appendChild(keyInput);
        const keyHint = document.createElement('div');
        keyHint.style.marginTop = '8px';
        keyHint.style.fontSize = 'var(--font-body)';
        keyHint.style.color = 'rgba(255,255,255,0.55)';
        keyHint.style.fontFamily = 'var(--font-family-base)';
        keyHint.textContent = '请优先填写按键组合，Lua 脚本功能测试中';
        keySection.appendChild(keyHint);
        root.appendChild(keySection);

        const divider = document.createElement('div');
        divider.style.textAlign = 'center';
        divider.style.color = 'rgba(255,255,255,0.4)';
        divider.style.fontSize = 'var(--font-body)';
        divider.style.fontFamily = 'var(--font-family-base)';
        divider.style.position = 'relative';
        divider.style.margin = '8px 0';
        const dividerText = document.createElement('span');
        dividerText.style.background = 'rgba(40, 40, 45, 0.9)';
        dividerText.style.padding = '0 16px';
        dividerText.style.position = 'relative';
        dividerText.style.zIndex = '1';
        dividerText.textContent = '高级选项 (仅当未设置按键时可用)';
        divider.appendChild(dividerText);
        const dividerLine = document.createElement('div');
        dividerLine.style.position = 'absolute';
        dividerLine.style.top = '50%';
        dividerLine.style.left = '0';
        dividerLine.style.right = '0';
        dividerLine.style.height = '1px';
        dividerLine.style.background = 'rgba(255,255,255,0.1)';
        divider.appendChild(dividerLine);
        root.appendChild(divider);

        const luaSection = createSection('📝', '罗技 Lua 脚本');
        const luaBox = document.createElement('textarea');
        luaBox.className = 'textarea-base textarea-md';
        luaBox.id = 'shortcutLua';
        luaBox.placeholder = '输入Lua脚本代码...';
        luaBox.value = String(data.lua || '');
        luaBox.style.fontFamily = 'var(--font-family-mono)';
        luaBox.style.fontSize = 'var(--font-body)';
        luaBox.style.minHeight = '200px';
        luaBox.style.border = '2px solid rgba(255,255,255,0.15)';
        luaBox.style.background = 'rgba(30,30,35,0.8)';
        luaBox.style.color = '#a9dc76';
        luaBox.style.lineHeight = '1.6';
        luaSection.appendChild(luaBox);

        const fileWrap = document.createElement('div');
        fileWrap.style.marginTop = '16px';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'shortcutLuaFile';
        fileInput.accept = '.lua,.txt';
        fileInput.style.display = 'none';
        fileWrap.appendChild(fileInput);

        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'btn-base btn-md btn-outline';
        loadBtn.style.width = '100%';
        loadBtn.style.height = 'var(--btn-height-md)';
        loadBtn.style.border = '2px dashed rgba(0, 122, 255, 0.5)';
        loadBtn.style.background = 'rgba(0, 122, 255, 0.05)';
        loadBtn.style.color = 'var(--accent-blue)';
        loadBtn.style.fontSize = 'var(--font-body)';
        loadBtn.style.fontFamily = 'var(--font-family-base)';
        loadBtn.style.fontWeight = '600';
        loadBtn.style.display = 'flex';
        loadBtn.style.alignItems = 'center';
        loadBtn.style.justifyContent = 'center';
        loadBtn.style.gap = '10px';
        const loadIcon = document.createElement('span');
        loadIcon.style.fontSize = 'var(--font-icon-sm)';
        loadIcon.textContent = '📥';
        loadBtn.appendChild(loadIcon);
        const loadText = document.createElement('span');
        loadText.textContent = '从文件加载 Lua 脚本';
        loadBtn.appendChild(loadText);
        loadBtn.addEventListener('click', () => fileInput.click());
        fileWrap.appendChild(loadBtn);
        luaSection.appendChild(fileWrap);

        const luaHint = document.createElement('div');
        luaHint.style.marginTop = '10px';
        luaHint.style.fontSize = 'var(--font-body)';
        luaHint.style.color = 'rgba(255,255,255,0.5)';
        luaHint.style.textAlign = 'center';
        luaHint.style.fontFamily = 'var(--font-family-base)';
        luaHint.textContent = '支持 .lua 和 .txt 格式';
        luaSection.appendChild(luaHint);
        root.appendChild(luaSection);

        fileInput.addEventListener('change', (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                luaBox.value = String(reader.result || '');
            };
            reader.readAsText(file);
        });

        return root;
    }

    function readShortcutFormValues() {
        return {
            label: (document.getElementById('shortcutLabel')?.value || '').trim(),
            key: (document.getElementById('shortcutKey')?.value || '').trim(),
            lua: (document.getElementById('shortcutLua')?.value || '').trim(),
        };
    }

    function saveShortcuts(list) {
        localStorage.setItem('shortcuts', JSON.stringify(list));
    }

    function updateShortcut(shortcuts, updatedShortcut, values) {
        updatedShortcut.label = values.label;
        updatedShortcut.key = values.key;
        updatedShortcut.lua = values.lua;
        saveShortcuts(shortcuts);
    }

    function addShortcut(shortcuts, values) {
        shortcuts.push({
            id: Date.now(),
            label: values.label,
            key: values.key,
            lua: values.lua,
        });
        saveShortcuts(shortcuts);
    }

    function removeShortcut(shortcuts, id) {
        const next = shortcuts.filter((s) => s.id !== id);
        saveShortcuts(next);
        return next;
    }

    function applyEditAndSave(shortcuts, shortcut, values) {
        updateShortcut(shortcuts, shortcut, values);
        return shortcuts;
    }

    function appendShortcutAndSave(shortcuts, values) {
        addShortcut(shortcuts, values);
        return shortcuts;
    }

    return {
        closeActions,
        renderAddButton,
        renderShortcutGrid,
        bindShortcutGestures,
        buildShortcutModal,
        readShortcutFormValues,
        saveShortcuts,
        updateShortcut,
        addShortcut,
        removeShortcut,
        applyEditAndSave,
        appendShortcutAndSave,
    };
})();
