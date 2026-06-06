window.UIComponents = (() => {
    function safeText(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function escapeHtml(value) {
        const text = safeText(value);
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }

    function stripHtmlTags(value) {
        return safeText(value).replace(/<[^>]+>/g, ' ');
    }

    function setModalBodyContent(content) {
        const modalBody = document.getElementById('modalBody');
        if (!modalBody) return;
        modalBody.replaceChildren();
        if (content instanceof Node) {
            modalBody.appendChild(content);
            return;
        }
        if (typeof content === 'string' && content.trim().startsWith('<')) {
            modalBody.innerHTML = content;
            return;
        }
        modalBody.textContent = String(content);
    }

    function createText(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        el.textContent = safeText(text);
        return el;
    }

    function renderDockApp(dockApp, app, onDelete) {
        dockApp.replaceChildren();

        if (app.icon) {
            const img = document.createElement('img');
            img.className = 'dock-app-icon';
            img.src = safeText(app.icon);
            img.alt = safeText(app.name);
            dockApp.appendChild(img);
        } else {
            dockApp.appendChild(createText('div', 'dock-app-icon', '📦'));
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'dock-app-delete';
        delBtn.type = 'button';
        delBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            onDelete();
        });
        dockApp.appendChild(delBtn);
    }

    function renderAppListItem(item, app, isInDock, onToggle) {
        item.replaceChildren();

        if (app.icon) {
            const img = document.createElement('img');
            img.className = 'app-list-icon';
            img.src = safeText(app.icon);
            img.alt = safeText(app.name);
            item.appendChild(img);
        } else {
            item.appendChild(createText('div', 'app-list-icon', '📦'));
        }

        const info = document.createElement('div');
        info.className = 'app-list-info';
        info.appendChild(createText('div', 'app-list-name', app.name));
        info.appendChild(createText('div', 'text-ellipsis-muted', app.path));
        item.appendChild(info);

        const btn = document.createElement('button');
        btn.className = `app-list-action ${isInDock ? 'remove' : ''}`.trim();
        btn.type = 'button';
        btn.textContent = isInDock ? '从Dock移除' : '添加到Dock';
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            onToggle();
        });
        item.appendChild(btn);
    }

    function renderShortcutCard(card, shortcut, keyLabel) {
        card.replaceChildren();

        const main = document.createElement('div');
        main.className = 'shortcut-main';

        if (shortcut.icon) {
            main.appendChild(createText('span', 'shortcut-icon', shortcut.icon));
        } else {
            main.appendChild(createText('span', 'shortcut-initial', safeText(shortcut.label).trim().slice(0, 1)));
        }

        main.appendChild(createText('div', 'shortcut-label', shortcut.label));
        card.appendChild(main);

        const actions = document.createElement('div');
        actions.className = 'shortcut-actions';

        const editBtn = createText('button', 'btn-base btn-xs btn-secondary', '编辑');
        editBtn.type = 'button';
        editBtn.dataset.action = 'edit';
        actions.appendChild(editBtn);

        const deleteBtn = createText('button', 'btn-base btn-xs btn-danger', '删除');
        deleteBtn.type = 'button';
        deleteBtn.dataset.action = 'delete';
        actions.appendChild(deleteBtn);

        card.appendChild(actions);
        card.appendChild(createText('div', 'shortcut-key-hint', keyLabel));
    }

    function renderWifiListItem(item, options) {
        const { network, isConnected, onDetails, onForget, onConnect, getSecurityIcon, getRssiSignal } = options;
        item.replaceChildren();

        item.appendChild(createText('div', 'icon-md', getSecurityIcon(network.security)));

        const info = document.createElement('div');
        info.className = 'device-info';
        info.appendChild(createText('div', 'device-name', `${safeText(network.ssid)}${isConnected ? ' ✓' : ''}`));
        info.appendChild(createText('div', 'text-muted', isConnected ? '已连接' : network.security === 'open' ? '开放网络' : '需要密码'));
        item.appendChild(info);

        item.appendChild(createText('div', 'status-icon', getRssiSignal(network.rssi)));

        const actions = document.createElement('div');
        actions.className = 'device-actions';

        if (isConnected) {
            const detailBtn = createText('button', 'btn-base btn-sm btn-primary', '详情');
            detailBtn.type = 'button';
            detailBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                onDetails();
            });
            actions.appendChild(detailBtn);

            const forgetBtn = createText('button', 'btn-base btn-sm btn-danger', '忘记');
            forgetBtn.type = 'button';
            forgetBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                onForget();
            });
            actions.appendChild(forgetBtn);
        } else {
            const connectBtn = createText('button', 'btn-base btn-sm btn-success', '连接');
            connectBtn.type = 'button';
            connectBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                onConnect();
            });
            actions.appendChild(connectBtn);
        }

        item.appendChild(actions);
    }

    function createLabeledInput(labelText, inputId, value, options = {}) {
        const wrap = document.createElement('div');
        const label = document.createElement('label');
        label.style.display = 'block';
        label.style.marginBottom = '6px';
        label.style.fontWeight = '600';
        label.textContent = labelText;
        wrap.appendChild(label);

        const input = document.createElement('input');
        input.type = options.type || 'text';
        input.id = inputId;
        input.className = 'input-base control-md';
        input.style.width = '100%';
        if (options.placeholder) input.placeholder = options.placeholder;
        if (options.disabled) input.disabled = true;
        if (options.monospace) input.style.fontFamily = 'SF Mono, monospace';
        if (options.opacity) input.style.opacity = String(options.opacity);
        input.value = safeText(value);
        wrap.appendChild(input);
        return wrap;
    }

    function buildWifiPasswordModal(ssid) {
        const root = document.createElement('div');
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        root.style.gap = '14px';
        root.appendChild(createLabeledInput('网络名称', 'wifiSsidReadonly', ssid, { disabled: true }));
        root.appendChild(createLabeledInput('密码', 'wifiPassword', '', { type: 'password', placeholder: '输入WiFi密码' }));
        return root;
    }

    function buildWifiDetailsModal(data) {
        const { ssid, status, ipConfig, useDhcp } = data;
        const root = document.createElement('div');
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        root.style.gap = '16px';

        const top = document.createElement('div');
        top.style.textAlign = 'center';
        top.style.padding = '12px';
        top.style.background = 'rgba(10, 132, 255, 0.1)';
        top.style.borderRadius = '12px';
        top.appendChild(createText('div', '', '📶')).style.fontSize = '32px';
        top.lastChild.style.marginBottom = '8px';
        const title = createText('div', '', ssid);
        title.style.fontWeight = '600';
        title.style.fontSize = '18px';
        top.appendChild(title);
        const sub = createText('div', '', `信号强度: ${status.rssi ? data.getRssiSignal(status.rssi) : 'N/A'}${status.channel ? ` · 信道 ${status.channel}` : ''}`);
        sub.style.color = 'var(--text-secondary)';
        sub.style.fontSize = '14px';
        sub.style.marginTop = '4px';
        top.appendChild(sub);
        root.appendChild(top);

        const cfg = document.createElement('div');
        cfg.style.background = 'var(--bg-hover)';
        cfg.style.borderRadius = '12px';
        cfg.style.padding = '16px';
        const cfgHead = document.createElement('div');
        cfgHead.style.fontWeight = '600';
        cfgHead.style.marginBottom = '12px';
        cfgHead.style.display = 'flex';
        cfgHead.style.alignItems = 'center';
        cfgHead.style.gap = '8px';
        cfgHead.appendChild(createText('span', '', '🌐'));
        cfgHead.appendChild(createText('span', '', '网络配置'));
        const badge = createText('span', '', useDhcp ? 'DHCP 自动' : '静态 IP');
        badge.id = 'dhcpStatusBadge';
        badge.style.marginLeft = 'auto';
        badge.style.fontSize = '13px';
        badge.style.padding = '4px 10px';
        badge.style.background = 'rgba(10, 132, 255, 0.2)';
        badge.style.borderRadius = '6px';
        badge.style.color = 'var(--accent-blue)';
        cfgHead.appendChild(badge);
        cfg.appendChild(cfgHead);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gap = '12px';
        grid.appendChild(createLabeledInput('IP 地址', 'wifiIpAddress', ipConfig.ip || status.ip || '', { disabled: useDhcp, monospace: true, opacity: useDhcp ? '0.6' : '1' }));
        grid.appendChild(createLabeledInput('子网掩码', 'wifiSubnetMask', ipConfig.netmask || status.netmask || '255.255.255.0', { disabled: useDhcp, monospace: true, opacity: useDhcp ? '0.6' : '1' }));
        grid.appendChild(createLabeledInput('网关', 'wifiGateway', ipConfig.gateway || status.gateway || '', { disabled: useDhcp, monospace: true, opacity: useDhcp ? '0.6' : '1' }));
        cfg.appendChild(grid);
        root.appendChild(cfg);

        const dhcpBox = document.createElement('div');
        dhcpBox.style.background = 'var(--bg-hover)';
        dhcpBox.style.borderRadius = '12px';
        dhcpBox.style.padding = '16px';
        const dhcpLabel = document.createElement('label');
        dhcpLabel.style.display = 'flex';
        dhcpLabel.style.alignItems = 'center';
        dhcpLabel.style.gap = '12px';
        dhcpLabel.style.cursor = 'pointer';
        const dhcpInput = document.createElement('input');
        dhcpInput.type = 'checkbox';
        dhcpInput.id = 'wifiDhcpToggle';
        dhcpInput.checked = !!useDhcp;
        dhcpInput.style.width = '20px';
        dhcpInput.style.height = '20px';
        dhcpInput.style.cursor = 'pointer';
        dhcpInput.addEventListener('change', () => {
            if (typeof window.toggleWifiDhcpMode === 'function') window.toggleWifiDhcpMode();
        });
        dhcpLabel.appendChild(dhcpInput);
        const dhcpText = document.createElement('div');
        const dhcpTitle = createText('div', '', '使用 DHCP 自动获取');
        dhcpTitle.style.fontWeight = '600';
        dhcpText.appendChild(dhcpTitle);
        const dhcpDesc = createText('div', '', '启用后将自动配置 IP、子网掩码和网关');
        dhcpDesc.style.color = 'var(--text-secondary)';
        dhcpDesc.style.fontSize = '13px';
        dhcpDesc.style.marginTop = '2px';
        dhcpText.appendChild(dhcpDesc);
        dhcpLabel.appendChild(dhcpText);
        dhcpBox.appendChild(dhcpLabel);
        root.appendChild(dhcpBox);

        return root;
    }

    function buildBluetoothPairingModal(data) {
        const { deviceIcon, name, addr, pairingCode } = data;
        const root = document.createElement('div');
        root.style.textAlign = 'center';

        const intro = document.createElement('div');
        intro.style.marginBottom = '16px';
        const icon = createText('div', '', deviceIcon);
        icon.style.fontSize = '48px';
        icon.style.marginBottom = '12px';
        intro.appendChild(icon);
        const title = createText('div', '', name);
        title.style.fontSize = '18px';
        title.style.fontWeight = '600';
        title.style.marginBottom = '8px';
        intro.appendChild(title);
        const desc = createText('div', '', '请确认要连接此设备');
        desc.style.color = 'var(--text-secondary)';
        desc.style.fontSize = '15px';
        intro.appendChild(desc);
        root.appendChild(intro);

        const addrBox = document.createElement('div');
        addrBox.style.background = 'rgba(10, 132, 255, 0.15)';
        addrBox.style.padding = '20px';
        addrBox.style.borderRadius = '12px';
        addrBox.style.margin = '20px 0';
        const addrLabel = createText('div', '', '设备地址');
        addrLabel.style.color = 'var(--text-secondary)';
        addrLabel.style.fontSize = '14px';
        addrLabel.style.marginBottom = '8px';
        addrBox.appendChild(addrLabel);
        const addrValue = createText('div', '', addr);
        addrValue.style.fontSize = '18px';
        addrValue.style.fontWeight = '600';
        addrValue.style.letterSpacing = '2px';
        addrValue.style.color = 'var(--accent-blue)';
        addrBox.appendChild(addrValue);
        root.appendChild(addrBox);

        const note = document.createElement('div');
        note.style.color = 'var(--text-secondary)';
        note.style.fontSize = '14px';
        note.appendChild(document.createTextNode('如果设备需要配对码，请在设备上确认'));
        note.appendChild(document.createElement('br'));
        note.appendChild(document.createTextNode('某些设备可能显示配对码: '));
        const strong = document.createElement('strong');
        strong.textContent = safeText(pairingCode);
        note.appendChild(strong);
        root.appendChild(note);
        return root;
    }

    function renderNoteListItem(note, currentNoteId) {
        const preview = safeText(note.content).substring(0, 50).replace(/\n/g, ' ');
        const date = new Date(note.updatedAt).toLocaleString('zh-CN', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        return `
            <div class="note-list-item ${note.id === currentNoteId ? 'active' : ''}"
                 data-note-id="${escapeHtml(note.id)}">
                <div class="note-list-item-title">${escapeHtml(note.title || '无标题笔记')}</div>
                <div class="note-list-item-delete" data-note-delete="${escapeHtml(note.id)}">🗑️</div>
                <div class="note-list-item-preview">${escapeHtml(preview || '空笔记')}</div>
                <div class="note-list-item-date">${escapeHtml(date)}</div>
            </div>
        `;
    }

    function createEmojiPreviewImage(src) {
        const imgContainer = document.createElement('div');
        imgContainer.style.cssText = 'position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: rgba(60,60,65,0.5); border: 1px solid rgba(255,255,255,0.1);';
        const img = document.createElement('img');
        img.src = safeText(src);
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        imgContainer.appendChild(img);
        return imgContainer;
    }

    function renderPhoneContactItem(contact) {
        return `
            <div class="phone-contact-item" data-phone-number="${escapeHtml(contact.number)}">
                <div class="phone-contact-avatar">${escapeHtml(contact.avatar || safeText(contact.name).charAt(0))}</div>
                <div class="phone-contact-info">
                    <div class="phone-contact-name">${escapeHtml(contact.name)}</div>
                    <div class="phone-contact-number">${escapeHtml(contact.number)}</div>
                </div>
                <div class="phone-contact-action">📞</div>
            </div>
        `;
    }

    function renderPhoneHistoryItem(call, getIcon) {
        return `
            <div class="phone-history-item" data-phone-number="${escapeHtml(call.number)}">
                <div class="phone-history-icon ${escapeHtml(call.type)}">${escapeHtml(getIcon(call.type))}</div>
                <div class="phone-history-info">
                    <div class="phone-history-name">${escapeHtml(call.name)}</div>
                    <div class="phone-history-details">${escapeHtml(call.duration || '未接通')}</div>
                </div>
                <div class="phone-history-time">${escapeHtml(call.time)}</div>
            </div>
        `;
    }

    return {
        safeText,
        escapeHtml,
        stripHtmlTags,
        setModalBodyContent,
        renderDockApp,
        renderAppListItem,
        renderShortcutCard,
        renderWifiListItem,
        buildWifiPasswordModal,
        buildWifiDetailsModal,
        buildBluetoothPairingModal,
        renderNoteListItem,
        createEmojiPreviewImage,
        renderPhoneContactItem,
        renderPhoneHistoryItem,
    };
})();
