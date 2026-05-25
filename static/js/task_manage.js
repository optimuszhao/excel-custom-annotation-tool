/**
 * 数据飞轮 — 任务管理页面前端逻辑
 * 功能：任务列表（分页）、多选删除、详情弹框、任务对比
 */

// ========== 全局状态 ==========
let currentFileId = null;          // 当前查看的文件 ID
let currentPage = 1;              // 任务列表当前页码
const PAGE_SIZE = 10;             // 每页条数
let selectedTaskIds = new Set();  // 已勾选的任务 ID（多选删除用）
let compareTaskIds = new Set();   // 用于对比的任务 ID（最多2个）
let allTasks = [];                // 当前页任务数据缓存
let taskManagePollTimer = null;   // 任务列表轮询定时器
let currentDetailTaskId = null;   // 当前查看详情的任务 ID

// ========== 初始化 ==========

document.addEventListener('DOMContentLoaded', async () => {
    // 从 URL 参数获取 file_id
    currentFileId = getUrlParam('file_id');
    if (!currentFileId) {
        document.getElementById('taskTableBody').innerHTML =
            '<tr><td colspan="15" class="text-center text-gray-400 py-16">缺少 file_id 参数，请从工作台进入</td></tr>';
        return;
    }

    // 返回按钮带上 file_id 参数
    document.getElementById('backBtn').href = '/workbench?file_id=' + currentFileId;

    // 显示文件信息
    await loadFileInfo();

    // 加载任务列表
    await loadTaskList();

    // 启动/停止列表轮询
    updateTaskManagePolling();
});

// ========== 文件信息加载 ==========

async function loadFileInfo() {
    try {
        const data = await apiGet(`/api/excel/${currentFileId}`);
        const info = data.original_file_name || data.file_name || '';
        document.getElementById('fileInfo').textContent = `文件：${info}`;
    } catch (e) {
        document.getElementById('fileInfo').textContent = '';
    }
}

// ========== 任务列表加载 ==========

async function loadTaskList() {
    if (!currentFileId) return;
    try {
        const params = new URLSearchParams({
            file_id: currentFileId,
            page: currentPage,
            size: PAGE_SIZE,
        });
        const data = await apiGet(`/api/tasks?${params.toString()}`);
        allTasks = data.items || [];
        renderTaskTable(allTasks);
        renderTaskPagination(data.total, data.page, Math.ceil(data.total / PAGE_SIZE));
        // 根据是否有运行中任务，启停轮询
        updateTaskManagePolling();
    } catch (e) {
        document.getElementById('taskTableBody').innerHTML =
            '<tr><td colspan="15" class="text-center text-gray-400 py-16">加载失败</td></tr>';
    }
}

// ========== 运行中任务轮询 ==========

function updateTaskManagePolling() {
    const hasRunning = allTasks.some(t => t.status === 'running');
    if (hasRunning) {
        if (!taskManagePollTimer) {
            taskManagePollTimer = setInterval(() => {
                loadTaskList();
            }, 3000);
        }
    } else {
        if (taskManagePollTimer) {
            clearInterval(taskManagePollTimer);
            taskManagePollTimer = null;
        }
    }
}

// ========== 渲染任务表格 ==========

function renderTaskTable(tasks) {
    const tbody = document.getElementById('taskTableBody');
    if (!tasks.length) {
        tbody.innerHTML = '<tr><td colspan="15" class="text-center text-gray-400 py-16">暂无标注任务</td></tr>';
        return;
    }

    tbody.innerHTML = tasks.map(t => {
        const shortId = t.id.substring(0, 8);
        const isDeleteChecked = selectedTaskIds.has(t.id);
        const isCompareChecked = compareTaskIds.has(t.id);
        const promptNames = (t.prompt_names || []).join(', ') || '-';
        return `
        <tr data-task-id="${t.id}">
            <td style="text-align:center;"><input type="checkbox" class="task-checkbox" value="${t.id}"
                ${isDeleteChecked ? 'checked' : ''}
                onchange="onTaskCheckboxChange('${t.id}', this.checked)"></td>
            <td class="text-gray-500 text-xs font-mono" title="${t.id}">${shortId}</td>
            <td class="text-xs text-gray-500">${formatDateTime(t.created_at)}</td>
            <td class="text-xs">${escapeHtml(t.model_name || '-')}</td>
            <td class="text-xs">${escapeHtml(t.strategy || '-')}</td>
            <td class="text-xs">${t.concurrency || 1}</td>
            <td class="text-xs" title="${escapeHtml(promptNames)}">${escapeHtml(truncateText(promptNames, 20))}</td>
            <td class="text-xs">${t.total_rows || 0}</td>
            <td class="text-xs" style="text-align:center;">
                ${t.status === 'running'
                    ? `<span style="font-size:12px;"><span style="color:#16a34a;">完成 ${t.completed_count ?? 0}</span><span style="color:#6b7280;"> - </span><span style="color:#d97706;">标注中 ${t.annotating_count ?? 0}</span><span style="color:#6b7280;"> - </span><span style="color:#3b82f6;">排队中 ${t.queuing_count ?? 0}</span></span>`
                    : `<span class="text-green-600">${t.success_count || 0}</span> / <span class="text-red-500">${t.failed_count || 0}</span>`
                }
            </td>
            <td class="text-xs">${formatPercent(t.accuracy)}</td>
            <td class="text-xs">${formatPercent(t.recall)}</td>
            <td class="text-xs">${formatPercent(t.precision)}</td>
            <td class="text-xs">${formatPercent(t.f1_score)}</td>
            <td>${renderStatusBadge(t.status)}</td>
            <td>
                <div class="flex gap-1">
                    <button class="btn-secondary btn-sm" style="font-size:11px;padding:2px 8px;"
                        onclick="showTaskDetail('${t.id}')">详情</button>
                    <button class="btn-danger btn-sm" style="font-size:11px;padding:2px 8px;"
                        onclick="deleteTask('${t.id}')">删除</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ========== 状态徽章渲染 ==========

function renderStatusBadge(status) {
    const config = {
        success:   { label: '完成',   cls: 'badge--success' },
        failed:    { label: '失败',   cls: 'badge--error' },
        running:   { label: '运行中', cls: 'badge--info' },
        pending:   { label: '等待中', cls: 'badge--gray' },
        cancelled: { label: '已取消', cls: 'badge--warning' },
    };
    const c = config[status] || { label: status, cls: 'badge--gray' };
    return `<span class="badge ${c.cls}">${c.label}</span>`;
}

// ========== 任务列表分页（参考工作台样式） ==========

function renderTaskPagination(total, page, pages) {
    const info = document.getElementById('pagination-info');
    const btns = document.getElementById('pagination-btns');
    info.textContent = `共 ${total} 条`;
    if (pages <= 1) { btns.innerHTML = ''; return; }

    let html = '';
    html += `<button style="padding:4px 8px; font-size:12px; border:1px solid #d1d5db; border-radius:4px; background:#fff; cursor:pointer; ${page <= 1 ? 'opacity:0.4; cursor:not-allowed;' : ''}"
        ${page <= 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">上一页</button>`;

    const pageNums = buildPageNumbers(page, pages);
    pageNums.forEach(p => {
        if (p === '...') {
            html += '<span style="padding:4px 8px; font-size:12px; color:#9ca3af;">…</span>';
        } else {
            const isActive = p === page;
            html += `<button style="padding:4px 8px; font-size:12px; border:1px solid ${isActive ? '#2563eb' : '#d1d5db'}; border-radius:4px; background:${isActive ? '#2563eb' : '#fff'}; color:${isActive ? '#fff' : '#374151'}; cursor:pointer;"
                onclick="goToPage(${p})">${p}</button>`;
        }
    });

    html += `<button style="padding:4px 8px; font-size:12px; border:1px solid #d1d5db; border-radius:4px; background:#fff; cursor:pointer; ${page >= pages ? 'opacity:0.4; cursor:not-allowed;' : ''}"
        ${page >= pages ? 'disabled' : ''} onclick="goToPage(${page + 1})">下一页</button>`;
    btns.innerHTML = html;
}

function buildPageNumbers(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [1];
    if (current > 3) pages.push('...');
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
        pages.push(i);
    }
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
}

async function goToPage(page) {
    currentPage = page;
    // 翻页时清空选中状态
    selectedTaskIds.clear();
    compareTaskIds.clear();
    updateBatchDeleteBtn();
    updateCompareButton();
    await loadTaskList();
    window.scrollTo(0, 0);
}

// ========== 任务选择（多选删除 + 对比） ==========

function onTaskCheckboxChange(taskId, checked) {
    if (checked) {
        selectedTaskIds.add(taskId);
        // 对比选择：最多2个
        if (compareTaskIds.size < 2) {
            compareTaskIds.add(taskId);
        }
    } else {
        selectedTaskIds.delete(taskId);
        compareTaskIds.delete(taskId);
    }
    updateBatchDeleteBtn();
    updateCompareButton();
    updateSelectAllCheckbox();
}

function toggleSelectAll(checkbox) {
    const checkboxes = document.querySelectorAll('.task-checkbox');
    if (checkbox.checked) {
        selectedTaskIds.clear();
        compareTaskIds.clear();
        checkboxes.forEach(cb => {
            cb.checked = true;
            selectedTaskIds.add(cb.value);
            if (compareTaskIds.size < 2) {
                compareTaskIds.add(cb.value);
            }
        });
    } else {
        selectedTaskIds.clear();
        compareTaskIds.clear();
        checkboxes.forEach(cb => { cb.checked = false; });
    }
    updateBatchDeleteBtn();
    updateCompareButton();
}

function updateSelectAllCheckbox() {
    const selectAllCb = document.getElementById('selectAllCb');
    const checkboxes = document.querySelectorAll('.task-checkbox');
    if (checkboxes.length === 0) return;
    selectAllCb.checked = [...checkboxes].every(cb => cb.checked);
}

function updateBatchDeleteBtn() {
    const btn = document.getElementById('batchDeleteBtn');
    const info = document.getElementById('selectedCountInfo');
    const numEl = document.getElementById('selectedCountNum');
    const count = selectedTaskIds.size;
    if (count > 0) {
        btn.style.display = 'inline-block';
        btn.textContent = `删除选中(${count})`;
        info.style.display = 'inline';
        numEl.textContent = count;
    } else {
        btn.style.display = 'none';
        info.style.display = 'none';
    }
}

function updateCompareButton() {
    const btn = document.getElementById('compareBtn');
    btn.disabled = compareTaskIds.size !== 2;
}

// ========== 任务删除 ==========

async function deleteTask(taskId) {
    const confirmed = await showConfirm('确认删除', '确定要删除该任务及其所有标注结果吗？此操作不可撤销。');
    if (!confirmed) return;

    // 找到点击按钮（通过 onclick 属性定位）
    const btn = document.querySelector(`[onclick="deleteTask('${taskId}')"]`);
    if (btn) lockBtn(btn, '删除中...');
    try {
        await apiDelete(`/api/tasks/${taskId}`);
        showToast('任务已删除', 'success');
        selectedTaskIds.delete(taskId);
        compareTaskIds.delete(taskId);
        updateBatchDeleteBtn();
        updateCompareButton();
        await loadTaskList();
    } catch (e) {
        // apiRequest 已 toast
    } finally {
        if (btn) unlockBtn(btn);
    }
}

// ========== 批量删除 ==========

async function deleteSelectedTasks() {
    const count = selectedTaskIds.size;
    if (count === 0) return;
    const confirmed = await showConfirm('确认批量删除', `确定要删除选中的 ${count} 个任务及其所有标注结果吗？此操作不可撤销。`);
    if (!confirmed) return;

    const btn = document.getElementById('batchDeleteBtn');
    lockBtn(btn, '删除中...');
    try {
        await apiRequest('/api/tasks/batch', {
            method: 'DELETE',
            body: { task_ids: [...selectedTaskIds] },
        });
        showToast(`已删除 ${count} 个任务`, 'success');
        selectedTaskIds.clear();
        compareTaskIds.clear();
        updateBatchDeleteBtn();
        updateCompareButton();
        await loadTaskList();
    } catch (e) {
        // apiRequest 已 toast
    } finally {
        unlockBtn(btn);
    }
}

// ========== 任务详情弹框 ==========

async function showTaskDetail(taskId) {
    currentDetailTaskId = taskId;
    const modal = document.getElementById('taskDetailModal');
    modal.style.display = 'flex';

    // 先清空内容并显示加载中
    document.getElementById('detailBasicInfo').innerHTML = '<div style="color:#9ca3af; font-size:13px;">加载中...</div>';
    document.getElementById('detailMetricsInfo').innerHTML = '';

    try {
        // 调用任务详情 API（只取 task_info，不需要行级数据）
        const data = await apiGet(`/api/tasks/${taskId}/detail?page=1&size=1`);
        renderDetailModal(data.task_info);
    } catch (e) {
        document.getElementById('detailBasicInfo').innerHTML = '<div style="color:#dc2626; font-size:13px;">加载失败</div>';
    }
}

function renderDetailModal(taskInfo) {
    const shortId = taskInfo.id.substring(0, 8);
    document.getElementById('detailModalTitle').textContent = `任务详情 - ${shortId}`;

    // 耗时格式化
    let durationStr = '-';
    if (taskInfo.total_duration_ms != null) {
        const ms = taskInfo.total_duration_ms;
        if (ms < 1000) {
            durationStr = `${ms}ms`;
        } else if (ms < 60000) {
            durationStr = `${(ms / 1000).toFixed(1)}秒`;
        } else {
            const m = Math.floor(ms / 60000);
            const s = Math.round((ms % 60000) / 1000);
            durationStr = `${m}分${s}秒`;
        }
    }

    // Prompt角色名
    const promptNames = (taskInfo.prompt_names || []).join(', ') || '-';

    // 基本信息
    const infoItems = [
        { label: '模型', value: taskInfo.model_name || '-', icon: '🤖' },
        { label: '方案', value: taskInfo.strategy || '-', icon: '📋' },
        { label: '并发', value: taskInfo.concurrency || 1, icon: '⚡' },
        { label: 'Prompt角色', value: promptNames, icon: '🎭' },
        { label: '创建时间', value: formatDateTime(taskInfo.created_at), icon: '🕐' },
        { label: '耗时', value: durationStr, icon: '⏱' },
        { label: '总行数', value: taskInfo.total_rows || 0, icon: '📊' },
        { label: '状态', value: renderStatusBadge(taskInfo.status), icon: '📌', isHtml: true },
    ];

    document.getElementById('detailBasicInfo').innerHTML = infoItems.map(item => {
        const val = item.isHtml ? item.value : escapeHtml(String(item.value));
        return `<div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
            <span style="font-size:14px; width:20px; text-align:center;">${item.icon}</span>
            <span style="color:#6b7280; font-size:13px; min-width:72px;">${item.label}</span>
            <span style="font-size:13px; font-weight:500; color:#1f2937;">${val}</span>
        </div>`;
    }).join('');

    // 测试指标（与工作台统计指标一致）
    const tp = taskInfo.tp_count ?? 0;
    const tn = taskInfo.tn_count ?? 0;
    const fp = taskInfo.fp_count ?? 0;
    const fn = taskInfo.fn_count ?? 0;
    const unknown = taskInfo.unknown_count ?? 0;
    const annotated = taskInfo.annotated_count ?? taskInfo.success_count ?? 0;
    const successCount = taskInfo.success_count ?? 0;
    const failedCount = taskInfo.failed_count ?? 0;

    const metricsHtml = `
    <!-- 指标卡片 -->
    <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:16px;">
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:12px; text-align:center;">
            <div style="font-size:11px; color:#166534; margin-bottom:4px;">准确率</div>
            <div style="font-size:20px; font-weight:700; color:#166534;">${formatPercent(taskInfo.accuracy)}</div>
        </div>
        <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:12px; text-align:center;">
            <div style="font-size:11px; color:#1e40af; margin-bottom:4px;">查全率</div>
            <div style="font-size:20px; font-weight:700; color:#1e40af;">${formatPercent(taskInfo.recall)}</div>
        </div>
        <div style="background:#fefce8; border:1px solid #fde68a; border-radius:8px; padding:12px; text-align:center;">
            <div style="font-size:11px; color:#854d0e; margin-bottom:4px;">查准率</div>
            <div style="font-size:20px; font-weight:700; color:#854d0e;">${formatPercent(taskInfo.precision)}</div>
        </div>
        <div style="background:#faf5ff; border:1px solid #e9d5ff; border-radius:8px; padding:12px; text-align:center;">
            <div style="font-size:11px; color:#7c3aed; margin-bottom:4px;">F1</div>
            <div style="font-size:20px; font-weight:700; color:#7c3aed;">${formatPercent(taskInfo.f1_score)}</div>
        </div>
    </div>

    <!-- 混淆矩阵标签 -->
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
        <span style="background:#dcfce7; color:#166534; border-radius:4px; padding:4px 12px; font-size:12px; font-weight:600;">TP: ${tp}</span>
        <span style="background:#fee2e2; color:#991b1b; border-radius:4px; padding:4px 12px; font-size:12px; font-weight:600;">FN: ${fn}</span>
        <span style="background:#fef9c3; color:#854d0e; border-radius:4px; padding:4px 12px; font-size:12px; font-weight:600;">FP: ${fp}</span>
        <span style="background:#dbeafe; color:#1e40af; border-radius:4px; padding:4px 12px; font-size:12px; font-weight:600;">TN: ${tn}</span>
        <span style="background:#f3f4f6; color:#6b7280; border-radius:4px; padding:4px 12px; font-size:12px; font-weight:600;">UN: ${unknown}</span>
    </div>

    <!-- 统计数据 -->
    <div style="display:flex; gap:24px; flex-wrap:wrap; font-size:13px;">
        <span><span style="color:#6b7280;">已标注:</span> <b style="color:#16a34a;">${annotated}</b></span>
        <span><span style="color:#6b7280;">成功:</span> <b style="color:#16a34a;">${successCount}</b></span>
        <span><span style="color:#6b7280;">失败:</span> <b style="color:#dc2626;">${failedCount}</b></span>
    </div>`;

    document.getElementById('detailMetricsInfo').innerHTML = metricsHtml;
}

function closeTaskDetailModal() {
    document.getElementById('taskDetailModal').style.display = 'none';
    currentDetailTaskId = null;
}

// 点击弹框背景关闭
document.addEventListener('click', function(e) {
    if (e.target.id === 'taskDetailModal') {
        closeTaskDetailModal();
    }
});

// Esc 键关闭弹框
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && document.getElementById('taskDetailModal').style.display === 'flex') {
        closeTaskDetailModal();
    }
});

// ========== 重新运行 ==========

async function rerunTask() {
    if (!currentDetailTaskId) return;
    const confirmed = await showConfirm('确认重新运行', '将以相同配置创建一个新任务并执行，确定继续吗？');
    if (!confirmed) return;

    const btn = document.getElementById('rerunBtn');
    lockBtn(btn, '创建中...');
    try {
        const data = await apiPost(`/api/tasks/${currentDetailTaskId}/rerun`, {});
        showToast('新任务已创建并开始执行', 'success');
        closeTaskDetailModal();
        await loadTaskList();
    } catch (e) {
        // apiRequest 已 toast
    } finally {
        unlockBtn(btn);
    }
}

// ========== 任务对比 ==========

async function doCompare() {
    if (compareTaskIds.size !== 2) {
        showToast('请选择2个任务进行对比', 'warning');
        return;
    }

    const [idA, idB] = [...compareTaskIds];
    try {
        const data = await apiGet(`/api/tasks/compare?task_ids=${encodeURIComponent(idA + ',' + idB)}`);
        renderComparePanel(data);
        document.getElementById('comparePanel').style.display = 'block';
        document.getElementById('comparePanel').scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        // apiRequest 已 toast
    }
}

function renderComparePanel(data) {
    const { task_a, task_b, diff } = data;
    const shortIdA = task_a.id.substring(0, 8);
    const shortIdB = task_b.id.substring(0, 8);

    // 指标行
    const metrics = [
        { key: 'accuracy', label: '准确率' },
        { key: 'recall', label: '查全率' },
        { key: 'precision', label: '查准率' },
        { key: 'f1_score', label: 'F1' },
    ];

    let html = '<div class="overflow-x-auto">';
    html += '<table class="data-table">';
    html += '<thead><tr><th>指标</th><th>任务 A（' + escapeHtml(task_a.model_name) + ' / ' + escapeHtml(task_a.strategy) + '）</th>';
    html += '<th>任务 B（' + escapeHtml(task_b.model_name) + ' / ' + escapeHtml(task_b.strategy) + '）</th><th>差异 (A-B)</th></tr></thead>';
    html += '<tbody>';

    // 基本信息行
    html += `<tr>
        <td class="font-medium">任务ID</td>
        <td class="font-mono text-xs">${shortIdA}</td>
        <td class="font-mono text-xs">${shortIdB}</td>
        <td>-</td>
    </tr>`;
    html += `<tr>
        <td class="font-medium">总行数</td>
        <td>${task_a.total_rows || 0}</td>
        <td>${task_b.total_rows || 0}</td>
        <td>${(task_a.total_rows || 0) - (task_b.total_rows || 0)}</td>
    </tr>`;
    html += `<tr>
        <td class="font-medium">成功/失败</td>
        <td>${task_a.success_count || 0} / ${task_a.failed_count || 0}</td>
        <td>${task_b.success_count || 0} / ${task_b.failed_count || 0}</td>
        <td>-</td>
    </tr>`;

    // 指标行
    metrics.forEach(m => {
        const valA = task_a[m.key] != null ? formatPercent(task_a[m.key]) : '-';
        const valB = task_b[m.key] != null ? formatPercent(task_b[m.key]) : '-';
        const diffKey = m.key + '_diff';
        const diffVal = diff[diffKey];
        const diffColor = diffVal > 0 ? 'color:#16a34a' : diffVal < 0 ? 'color:#dc2626' : 'color:#9ca3af';

        html += `<tr>
            <td class="font-medium">${m.label}</td>
            <td>${valA}</td>
            <td>${valB}</td>
            <td style="${diffColor}; font-weight:600;">${diffVal != null ? (diffVal > 0 ? '+' : '') + formatPercent(diffVal) : '-'}</td>
        </tr>`;
    });

    html += '</tbody></table></div>';
    document.getElementById('compareContent').innerHTML = html;
}

// ========== 工具函数 ==========

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
