window.UIApps = (() => {
    function bindDockGestures(dockApp, app, handlers) {
        const { onDelete, onLaunch } = handlers;
        let pressTimer = null;
        let pointerId = null;
        let pressStart = null;
        let deleteIndicator = null;
        let gestureCancelled = false;
        let longPressTriggered = false;

        const clearPress = (animate = true) => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            if (deleteIndicator) {
                const indicator = deleteIndicator;
                deleteIndicator = null;
                indicator.classList.remove('show');
                if (animate) {
                    setTimeout(() => indicator.remove(), 200);
                } else {
                    indicator.remove();
                }
            }
            pointerId = null;
            pressStart = null;
            dockApp.classList.remove('is-delete-press');
        };

        dockApp.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            if (event.target.closest('.dock-app-delete')) return;

            clearPress(false);
            gestureCancelled = false;
            longPressTriggered = false;
            pointerId = event.pointerId;
            pressStart = { x: event.clientX, y: event.clientY };
            dockApp.classList.add('is-delete-press');
            dockApp.setPointerCapture?.(event.pointerId);

            deleteIndicator = document.createElement('div');
            deleteIndicator.className = 'dock-delete-indicator';
            deleteIndicator.textContent = '🗑️';
            dockApp.appendChild(deleteIndicator);
            requestAnimationFrame(() => deleteIndicator?.classList.add('show'));

            pressTimer = setTimeout(() => {
                longPressTriggered = true;
                navigator.vibrate?.(25);
                clearPress(false);
                onDelete(app.id);
            }, 1200);
        });

        dockApp.addEventListener('pointermove', (event) => {
            if (event.pointerId !== pointerId || !pressStart) return;
            if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 14) {
                gestureCancelled = true;
                clearPress();
            }
        });

        dockApp.addEventListener('pointerup', (event) => {
            if (event.target.closest('.dock-app-delete')) return;
            const shouldLaunch = !gestureCancelled && !longPressTriggered;
            clearPress();
            if (shouldLaunch) onLaunch(app);
        });
        dockApp.addEventListener('pointercancel', clearPress);
        dockApp.addEventListener('lostpointercapture', clearPress);
        dockApp.addEventListener('contextmenu', (event) => event.preventDefault());
        dockApp.addEventListener('click', (event) => {
            if (event.target.closest('.dock-app-delete')) return;
            event.preventDefault();
        });
    }

    function renderDock(dockApps, applications, handlers) {
        const { onDelete, onLaunch } = handlers;
        if (!dockApps) return;
        dockApps.innerHTML = '';
        applications.forEach((app) => {
            const dockApp = document.createElement('div');
            dockApp.className = 'dock-app';
            if (window.UIComponents?.renderDockApp) {
                window.UIComponents.renderDockApp(dockApp, app, () => onDelete(app.id));
            }
            bindDockGestures(dockApp, app, { onDelete, onLaunch });
            dockApps.appendChild(dockApp);
        });
    }

    function renderAppsList(appsList, systemApps, applications, handlers) {
        const { onToggle, onLaunch } = handlers;
        if (!appsList) return;
        appsList.innerHTML = '';
        if (!systemApps || systemApps.length === 0) {
            appsList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary);">正在加载应用列表...</div>';
            return;
        }

        systemApps.forEach((app) => {
            const isInDock = applications.some((a) => a.id === app.id);
            const item = document.createElement('div');
            item.className = 'app-list-item ui-list-item';
            if (window.UIComponents?.renderAppListItem) {
                window.UIComponents.renderAppListItem(item, app, isInDock, () => onToggle(app.id));
            }
            item.addEventListener('click', (event) => {
                if (!event.target.classList.contains('app-list-action')) {
                    onLaunch(app);
                }
            });
            appsList.appendChild(item);
        });
    }

    function toggleDockApp(applications, systemApps, appId) {
        const app = systemApps.find((a) => a.id === appId);
        if (!app) {
            return { applications, changed: false, message: '' };
        }

        const index = applications.findIndex((a) => a.id === appId);
        if (index >= 0) {
            const next = applications.filter((a) => a.id !== appId);
            localStorage.setItem('applications', JSON.stringify(next));
            return {
                applications: next,
                changed: true,
                message: `已从 Dock 移除 ${app.name}`,
            };
        }

        if (applications.length >= 12) {
            return {
                applications,
                changed: false,
                message: 'Dock 最多只能添加 12 个应用',
            };
        }

        const next = [...applications, { ...app }];
        localStorage.setItem('applications', JSON.stringify(next));
        return {
            applications: next,
            changed: true,
            message: `已添加 ${app.name} 到 Dock`,
        };
    }

    function deleteApp(applications, appId) {
        const app = applications.find((a) => a.id === appId);
        if (!app) {
            return { applications, changed: false, message: '' };
        }

        const next = applications.filter((a) => a.id !== appId);
        localStorage.setItem('applications', JSON.stringify(next));
        return {
            applications: next,
            changed: true,
            message: `已从 Dock 移除 ${app.name}`,
        };
    }

    function getLaunchToastMessage(app, success, message) {
        if (success) {
            return `✓ 启动 ${app.name}`;
        }
        return `✗ 启动失败: ${message || '未知错误'}`;
    }

    function getRefreshToastMessage() {
        return '正在刷新应用列表...';
    }

    return {
        renderDock,
        renderAppsList,
        toggleDockApp,
        deleteApp,
        getLaunchToastMessage,
        getRefreshToastMessage,
    };
})();
