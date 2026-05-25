/**
 * 数据飞轮 - Excel 数据管理页面逻辑
 */

// ========== 全局状态 ==========
let currentPage = 1;
let currentSortBy = null;
let currentOrder = 'asc';
let currentSceneId = '';
let currentSearch = '';
let allScenes = [];
let pagination = null;
let renamingFileId = null;
let displayColumnsFileId = null;

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
    pagination = new Pagination('pagination', {
        pageSize: 20,
        onChange: (page) => {
            currentPage = page;
            loadExcelList();
        }
    });

    loadSceneList();
    loadExcelList();
    bindEvents();
});

// ========== 场景列表加载 ==========
async function loadSceneList() {
    try {
        allScenes = await apiGet('/api/scenes');
        // 填充场景过滤下拉框
        const sceneFilter = document.getElementById('sceneFilter');
        sceneFilter.innerHTML = '<option value="">全部场景</option>';
        allScenes.forEach(scene => {
            sceneFilter.innerHTML += `<option value="${scene.id}">${scene.name}</option>`;
        });

        // 填充上传弹窗场景下拉框
        const uploadSceneSelect = document.getElementById('uploadSceneSelect');
        uploadSceneSelect.innerHTML = '';
        allScenes.forEach(scene => {
            uploadSceneSelect.innerHTML += `<option value="${scene.id}">${scene.name}</option>`;
        });
        // 默认选中第一个场景
        if (allScenes.length > 0) {
            uploadSceneSelect.value = allScenes[0].id;
        }
    } catch (e) {
        console.error('加载场景列表失败:', e);
    }
}

// ========== Excel 列表加载 ==========
async function loadExcelList() {
    showLoading('加载数据列表...');
    try {
        const params = new URLSearchParams({
            page: currentPage,
            size: 20,
        });
        if (currentSceneId) params.set('scene_id', currentSceneId);
        if (currentSearch) params.set('search', currentSearch);
        if (currentSortBy) {
            params.set('sort_by', currentSortBy);
            params.set('order', currentOrder);
        }

        const data = await apiGet(`/api/excel/list?${params.toString()}`);
        renderTable(data.items);
        pagination.update(data.total, currentPage);

        // 空状态处理
        const emptyState = document.getElementById('emptyState');
        if (data.total === 0) {
            emptyState.style.display = 'flex';
        } else {
            emptyState.style.display = 'none';
        }
    } catch (e) {
        console.error('加载Excel列表失败:', e);
    } finally {
        hideLoading();
    }
}

// ========== 渲染表格 ==========
function renderTable(items) {
    const tbody = document.getElementById('excelTableBody');
    if (!items || items.length === 0) {
        tbody.innerHTML = '';
        return;
    }

    tbody.innerHTML = items.map((item, index) => {
        // 列信息展示（截断显示，双击弹窗查看完整）
        const columnsInfo = item.columns_info || [];
        const columnsText = columnsInfo.join(', ');
        const columnsTitle = columnsText;
        const columnsDisplay = columnsText.length > 30 ? columnsText.slice(0, 30) + '…' : columnsText;

        const sceneName = item.scene_name || '-';

        return `
        <tr>
            <td>${(currentPage - 1) * 20 + index + 1}</td>
            <td>
                <span class="cursor-pointer text-blue-600 hover:text-blue-800" onclick="viewDetail(${item.id})">${truncateText(item.file_name, 30)}</span>
            </td>
            <td>${item.total_rows}</td>
            <td>${item.annotated_count}</td>
            <td><div style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; font-size:13px; color:#374151;" title="${escapeHtml(columnsTitle)}" ondblclick="showColumnDetail(this)">${escapeHtml(columnsDisplay)}</div></td>
            <td>${sceneName}</td>
            <td>
                <div style="display:flex; align-items:center; gap:8px;">
                    <button class="btn-primary-light btn-sm" onclick="goToWorkbench(${item.id})">开始标注</button>
                    <div class="relative">
                        <button class="btn-secondary btn-sm" onclick="toggleMoreMenu(event, ${item.id})">更多 ▾</button>
                        <div class="more-menu" id="moreMenu-${item.id}" style="display:none;">
                            <div class="more-menu__item" onclick="openRenameModal(${item.id}, '${escapeHtml(item.file_name)}')">修改文件名</div>
                            <div class="more-menu__item" onclick="window.location.href='/rule-config'">设定显示列</div>
                            <div class="more-menu__item" onclick="refreshLocal(${item.id})">刷新本地Excel</div>
                            <div class="more-menu__item more-menu__item--danger" onclick="deleteExcel(${item.id}, '${escapeHtml(item.file_name)}')">删除</div>
                        </div>
                    </div>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ========== 事件绑定 ==========
function bindEvents() {
    // 场景过滤
    document.getElementById('sceneFilter').addEventListener('change', (e) => {
        currentSceneId = e.target.value;
        currentPage = 1;
        loadExcelList();
    });

    // 搜索（防抖）
    let searchTimer = null;
    document.getElementById('searchInput').addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            currentSearch = e.target.value.trim();
            currentPage = 1;
            loadExcelList();
        }, 300);
    });

    // 排序列头点击
    document.querySelectorAll('.cursor-pointer[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const sortBy = th.dataset.sort;
            if (currentSortBy === sortBy) {
                currentOrder = currentOrder === 'asc' ? 'desc' : 'asc';
            } else {
                currentSortBy = sortBy;
                currentOrder = 'asc';
            }
            currentPage = 1;
            loadExcelList();
        });
    });

    // 上传按钮
    document.getElementById('uploadBtn').addEventListener('click', () => {
        document.getElementById('uploadModal').style.display = 'flex';
    });
    document.getElementById('uploadCancelBtn').addEventListener('click', () => {
        document.getElementById('uploadModal').style.display = 'none';
        resetUploadArea();
    });
    document.getElementById('uploadConfirmBtn').addEventListener('click', handleUpload);

    // 全局刷新按钮
    document.getElementById('refreshAllBtn').addEventListener('click', handleRefreshAll);

    // 修改文件名弹窗
    document.getElementById('renameCancelBtn').addEventListener('click', () => {
        document.getElementById('renameModal').style.display = 'none';
        renamingFileId = null;
    });
    document.getElementById('renameConfirmBtn').addEventListener('click', handleRename);

    // 设定显示列弹窗
    document.getElementById('displayColumnsCancelBtn').addEventListener('click', () => {
        document.getElementById('displayColumnsModal').style.display = 'none';
        displayColumnsFileId = null;
    });
    document.getElementById('displayColumnsConfirmBtn').addEventListener('click', handleDisplayColumns);

    // 点击其他区域关闭更多菜单
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.more-menu') && !e.target.closest('[onclick*="toggleMoreMenu"]')) {
            document.querySelectorAll('.more-menu').forEach(menu => menu.style.display = 'none');
        }
    });

    // 弹窗遮罩层点击关闭
    document.getElementById('uploadModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    document.getElementById('renameModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    document.getElementById('displayColumnsModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const modals = ['uploadModal', 'renameModal', 'displayColumnsModal'];
            modals.forEach(id => {
                const m = document.getElementById(id);
                if (m && m.style.display === 'flex') m.style.display = 'none';
            });
        }
    });
}

// ========== 上传处理 ==========
async function handleUpload() {
    const fileInput = document.getElementById('fileInput');
    const sceneSelect = document.getElementById('uploadSceneSelect');
    const uploadBtn = document.getElementById('uploadConfirmBtn');

    if (!fileInput.files || fileInput.files.length === 0) {
        showToast('请选择文件', 'warning');
        return;
    }

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('scene_id', sceneSelect.value);

    lockBtn(uploadBtn, '上传中...');
    showLoading('上传并解析中...');
    try {
        const result = await apiUpload('/api/excel/upload', formData);

        // 检查COT名称列
        if (result.has_cot === false) {
            hideLoading();
            unlockBtn(uploadBtn);
            // 延迟50ms避免与hideLoading竞态，确保遮罩完全消失
            await new Promise(r => setTimeout(r, 50));
            const confirmed = await showConfirm('COT名称列缺失', '该Excel文件中未找到COT名称列，是否继续上传？');
            if (!confirmed) {
                // 用户取消：删除刚上传的文件
                try {
                    await apiDelete(`/api/excel/${result.id}`);
                    showToast('已取消上传', 'warning');
                } catch (delErr) {
                    console.error('删除上传文件失败:', delErr);
                }
                document.getElementById('uploadModal').style.display = 'none';
                resetUploadArea();
                return;
            }
            showLoading('完成上传...');
            lockBtn(uploadBtn, '上传中...');
        }

        showToast(`上传成功：${result.total_rows}行数据，${result.columns_info.length}列`, 'success');
        document.getElementById('uploadModal').style.display = 'none';
        // 重置文件输入和上传区域
        resetUploadArea();
        // 重新加载列表
        loadExcelList();
    } catch (e) {
        console.error('上传失败:', e);
    } finally {
        hideLoading();
        unlockBtn(uploadBtn);
    }
}

// ========== 全局刷新 ==========
async function handleRefreshAll() {
    const confirmed = await showConfirm('全局刷新确认', '将遍历所有Excel文件，从数据库重新生成本地Excel文件，是否继续？');
    if (!confirmed) return;

    const btn = document.getElementById('refreshAllBtn');
    lockBtn(btn, '刷新中...');
    showLoading('全局刷新中...');
    try {
        const result = await apiPost('/api/excel/refresh-all', {});
        if (result.fail_count > 0) {
            showToast(`刷新完成：成功${result.success_count}个，失败${result.fail_count}个`, 'warning');
        } else {
            showToast(`全部刷新成功：${result.success_count}个文件`, 'success');
        }
    } catch (e) {
        console.error('全局刷新失败:', e);
    } finally {
        hideLoading();
        unlockBtn(btn);
    }
}

// ========== 更多菜单 ==========
function toggleMoreMenu(event, fileId) {
    event.stopPropagation();
    // 先关闭所有其他菜单
    document.querySelectorAll('.more-menu').forEach(menu => menu.style.display = 'none');
    const menu = document.getElementById(`moreMenu-${fileId}`);
    if (menu) {
        menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    }
}

// ========== 修改文件名 ==========
function openRenameModal(fileId, currentName) {
    renamingFileId = fileId;
    document.getElementById('renameInput').value = currentName;
    document.getElementById('renameModal').style.display = 'flex';
    // 关闭更多菜单
    document.querySelectorAll('.more-menu').forEach(menu => menu.style.display = 'none');
}

async function handleRename() {
    if (!renamingFileId) return;
    const newName = document.getElementById('renameInput').value.trim();
    if (!newName) {
        showToast('文件名不能为空', 'warning');
        return;
    }

    const btn = document.getElementById('renameConfirmBtn');
    lockBtn(btn, '保存中...');
    try {
        await apiPut(`/api/excel/${renamingFileId}`, { file_name: newName });
        showToast('文件名修改成功', 'success');
        document.getElementById('renameModal').style.display = 'none';
        renamingFileId = null;
        loadExcelList();
    } catch (e) {
        console.error('修改文件名失败:', e);
    } finally {
        unlockBtn(btn);
    }
}

// ========== 设定显示列 ==========
async function openDisplayColumnsModal(fileId) {
    displayColumnsFileId = fileId;
    // 关闭更多菜单
    document.querySelectorAll('.more-menu').forEach(menu => menu.style.display = 'none');

    // 获取文件详情
    try {
        const detail = await apiGet(`/api/excel/${fileId}`);
        const columns = detail.columns_info || [];
        const displayColumns = detail.display_columns || [];

        const listContainer = document.getElementById('displayColumnsList');
        listContainer.innerHTML = columns.map(col => {
            const isChecked = displayColumns.includes(col);
            return `
            <label class="flex items-center space-x-2 cursor-pointer py-1">
                <input type="checkbox" class="display-col-checkbox" value="${escapeHtml(col)}" ${isChecked ? 'checked' : ''}>
                <span class="text-sm text-gray-700">${col}</span>
            </label>`;
        }).join('');

        document.getElementById('displayColumnsModal').style.display = 'flex';
    } catch (e) {
        console.error('获取文件详情失败:', e);
    }
}

async function handleDisplayColumns() {
    if (!displayColumnsFileId) return;
    const checkboxes = document.querySelectorAll('.display-col-checkbox:checked');
    const selectedColumns = Array.from(checkboxes).map(cb => cb.value);

    const btn = document.getElementById('displayColumnsConfirmBtn');
    lockBtn(btn, '保存中...');
    try {
        await apiPut(`/api/excel/${displayColumnsFileId}/display-columns`, { display_columns: selectedColumns });
        showToast('显示列设定成功', 'success');
        document.getElementById('displayColumnsModal').style.display = 'none';
        displayColumnsFileId = null;
        loadExcelList();
    } catch (e) {
        console.error('设定显示列失败:', e);
    } finally {
        unlockBtn(btn);
    }
}

// ========== 刷新本地Excel ==========
async function refreshLocal(fileId) {
    // 关闭更多菜单
    document.querySelectorAll('.more-menu').forEach(menu => menu.style.display = 'none');

    const confirmed = await showConfirm('刷新确认', '将从数据库重新生成本地Excel文件，覆盖原文件，是否继续？');
    if (!confirmed) return;

    showLoading('刷新本地文件...');
    try {
        const result = await apiPost(`/api/excel/${fileId}/refresh-local`, {});
        showToast(result.message || '刷新成功', 'success');
    } catch (e) {
        console.error('刷新本地Excel失败:', e);
    } finally {
        hideLoading();
    }
}

// ========== 删除 ==========
async function deleteExcel(fileId, fileName) {
    // 关闭更多菜单
    document.querySelectorAll('.more-menu').forEach(menu => menu.style.display = 'none');

    const confirmed = await showConfirm('删除确认', `确定要删除文件 "${fileName}" 吗？关联的标注任务和标注结果也会被删除，此操作不可恢复。`);
    if (!confirmed) return;

    try {
        await apiDelete(`/api/excel/${fileId}`);
        showToast('删除成功', 'success');
        loadExcelList();
    } catch (e) {
        console.error('删除失败:', e);
    }
}

// ========== 开始标注（跳转工作台） ==========
function goToWorkbench(fileId) {
    window.location.href = '/workbench?file_id=' + fileId;
}

// ========== 查看详情 ==========
async function viewDetail(fileId) {
    try {
        const detail = await apiGet(`/api/excel/${fileId}`);
        const panel = getDetailPanel();

        // 构建详情内容
        let content = '<div class="space-y-4">';
        content += `<div class="detail-field"><span class="detail-label">文件名</span><span class="detail-value">${detail.file_name}</span></div>`;
        content += `<div class="detail-field"><span class="detail-label">原始文件名</span><span class="detail-value">${detail.original_file_name || '-'}</span></div>`;
        content += `<div class="detail-field"><span class="detail-label">总行数</span><span class="detail-value">${detail.total_rows}</span></div>`;
        content += `<div class="detail-field"><span class="detail-label">已标注数量</span><span class="detail-value">${detail.annotated_count}</span></div>`;
        content += `<div class="detail-field"><span class="detail-label">所属场景</span><span class="detail-value">${detail.scene_name || '-'}</span></div>`;
        content += `<div class="detail-field"><span class="detail-label">文件路径</span><span class="detail-value text-xs break-all">${detail.file_path || '-'}</span></div>`;
        content += `<div class="detail-field"><span class="detail-label">创建时间</span><span class="detail-value">${formatDateTime(detail.created_at)}</span></div>`;
        content += `<div class="detail-field"><span class="detail-label">更新时间</span><span class="detail-value">${formatDateTime(detail.updated_at)}</span></div>`;

        // 列信息
        content += '<div class="detail-field"><span class="detail-label">包含列信息</span><div class="flex flex-wrap gap-1 mt-1">';
        (detail.columns_info || []).forEach(col => {
            content += `<span class="badge badge--info">${col}</span>`;
        });
        content += '</div></div>';

        // 显示列
        content += '<div class="detail-field"><span class="detail-label">显示列</span><div class="flex flex-wrap gap-1 mt-1">';
        (detail.display_columns || []).forEach(col => {
            content += `<span class="badge badge--info">${col}</span>`;
        });
        content += '</div></div>';

        content += '</div>';

        panel.show(`文件详情 - ${detail.file_name}`, content);
    } catch (e) {
        console.error('获取详情失败:', e);
    }
}

// ========== 包含的列双击弹窗 ==========
function showColumnDetail(el) {
    const text = el.getAttribute('title') || el.textContent;
    let modal = document.getElementById('column-detail-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'column-detail-modal';
        modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:50; display:flex; align-items:center; justify-content:center;';
        modal.innerHTML = `
            <div style="background:#fff; border-radius:10px; padding:20px 24px; max-width:500px; max-height:70vh; overflow-y:auto; box-shadow:0 8px 32px rgba(0,0,0,0.15); min-width:300px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <h3 style="font-size:14px; font-weight:600; color:#111827; margin:0;">包含的列</h3>
                    <button onclick="document.getElementById('column-detail-modal').style.display='none'" style="background:none; border:none; font-size:18px; cursor:pointer; color:#6b7280;">✕</button>
                </div>
                <div id="column-detail-content" style="font-size:13px; color:#374151; line-height:1.8; word-break:break-all;"></div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    }
    // 将列名以标签形式展示
    const columns = text.split(',').map(c => c.trim()).filter(Boolean);
    document.getElementById('column-detail-content').innerHTML = columns.map(c =>
        `<span style="display:inline-block; padding:2px 8px; margin:2px 4px; background:#f3f4f6; border-radius:4px; font-size:12px;">${c}</span>`
    ).join('');
    modal.style.display = 'flex';
}

// ========== 文件选择与拖拽上传 ==========
function resetUploadArea() {
    const fileInput = document.getElementById('fileInput');
    fileInput.value = '';
    document.getElementById('file-upload-placeholder').style.display = '';
    document.getElementById('file-upload-info').style.display = 'none';
    const area = document.getElementById('file-upload-area');
    area.style.borderColor = '#d1d5db';
    area.style.background = 'transparent';
}

function handleFileSelect(input) {
    const file = input.files[0];
    if (file) showFileInfo(file);
}

function handleFileDrop(event) {
    event.preventDefault();
    const area = document.getElementById('file-upload-area');
    area.style.borderColor = '#d1d5db';
    area.style.background = 'transparent';
    const file = event.dataTransfer.files[0];
    if (file) {
        const dt = new DataTransfer();
        dt.items.add(file);
        document.getElementById('fileInput').files = dt.files;
        showFileInfo(file);
    }
}

function showFileInfo(file) {
    document.getElementById('file-upload-placeholder').style.display = 'none';
    document.getElementById('file-upload-info').style.display = 'block';
    document.getElementById('file-name-display').textContent = file.name;
    const sizeKB = (file.size / 1024).toFixed(1);
    document.getElementById('file-size-display').textContent = sizeKB > 1024
        ? (file.size / 1024 / 1024).toFixed(1) + ' MB'
        : sizeKB + ' KB';
    // 高亮边框表示已选文件
    const area = document.getElementById('file-upload-area');
    area.style.borderColor = '#16a34a';
    area.style.background = '#f0fdf4';
}

// ========== 工具函数 ==========
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
