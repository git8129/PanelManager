// 软件自更新只使用 system/appUpdate*，不得复用下位机 update 模块。
(() => {
    let snapshot = null;
    let promptTimer = null;
    let pollTimer = null;
    let refreshing = false;
    let installPending = false;
    let localError = '';
    const dismissedVersions = new Set();
    const element = id => document.getElementById(id);
    const busy = () => ['downloading', 'starting', 'handedOff'].includes(snapshot?.status);

    function schedulePoll() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = busy() ? setTimeout(refresh, 1500) : null;
    }

    function refresh() {
        if (refreshing || typeof wsConnected === 'undefined' || !wsConnected) return;
        refreshing = true;
        sendMessageWithTimeout('system', 'appUpdateStatus', {}, 5000, response => {
            refreshing = false;
            if (response.code === 0 && response.data) handle(response.data);
            schedulePoll();
        });
    }

    function otherDialogVisible() {
        return Array.from(document.querySelectorAll('.modal, dialog')).some(node => {
            if (node.id === 'appUpdateDialog' || node.getClientRects().length === 0) return false;
            const style = getComputedStyle(node);
            // 旧通用弹窗常驻 display:flex，以 visibility 隐藏；不能把它误认为一直占用弹窗。
            return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
        });
    }

    function showWhenReady() {
        promptTimer = null;
        const dialog = element('appUpdateDialog');
        if (!dialog || !snapshot?.latestVersion) return;
        const actionable = snapshot.status === 'available' || snapshot.status === 'error' || busy();
        if (!actionable || (!busy() && dismissedVersions.has(snapshot.latestVersion))) return;
        // 不抢占已有确认框/后台窗口；始终最多保留一个待显示提示。
        if (document.hidden || otherDialogVisible()) {
            promptTimer = setTimeout(showWhenReady, 1000);
            return;
        }
        render();
        if (!dialog.open) dialog.showModal();
    }

    function render() {
        if (!snapshot) return;
        const version = element('appUpdateVersion');
        if (!version) return;
        version.textContent = `当前版本 ${snapshot.currentVersion} → 最新版本 ${snapshot.latestVersion || '—'}`;
        element('appUpdateNotes').textContent = snapshot.notes || '此版本未提供更新说明。';
        element('appUpdateMessage').textContent = localError || snapshot.message || '';
        const progress = element('appUpdateProgress');
        progress.hidden = !busy();
        progress.value = Math.max(0, Math.min(100, Number(snapshot.percent) || 0));
        const confirm = element('appUpdateConfirm');
        confirm.disabled = installPending || busy() || !snapshot.canInstall;
        confirm.hidden = !snapshot.canInstall && !busy();
        confirm.textContent = installPending ? '正在请求…' : busy() ? `更新中 ${progress.value}%`
            : snapshot.status === 'error' ? '重试更新' : '下载并运行安装包';
        const cancel = element('appUpdateCancel');
        cancel.disabled = snapshot.status === 'starting' || snapshot.status === 'handedOff';
        cancel.textContent = snapshot.status === 'downloading' ? '取消下载' : snapshot.status === 'error' ? '关闭' : '稍后再说';
    }

    function handle(data) {
        if (!data || typeof data.status !== 'string' || !Number.isFinite(data.revision)) return;
        // 状态响应可能晚于进度事件；旧 available 不能覆盖正在下载/已经取消的状态。
        if (snapshot && data.revision < snapshot.revision) return;
        snapshot = data;
        const aboutVersion = element('hostAppVersion');
        if (aboutVersion) aboutVersion.textContent = `版本 v${data.currentVersion}`;
        if (busy() || data.status === 'dismissed') {
            installPending = false;
            localError = '';
        }
        render();
        if (promptTimer) { clearTimeout(promptTimer); promptTimer = null; }
        if (data.status === 'dismissed') {
            if (data.latestVersion) dismissedVersions.add(data.latestVersion);
            element('appUpdateDialog')?.close();
        } else if (['available', 'error', 'downloading', 'starting'].includes(data.status)) {
            showWhenReady();
        }
        schedulePoll();
    }

    function confirm() {
        if (installPending || busy() || !snapshot?.canInstall) return;
        installPending = true;
        localError = '';
        render();
        // 只确认宿主已查到的版本；下载 URL、摘要及目标路径全部由宿主 owner 决定。
        sendMessageWithTimeout('system', 'appUpdateInstall', { version: snapshot.latestVersion }, 5000, response => {
            installPending = false;
            if (response.code !== 0 && !busy()) localError = response.msg || '更新请求未确认，请稍后重试。';
            render();
            refresh();
        });
    }

    function dismiss() {
        if (!snapshot || ['starting', 'handedOff'].includes(snapshot.status)) return;
        const downloading = snapshot.status === 'downloading';
        if (snapshot.latestVersion) dismissedVersions.add(snapshot.latestVersion);
        if (!downloading) element('appUpdateDialog')?.close();
        sendMessageWithTimeout('system', 'appUpdateDismiss', {}, 5000, response => {
            if (response.code === 0 && response.data) handle(response.data);
            else {
                localError = response.msg || '取消请求未确认，请重试。';
                render();
                refresh();
            }
        });
    }

    element('appUpdateConfirm')?.addEventListener('click', confirm);
    element('appUpdateCancel')?.addEventListener('click', dismiss);
    element('appUpdateDialog')?.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    window.addEventListener('panelmanager-host-capability-ready', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.AppUpdateUI = { handle, refresh };
    refresh();
})();
