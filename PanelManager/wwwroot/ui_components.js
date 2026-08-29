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

    function getWifiSignalMeta(value) {
        const rssi = Number(value);
        if (!Number.isFinite(rssi) || rssi >= 0) {
            return { level: 0, label: '未知', rssi: null };
        }
        if (rssi >= -50) return { level: 5, label: '极佳', rssi };
        if (rssi >= -60) return { level: 4, label: '很好', rssi };
        if (rssi >= -70) return { level: 3, label: '良好', rssi };
        if (rssi >= -80) return { level: 2, label: '一般', rssi };
        return { level: 1, label: '较弱', rssi };
    }

    function createWifiSignalIndicator(value, variant = 'list') {
        const indicator = document.createElement('div');
        indicator.className = `wifi-signal-indicator wifi-signal-${variant}`;

        const bars = document.createElement('div');
        bars.className = 'wifi-signal-bars';
        bars.setAttribute('role', 'img');
        for (let index = 1; index <= 5; index++) {
            const bar = document.createElement('span');
            bar.className = 'wifi-signal-bar';
            bars.appendChild(bar);
        }
        indicator.appendChild(bars);

        const copy = document.createElement('div');
        copy.className = 'wifi-signal-copy';
        copy.appendChild(createText('span', 'wifi-signal-quality', ''));
        copy.appendChild(createText('span', 'wifi-signal-rssi', ''));
        indicator.appendChild(copy);
        updateWifiSignalIndicator(indicator, value);
        return indicator;
    }

    function updateWifiSignalIndicator(indicator, value) {
        const signal = getWifiSignalMeta(value);
        for (let level = 0; level <= 5; level++) {
            indicator.classList.toggle(`wifi-signal-level-${level}`, level === signal.level);
        }
        const bars = indicator.querySelector('.wifi-signal-bars');
        bars?.setAttribute('aria-label', signal.rssi === null
            ? '信号强度未知'
            : `信号${signal.label}，${signal.rssi} dBm`);
        bars?.querySelectorAll('.wifi-signal-bar').forEach((bar, index) => {
            bar.classList.toggle('active', index < signal.level);
        });
        const quality = indicator.querySelector('.wifi-signal-quality');
        const rssi = indicator.querySelector('.wifi-signal-rssi');
        if (quality) quality.textContent = signal.label;
        if (rssi) rssi.textContent = signal.rssi === null ? '-- dBm' : `${signal.rssi} dBm`;
        indicator.title = signal.rssi === null ? '信号强度未知' : `${signal.label} · ${signal.rssi} dBm`;
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
        delBtn.setAttribute('aria-label', `从 Dock 移除 ${safeText(app.name)}`);
        delBtn.title = '从 Dock 移除';
        delBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            onDelete();
        });
        dockApp.appendChild(delBtn);
    }

    function renderAppListItem(item, app, isInDock, onToggle) {
        item.replaceChildren();
        item.classList.add('ui-list-item');

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
        const {
            network,
            isConnected,
            isConnecting = false,
            isWaitingForScan = false,
            isSaved = false,
            connectionFailure = null,
            connectDisabled = false,
            onDetails,
            onDisconnect,
            onConnect,
            getSecurityIcon
        } = options;
        item.classList.add('ui-list-item');
        let refs = item._wifiRefs;
        if (!refs) {
            const icon = createText('div', 'icon-md', '');
            const info = document.createElement('div');
            info.className = 'device-info';
            const name = createText('div', 'device-name', '');
            const meta = createText('div', 'text-muted', '');
            info.appendChild(name);
            info.appendChild(meta);
            const actions = document.createElement('div');
            actions.className = 'device-actions';
            item.appendChild(icon);
            item.appendChild(info);
            item.appendChild(actions);
            refs = { icon, name, meta, actions, signal: null, actionMode: '' };
            item._wifiRefs = refs;
        }

        refs.icon.textContent = getSecurityIcon(network.security);
        refs.name.textContent = `${safeText(network.ssid)}${isConnected ? ' ✓' : ''}`;
        refs.meta.textContent = isConnected
            ? '已连接'
            : isWaitingForScan
                ? '等待扫描完成...'
                : isConnecting
                ? '正在连接...'
                : connectionFailure
                    ? `连接失败：${safeText(connectionFailure)}`
                : isSaved
                    ? (network.rssi === null || network.rssi === undefined ? '无信号' : '未连接')
                    : network.security === 'open' ? '开放网络' : '需要密码';

        if (!refs.signal) {
            refs.signal = createWifiSignalIndicator(network.rssi);
            refs.actions.before(refs.signal);
        } else {
            updateWifiSignalIndicator(refs.signal, network.rssi);
        }
        if (isSaved && !isConnected && (network.rssi === null || network.rssi === undefined)) {
            const bars = refs.signal.querySelector('.wifi-signal-bars');
            const quality = refs.signal.querySelector('.wifi-signal-quality');
            if (bars) bars.setAttribute('aria-label', '无信号');
            if (quality) quality.textContent = '无信号';
            refs.signal.title = '无信号';
        }

        const actionMode = isConnected ? 'connected' : 'available';
        if (refs.actionMode !== actionMode) {
            refs.actions.replaceChildren();
            if (isConnected) {
                const detailBtn = createText('button', 'btn-base btn-sm btn-primary', '详情');
                detailBtn.type = 'button';
                detailBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    item._wifiActions.onDetails();
                });
                const disconnectBtn = createText('button', 'btn-base btn-sm btn-danger', '断开');
                disconnectBtn.type = 'button';
                disconnectBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    item._wifiActions.onDisconnect();
                });
                refs.actions.appendChild(detailBtn);
                refs.actions.appendChild(disconnectBtn);
            } else {
                const connectBtn = createText('button', 'btn-base btn-sm btn-success', '连接');
                connectBtn.type = 'button';
                connectBtn.dataset.action = 'connect';
                connectBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    item._wifiActions.onConnect();
                });
                refs.actions.appendChild(connectBtn);
            }
            refs.actionMode = actionMode;
        }
        if (!isConnected) {
            const connectBtn = refs.actions.querySelector('[data-action="connect"]');
            if (connectBtn) {
                connectBtn.disabled = Boolean(connectDisabled);
                connectBtn.textContent = isWaitingForScan
                    ? '等待扫描...'
                    : isConnecting ? '连接中...' : '连接';
            }
        }
        item.classList.toggle('is-connecting', isConnecting);
        item._wifiActions = { onDetails, onDisconnect, onConnect };
    }

    function createLabeledInput(labelText, inputId, value, options = {}) {
        const wrap = document.createElement('div');
        wrap.className = 'ui-field';
        const label = document.createElement('label');
        label.className = 'ui-field-label';
        label.textContent = labelText;
        wrap.appendChild(label);

        const input = document.createElement('input');
        input.type = options.type || 'text';
        input.id = inputId;
        input.className = 'ui-input input-base control-md';
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
        root.className = 'ui-stack';
        root.appendChild(createLabeledInput('网络名称', 'wifiSsidReadonly', ssid, { disabled: true }));
        root.appendChild(createLabeledInput('密码', 'wifiPassword', '', { type: 'password', placeholder: '输入WiFi密码' }));
        return root;
    }

    function buildWifiDetailsModal(data) {
        const { ssid, status, ipConfig, useDhcp } = data;
        const root = document.createElement('div');
        root.className = 'ui-stack';

        const top = document.createElement('div');
        top.className = 'wifi-details-hero';
        top.appendChild(createWifiSignalIndicator(status.rssi, 'detail'));
        const title = createText('div', 'wifi-details-title', ssid);
        top.appendChild(title);
        if (status.channel) {
            top.appendChild(createText('div', 'wifi-details-channel', `信道 ${status.channel}`));
        }
        root.appendChild(top);

        const cfg = document.createElement('div');
        cfg.className = 'ui-section';
        const cfgHead = document.createElement('div');
        cfgHead.className = 'ui-inline ui-section-title';
        cfgHead.appendChild(createText('span', '', '🌐'));
        cfgHead.appendChild(createText('span', '', '网络配置'));
        const badge = createText('span', 'ui-status ui-status--info', useDhcp ? 'DHCP 自动' : '静态 IP');
        badge.id = 'dhcpStatusBadge';
        badge.style.marginLeft = 'auto';
        cfgHead.appendChild(badge);
        cfg.appendChild(cfgHead);

        const grid = document.createElement('div');
        grid.className = 'ui-stack';
        grid.appendChild(createLabeledInput('IP 地址', 'wifiIpAddress', ipConfig.ip || status.ip || '', { disabled: useDhcp, monospace: true, opacity: useDhcp ? '0.6' : '1' }));
        grid.appendChild(createLabeledInput('子网掩码', 'wifiSubnetMask', ipConfig.netmask || status.netmask || '255.255.255.0', { disabled: useDhcp, monospace: true, opacity: useDhcp ? '0.6' : '1' }));
        grid.appendChild(createLabeledInput('网关', 'wifiGateway', ipConfig.gateway || status.gateway || '', { disabled: useDhcp, monospace: true, opacity: useDhcp ? '0.6' : '1' }));
        cfg.appendChild(grid);
        root.appendChild(cfg);

        const dhcpBox = document.createElement('div');
        dhcpBox.className = 'ui-section';
        const dhcpLabel = document.createElement('label');
        dhcpLabel.className = 'ui-inline';
        dhcpLabel.style.cursor = 'pointer';
        const dhcpInput = document.createElement('input');
        dhcpInput.type = 'checkbox';
        dhcpInput.id = 'wifiDhcpToggle';
        dhcpInput.checked = !!useDhcp;
        dhcpInput.className = 'ui-check';
        dhcpInput.style.cursor = 'pointer';
        dhcpInput.addEventListener('change', () => {
            if (typeof window.toggleWifiDhcpMode === 'function') window.toggleWifiDhcpMode();
        });
        dhcpLabel.appendChild(dhcpInput);
        const dhcpText = document.createElement('div');
        const dhcpTitle = createText('div', '', '使用 DHCP 自动获取');
        dhcpTitle.className = 'ui-field-label';
        dhcpText.appendChild(dhcpTitle);
        const dhcpDesc = createText('div', '', '启用后将自动配置 IP、子网掩码和网关');
        dhcpDesc.className = 'ui-section-description';
        dhcpText.appendChild(dhcpDesc);
        dhcpLabel.appendChild(dhcpText);
        dhcpBox.appendChild(dhcpLabel);
        root.appendChild(dhcpBox);

        const danger = document.createElement('div');
        danger.className = 'ui-section';
        const deleteBtn = createText('button', 'btn-base btn-sm btn-danger', '删除网络');
        deleteBtn.type = 'button';
        deleteBtn.id = 'wifiDeleteNetworkBtn';
        danger.appendChild(deleteBtn);
        root.appendChild(danger);

        return root;
    }

    function buildBluetoothPairingModal(data) {
        const { deviceIcon, name, pairingCode } = data;
        const root = document.createElement('div');
        root.className = 'ui-modal-stack';

        const intro = document.createElement('div');
        intro.className = 'ui-modal-intro';
        const icon = createText('div', 'ui-modal-icon', deviceIcon);
        intro.appendChild(icon);
        const title = createText('div', 'ui-modal-title', name);
        intro.appendChild(title);
        const desc = createText('div', 'ui-modal-description', '请确认两台设备显示的配对码一致');
        intro.appendChild(desc);
        root.appendChild(intro);

        const codeBox = document.createElement('div');
        codeBox.className = 'ui-pairing-code-box';
        const codeLabel = createText('div', 'ui-pairing-code-label', '配对码');
        codeBox.appendChild(codeLabel);
        const codeValue = createText('div', 'ui-pairing-code-value', pairingCode);
        codeBox.appendChild(codeValue);
        root.appendChild(codeBox);

        const note = document.createElement('div');
        note.className = 'ui-modal-note';
        note.textContent = '配对完成前请保持另一台设备处于配对界面';
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
                <button class="note-list-item-delete" type="button" aria-label="删除笔记"
                    data-note-delete="${escapeHtml(note.id)}"><span aria-hidden="true">🗑️</span></button>
                <div class="note-list-item-preview">${escapeHtml(preview || '空笔记')}</div>
                <div class="note-list-item-date">${escapeHtml(date)}</div>
            </div>
        `;
    }

    function createEmojiPreviewImage(src) {
        const imgContainer = document.createElement('div');
        imgContainer.className = 'ui-image-tile';
        const img = document.createElement('img');
        img.src = safeText(src);
        imgContainer.appendChild(img);
        return imgContainer;
    }

    function createButton({ label, icon = '', variant = 'secondary', size = 'md', type = 'button', disabled = false, onClick } = {}) {
        const button = document.createElement('button');
        const variants = new Set(['secondary', 'primary', 'success', 'warning', 'danger', 'ghost']);
        const sizes = new Set(['sm', 'md', 'lg']);
        const safeVariant = variants.has(variant) ? variant : 'secondary';
        const safeSize = sizes.has(size) ? size : 'md';
        button.type = type;
        button.className = `ui-button ui-button--${safeVariant} ui-button--${safeSize}`;
        button.disabled = Boolean(disabled);

        if (icon) {
            const iconElement = document.createElement('span');
            iconElement.className = 'ui-button__icon';
            iconElement.setAttribute('aria-hidden', 'true');
            iconElement.textContent = safeText(icon);
            button.appendChild(iconElement);
        }

        const labelElement = document.createElement('span');
        labelElement.textContent = safeText(label);
        button.appendChild(labelElement);
        if (typeof onClick === 'function') button.addEventListener('click', onClick);
        return button;
    }

    function createStatusBadge({ label, tone = 'neutral' } = {}) {
        const status = document.createElement('span');
        const tones = new Set(['neutral', 'info', 'success', 'warning', 'danger']);
        const safeTone = tones.has(tone) ? tone : 'neutral';
        status.className = `ui-status${safeTone === 'neutral' ? '' : ` ui-status--${safeTone}`}`;
        status.textContent = safeText(label);
        return status;
    }

    function createEmptyState({ title, description = '', icon = '' } = {}) {
        const emptyState = document.createElement('div');
        emptyState.className = 'ui-empty-state';

        if (icon) {
            const iconElement = document.createElement('div');
            iconElement.className = 'ui-empty-state__icon';
            iconElement.setAttribute('aria-hidden', 'true');
            iconElement.textContent = safeText(icon);
            emptyState.appendChild(iconElement);
        }

        const titleElement = document.createElement('div');
        titleElement.className = 'ui-empty-state__title';
        titleElement.textContent = safeText(title);
        emptyState.appendChild(titleElement);

        if (description) {
            const descriptionElement = document.createElement('div');
            descriptionElement.className = 'ui-section-description';
            descriptionElement.textContent = safeText(description);
            emptyState.appendChild(descriptionElement);
        }

        return emptyState;
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
        getWifiSignalMeta,
        createWifiSignalIndicator,
        renderDockApp,
        renderAppListItem,
        renderShortcutCard,
        renderWifiListItem,
        buildWifiPasswordModal,
        buildWifiDetailsModal,
        buildBluetoothPairingModal,
        renderNoteListItem,
        createEmojiPreviewImage,
        createButton,
        createStatusBadge,
        createEmptyState,
        renderPhoneContactItem,
        renderPhoneHistoryItem,
    };
})();
