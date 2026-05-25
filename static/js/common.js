/**
 * 数据飞轮 - 公共工具函数
 * 提供 API 调用封装、Toast 通知、加载遮罩等基础能力
 */

// ========== API 调用封装 ==========

/**
 * 通用 API 请求封装
 * @param {string} url - 请求地址
 * @param {object} options - fetch 选项
 * @returns {Promise<object>} 响应数据
 */
async function apiRequest(url, options = {}) {
    const defaultOptions = {
        headers: { 'Content-Type': 'application/json' },
    };
    const mergedOptions = { ...defaultOptions, ...options };
    if (mergedOptions.body && typeof mergedOptions.body === 'object' && !(mergedOptions.body instanceof FormData)) {
        mergedOptions.body = JSON.stringify(mergedOptions.body);
    }
    if (mergedOptions.body instanceof FormData) {
        delete mergedOptions.headers['Content-Type'];
    }
    try {
        const response = await fetch(url, mergedOptions);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `请求失败: ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        showToast(error.message || '网络请求失败', 'error');
        throw error;
    }
}

async function apiGet(url) { return apiRequest(url); }
async function apiPost(url, data) { return apiRequest(url, { method: 'POST', body: data }); }
async function apiPut(url, data) { return apiRequest(url, { method: 'PUT', body: data }); }
async function apiDelete(url) { return apiRequest(url, { method: 'DELETE' }); }

/**
 * 文件上传专用
 */
async function apiUpload(url, formData) {
    return apiRequest(url, { method: 'POST', body: formData });
}

// ========== Toast 通知 ==========

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const bgColors = {
        success: '#22c55e',
        error: '#ef4444',
        warning: '#eab308',
        info: '#3b82f6'
    };
    const bg = bgColors[type] || bgColors.info;
    Object.assign(toast.style, {
        background: bg,
        color: '#fff',
        padding: '12px 16px',
        borderRadius: '8px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        maxWidth: '360px',
        fontSize: '14px',
        fontWeight: '500',
        transform: 'translateX(110%)',
        opacity: '0',
        transition: 'transform 0.3s ease, opacity 0.3s ease',
        pointerEvents: 'auto'
    });
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.transform = 'translateX(0)';
        toast.style.opacity = '1';
    });
    setTimeout(() => {
        toast.style.transform = 'translateX(110%)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ========== 加载遮罩 ==========

function showLoading(text = '加载中...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('global-loading').style.display = 'flex';
}

function hideLoading() {
    document.getElementById('global-loading').style.display = 'none';
}

// ========== 确认弹窗 ==========

function showConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        if (!modal) {
            console.error('confirm-modal 元素不存在');
            resolve(false);
            return;
        }
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        modal.style.display = 'flex';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';
        modal.style.zIndex = '9999';
        
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');
        
        function cleanup() {
            modal.style.display = 'none';
            modal.style.visibility = '';
            modal.style.opacity = '';
            modal.style.zIndex = '';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onOverlayClick);
            document.removeEventListener('keydown', onEscKey);
        }
        function onOk() { cleanup(); resolve(true); }
        function onCancel() { cleanup(); resolve(false); }
        function onOverlayClick(e) {
            if (e.target === modal) { cleanup(); resolve(false); }
        }
        function onEscKey(e) {
            if (e.key === 'Escape') { cleanup(); resolve(false); }
        }
        
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onOverlayClick);
        document.addEventListener('keydown', onEscKey);

        // 100ms 后自动 focus 到确认按钮，确保弹窗可见且可操作
        setTimeout(() => {
            if (okBtn) okBtn.focus();
        }, 100);
    });
}

// ========== URL 参数工具 ==========

function getUrlParam(name) {
    return new URLSearchParams(window.location.search).get(name);
}

function setUrlParam(name, value) {
    const url = new URL(window.location);
    if (value) {
        url.searchParams.set(name, value);
    } else {
        url.searchParams.delete(name);
    }
    window.history.replaceState({}, '', url);
}

// ========== 按钮防重复点击 ==========

/**
 * 锁定按钮 + 显示 loading spinner
 * @param {HTMLButtonElement} btn - 按钮元素
 * @param {string} loadingText - loading 时显示的文字，默认'处理中...'
 */
function lockBtn(btn, loadingText) {
    if (!btn) return;
    btn.disabled = true;
    btn._origHTML = btn.innerHTML;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'not-allowed';
    btn.innerHTML = `<svg style="width:14px; height:14px; animation:spin 1s linear infinite; display:inline-block; vertical-align:middle; margin-right:4px;" fill="none" viewBox="0 0 24 24"><circle style="opacity:0.25;" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path style="opacity:0.75;" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>${loadingText || '处理中...'}`;
}

/**
 * 解锁按钮，恢复原始内容
 * @param {HTMLButtonElement} btn - 按钮元素
 */
function unlockBtn(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    if (btn._origHTML) btn.innerHTML = btn._origHTML;
    delete btn._origHTML;
}

// ========== 格式化工具 ==========

function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleString('zh-CN');
}

function formatPercent(value) {
    if (value === null || value === undefined) return '0%';
    return (value * 100).toFixed(1) + '%';
}

function truncateText(text, maxLen = 50) {
    if (!text) return '';
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
}

// ========== 全局同步状态轮询 ==========

(function initSyncBanner() {
    let lastSyncStatus = 'idle';
    let syncBannerHideTimer = null;

    function showSyncBanner(text, autoHide) {
        const banner = document.getElementById('sync-banner');
        const bannerText = document.getElementById('sync-banner-text');
        if (!banner || !bannerText) return;
        bannerText.textContent = text;
        banner.style.transform = 'translateY(0)';
        if (syncBannerHideTimer) {
            clearTimeout(syncBannerHideTimer);
            syncBannerHideTimer = null;
        }
        if (autoHide) {
            syncBannerHideTimer = setTimeout(() => {
                banner.style.transform = 'translateY(-100%)';
                syncBannerHideTimer = null;
            }, 3000);
        }
    }

    function hideSyncBanner() {
        const banner = document.getElementById('sync-banner');
        if (!banner) return;
        banner.style.transform = 'translateY(-100%)';
    }

    async function pollSyncStatus() {
        try {
            const resp = await fetch('/api/sync/status');
            if (!resp.ok) return;
            const data = await resp.json();
            const currentStatus = data.status;

            if (currentStatus === 'syncing' && lastSyncStatus !== 'syncing') {
                showSyncBanner('数据同步中...', false);
            } else if (currentStatus === 'done' && lastSyncStatus === 'syncing') {
                showSyncBanner('同步完成 ✓', true);
            }

            lastSyncStatus = currentStatus;
        } catch (e) {
            // 轮询失败静默忽略
        }
    }

    // 每60秒轮询一次
    setInterval(pollSyncStatus, 60000);
    // 页面加载后立即查询一次
    setTimeout(pollSyncStatus, 2000);
})();
