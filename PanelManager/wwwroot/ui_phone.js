window.UIPhone = (() => {
    function openPageUi(phoneBtConnected, phoneNumber) {
        if (typeof window.openPage === 'function') {
            window.openPage('bluetooth-phone');
        }
        updateBtStatus(phoneBtConnected);
        updateDisplay(phoneNumber);
    }

    function updateDisplay(phoneNumber) {
        const display = document.getElementById('phoneNumberDisplay');
        if (!display) return;
        if (phoneNumber) {
            display.textContent = phoneNumber;
            display.classList.remove('empty');
        } else {
            display.textContent = '输入电话号码';
            display.classList.add('empty');
        }
    }

    function updateBtStatus(phoneBtConnected) {
        const statusEl = document.getElementById('phoneBtStatus');
        const statusText = document.getElementById('phoneBtStatusText');
        if (!statusEl || !statusText) return;
        if (phoneBtConnected) {
            statusEl.classList.add('connected');
            statusEl.classList.remove('calling');
            statusText.textContent = '蓝牙已连接';
        } else {
            statusEl.classList.remove('connected', 'calling');
            statusText.textContent = '蓝牙未连接';
        }
    }

    function updateCallStatus(state, statusTextValue, phoneBtConnected) {
        const statusEl = document.getElementById('phoneCallStatus');
        const btStatus = document.getElementById('phoneBtStatus');
        const callBtn = document.getElementById('phoneCallBtn');
        const callActions = document.getElementById('phoneCallActions');

        if (statusEl) {
            statusEl.textContent = statusTextValue || '';
        }

        if (btStatus) {
            if (state === 'dialing' || state === 'ringing' || state === 'active') {
                btStatus.classList.add('calling');
            } else {
                btStatus.classList.remove('calling');
                if (phoneBtConnected) {
                    btStatus.classList.add('connected');
                }
            }
        }

        if (callBtn) {
            if (state === 'active' || state === 'dialing' || state === 'ringing') {
                callBtn.classList.add('hangup');
                callBtn.innerHTML = '<span>☎️</span>';
            } else {
                callBtn.classList.remove('hangup');
                callBtn.innerHTML = '<span>📞</span>';
            }
        }

        if (callActions) {
            callActions.style.display = (state === 'active') ? 'grid' : 'none';
        }
    }

    function updateMuteButton(phoneMuted) {
        const muteBtn = document.getElementById('phoneMuteBtn');
        if (!muteBtn) return;
        if (phoneMuted) {
            muteBtn.classList.add('active');
            muteBtn.querySelector('.phone-action-icon').textContent = '🔇';
        } else {
            muteBtn.classList.remove('active');
            muteBtn.querySelector('.phone-action-icon').textContent = '🔊';
        }
    }

    function updateSpeakerButton(phoneSpeaker) {
        const speakerBtn = document.getElementById('phoneSpeakerBtn');
        if (!speakerBtn) return;
        if (phoneSpeaker) {
            speakerBtn.classList.add('active');
        } else {
            speakerBtn.classList.remove('active');
        }
    }

    function switchTab(tabName, event) {
        document.querySelectorAll('.phone-tab').forEach((tab) => {
            tab.classList.remove('active');
        });
        const trigger = event?.target?.closest?.('.phone-tab');
        if (trigger) trigger.classList.add('active');

        document.querySelectorAll('.phone-tab-content').forEach((content) => {
            content.classList.remove('active');
        });

        const targetContent = document.getElementById(`phoneTab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
        if (targetContent) {
            targetContent.classList.add('active');
        }
    }

    function renderContacts(container, options) {
        const { contactsSyncStatus, phoneBtConnected, phoneContacts, onSync } = options;
        if (!container) return;

        if (contactsSyncStatus === 'syncing') {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: rgba(255,255,255,0.6);">
                    <div style="font-size: 32px; margin-bottom: 16px;">📱</div>
                    <div>正在从手机同步通讯录...</div>
                </div>
            `;
            return;
        }

        if (!phoneContacts || phoneContacts.length === 0) {
            container.replaceChildren();
            const empty = document.createElement('div');
            empty.style.textAlign = 'center';
            empty.style.padding = '40px';
            empty.style.color = 'rgba(255,255,255,0.6)';

            const icon = document.createElement('div');
            icon.style.fontSize = '32px';
            icon.style.marginBottom = '16px';
            icon.textContent = '📭';
            empty.appendChild(icon);

            const text = document.createElement('div');
            text.textContent = '暂无联系人';
            empty.appendChild(text);

            const btn = document.createElement('button');
            btn.className = 'btn-base btn-glass btn-md';
            btn.style.marginTop = '20px';
            btn.textContent = phoneBtConnected ? '刷新通讯录' : '请先连接蓝牙';
            btn.type = 'button';
            btn.addEventListener('click', () => onSync());
            empty.appendChild(btn);

            container.appendChild(empty);
            return;
        }

        container.innerHTML = phoneContacts.map((contact) => window.UIComponents.renderPhoneContactItem(contact)).join('');
    }

    function renderCallHistory(container, options) {
        const { historySyncStatus, callHistory, filter, onSync } = options;
        if (!container) return;

        if (historySyncStatus === 'syncing') {
            container.innerHTML = `
                <div style="padding: 60px 20px; text-align: center; color: rgba(255,255,255,0.5);">
                    <div style="font-size: 48px; margin-bottom: 16px;">⏳</div>
                    <div style="font-size: 16px;">正在同步通话记录...</div>
                </div>
            `;
            return;
        }

        if (!callHistory || callHistory.length === 0) {
            container.replaceChildren();
            const empty = document.createElement('div');
            empty.style.padding = '60px 20px';
            empty.style.textAlign = 'center';
            empty.style.color = 'rgba(255,255,255,0.5)';

            const icon = document.createElement('div');
            icon.style.fontSize = '48px';
            icon.style.marginBottom = '16px';
            icon.textContent = '📞';
            empty.appendChild(icon);

            const text = document.createElement('div');
            text.style.fontSize = '16px';
            text.style.marginBottom = '12px';
            text.textContent = '暂无通话记录';
            empty.appendChild(text);

            const btn = document.createElement('button');
            btn.className = 'btn-base btn-glass blue';
            btn.type = 'button';
            btn.style.padding = '8px 24px';
            btn.style.fontSize = '14px';
            btn.textContent = '同步通话记录';
            btn.addEventListener('click', () => onSync());
            empty.appendChild(btn);

            container.appendChild(empty);
            return;
        }

        const filtered = filter === 'all'
            ? callHistory
            : callHistory.filter((call) => call.type === filter);

        const getIcon = (type) => {
            switch (type) {
                case 'missed': return '📵';
                case 'incoming': return '📞';
                case 'outgoing': return '📲';
                default: return '📞';
            }
        };

        container.innerHTML = filtered.map((call) => window.UIComponents.renderPhoneHistoryItem(call, getIcon)).join('');
    }

    return {
        openPageUi,
        updateDisplay,
        updateBtStatus,
        updateCallStatus,
        updateMuteButton,
        updateSpeakerButton,
        switchTab,
        renderContacts,
        renderCallHistory,
    };
})();
