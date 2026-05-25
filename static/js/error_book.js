/**
 * 数据飞轮 - 错题集管理页面逻辑
 * 场景切换、数据集下拉、COT名称下拉、错题列表（分页/搜索）、新增/编辑/删除/查看详情
 */

// ========== 页面状态 ==========
let scenes = [];                       // 场景列表
let currentSceneId = null;             // 当前选中的场景ID
let datasets = [];                     // 当前场景的数据集列表
let cotNames = [];                     // 当前筛选条件下的COT名称列表
let errorBooks = { items: [], total: 0, page: 1, size: 20 }; // 错题列表数据
let editingErrorId = null;             // 正在编辑的错题ID（null=新增）
let pagination = null;                 // 分页器组件实例

// ========== DOM 引用 ==========
const sceneListEl = document.getElementById('scene-list');
const sceneAddBtn = document.getElementById('scene-add-btn');
const filterBar = document.getElementById('filter-bar');
const filterDataset = document.getElementById('filter-dataset');
const filterCotName = document.getElementById('filter-cot-name');
const filterSearch = document.getElementById('filter-search');
const filterSearchBtn = document.getElementById('filter-search-btn');
const addErrorBtn = document.getElementById('add-error-btn');
const errorbookContent = document.getElementById('errorbook-content');
const emptyState = document.getElementById('empty-state');
const errorTable = document.getElementById('error-table');
const errorTableBody = document.getElementById('error-table-body');
const paginationContainer = document.getElementById('pagination-container');

// 错题弹窗
const errorModal = document.getElementById('error-modal');
const errorModalTitle = document.getElementById('error-modal-title');
const modalDataset = document.getElementById('modal-dataset');
const modalCotNameSelect = document.getElementById('modal-cot-name-select');
const modalCotNameInput = document.getElementById('modal-cot-name-input');
let modalCotNames = [];  // 弹窗中可选的COT名称列表
const modalOriginalData = document.getElementById('modal-original-data');
const modalErrorReason = document.getElementById('modal-error-reason');
const errorModalCancel = document.getElementById('error-modal-cancel');
const errorModalConfirm = document.getElementById('error-modal-confirm');

// 场景弹窗
const sceneModal = document.getElementById('scene-modal');
const sceneModalName = document.getElementById('scene-modal-name');
const sceneModalDesc = document.getElementById('scene-modal-desc');
const sceneModalCancel = document.getElementById('scene-modal-cancel');
const sceneModalConfirm = document.getElementById('scene-modal-confirm');

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
    // 初始化分页器
    pagination = new Pagination('pagination-container', {
        pageSize: 20,
        onChange: (page) => loadErrorBooks(page),
    });
    await loadScenes();
    bindEvents();
});

// ========== 场景列表 ==========
async function loadScenes() {
    try {
        scenes = await apiGet('/api/scenes');
    } catch (e) {
        scenes = [];
    }
    renderSceneList();
    const urlSceneId = getUrlParam('scene_id');
    if (urlSceneId && scenes.find(s => s.id == urlSceneId)) {
        selectScene(parseInt(urlSceneId));
    } else if (scenes.length > 0) {
        selectScene(scenes[0].id);
    } else {
        currentSceneId = null;
        showEmptyState();
    }
}

function renderSceneList() {
    if (!sceneListEl) return;
    let html = '';
    scenes.forEach(scene => {
        const isActive = scene.id === currentSceneId;
        html += `
            <div class="errorbook-scene-item ${isActive ? 'errorbook-scene-item--active' : ''}" data-scene-id="${scene.id}">
                <span class="errorbook-scene-item__name" title="${scene.name}">${scene.name}</span>
            </div>
        `;
    });
    sceneListEl.innerHTML = html;
    sceneListEl.querySelectorAll('.errorbook-scene-item').forEach(item => {
        item.addEventListener('click', () => selectScene(parseInt(item.dataset.sceneId)));
    });
}

async function selectScene(sceneId) {
    currentSceneId = sceneId;
    setUrlParam('scene_id', sceneId);
    renderSceneList();
    // 重置筛选条件
    filterSearch.value = '';
    filterCotName.innerHTML = '<option value="">全部COT</option>';
    // 加载数据集下拉
    await loadDatasets(sceneId);
    // 加载COT名称下拉
    await loadCotNames(sceneId, null);
    // 显示筛选栏
    filterBar.style.display = 'flex';
    // 加载错题列表
    await loadErrorBooks(1);
}

// ========== 数据集下拉 ==========
async function loadDatasets(sceneId) {
    if (!sceneId) {
        datasets = [];
        renderDatasetSelect();
        return;
    }
    try {
        datasets = await apiGet(`/api/error-books/datasets?scene_id=${sceneId}`);
    } catch (e) {
        datasets = [];
    }
    renderDatasetSelect();
}

function renderDatasetSelect() {
    let html = '<option value="">全部数据集</option>';
    datasets.forEach(ds => {
        html += `<option value="${ds.id}">${ds.file_name}</option>`;
    });
    filterDataset.innerHTML = html;
    // 同步更新弹窗中的数据集下拉
    let modalHtml = '<option value="">请选择数据集</option>';
    datasets.forEach(ds => {
        modalHtml += `<option value="${ds.id}">${ds.file_name}</option>`;
    });
    modalDataset.innerHTML = modalHtml;
}

// ========== 弹窗COT名称下拉 ==========
async function loadModalCotNames(sceneId, fileId) {
    if (!sceneId) {
        modalCotNames = [];
        renderModalCotNameSelect();
        return;
    }
    let url = `/api/error-books/cot-names?scene_id=${sceneId}`;
    if (fileId) url += `&file_id=${fileId}`;
    try {
        modalCotNames = await apiGet(url);
    } catch (e) {
        modalCotNames = [];
    }
    renderModalCotNameSelect();
}

function renderModalCotNameSelect(defaultValue = '') {
    let html = '<option value="">请选择COT名称</option>';
    modalCotNames.forEach(name => {
        const selected = name === defaultValue ? ' selected' : '';
        html += `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
    });
    html += '<option value="__custom__">自定义输入...</option>';
    modalCotNameSelect.innerHTML = html;
    // 默认隐藏自定义输入框
    modalCotNameInput.style.display = 'none';
    modalCotNameInput.value = '';
}

function handleModalCotNameChange() {
    const val = modalCotNameSelect.value;
    if (val === '__custom__') {
        // 切换为文本输入框
        modalCotNameInput.style.display = 'block';
        modalCotNameInput.focus();
    } else {
        modalCotNameInput.style.display = 'none';
        modalCotNameInput.value = '';
    }
}

// 获取弹窗中最终的COT名称值
function getModalCotNameValue() {
    const selectVal = modalCotNameSelect.value;
    if (selectVal === '__custom__') {
        return modalCotNameInput.value.trim();
    }
    return selectVal;
}

// 设置弹窗中COT名称的值（编辑时使用）
function setModalCotNameValue(value) {
    if (!value) {
        modalCotNameSelect.value = '';
        modalCotNameInput.style.display = 'none';
        modalCotNameInput.value = '';
        return;
    }
    // 检查值是否在选项列表中
    const exists = modalCotNames.includes(value);
    if (exists) {
        modalCotNameSelect.value = value;
        modalCotNameInput.style.display = 'none';
        modalCotNameInput.value = '';
    } else {
        // 值不在选项中，使用自定义输入
        modalCotNameSelect.value = '__custom__';
        modalCotNameInput.style.display = 'block';
        modalCotNameInput.value = value;
    }
}

// ========== COT名称下拉 ==========
async function loadCotNames(sceneId, fileId) {
    if (!sceneId) {
        cotNames = [];
        renderCotNameSelect();
        return;
    }
    let url = `/api/error-books/cot-names?scene_id=${sceneId}`;
    if (fileId) {
        url += `&file_id=${fileId}`;
    }
    try {
        cotNames = await apiGet(url);
    } catch (e) {
        cotNames = [];
    }
    renderCotNameSelect();
}

function renderCotNameSelect() {
    let html = '<option value="">全部COT</option>';
    cotNames.forEach(name => {
        html += `<option value="${name}">${name}</option>`;
    });
    filterCotName.innerHTML = html;
}

// ========== 错题列表 ==========
async function loadErrorBooks(page = 1) {
    if (!currentSceneId) {
        showEmptyState();
        return;
    }
    const fileId = filterDataset.value || '';
    const cotName = filterCotName.value || '';
    const search = filterSearch.value.trim();
    let url = `/api/error-books?scene_id=${currentSceneId}&page=${page}&size=20`;
    if (fileId) url += `&file_id=${fileId}`;
    if (cotName) url += `&cot_name=${encodeURIComponent(cotName)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    try {
        errorBooks = await apiGet(url);
    } catch (e) {
        errorBooks = { items: [], total: 0, page: 1, size: 20 };
    }
    renderErrorTable();
    // 更新分页器
    pagination.update(errorBooks.total, errorBooks.page);
}

function renderErrorTable() {
    if (!errorBooks.items || errorBooks.items.length === 0) {
        errorTable.style.display = 'none';
        emptyState.style.display = 'flex';
        emptyState.querySelector('p').textContent = currentSceneId ? '当前条件下暂无错题' : '请先选择场景查看错题';
        paginationContainer.style.display = 'none';
        return;
    }
    emptyState.style.display = 'none';
    errorTable.style.display = 'table';
    paginationContainer.style.display = 'block';

    // 获取当前分页的起始序号
    const startIndex = (errorBooks.page - 1) * errorBooks.size;

    let html = '';
    errorBooks.items.forEach((item, idx) => {
        // 查找数据集名称
        const datasetName = datasets.find(d => d.id === item.file_id)?.file_name || '-';
        html += `
            <tr>
                <td>${startIndex + idx + 1}</td>
                <td title="${datasetName}">${truncateText(datasetName, 20)}</td>
                <td>${item.cot_name || '-'}</td>
                <td title="${item.original_data}">${truncateText(item.original_data, 30)}</td>
                <td title="${item.error_reason}">${truncateText(item.error_reason, 20)}</td>
                <td class="errorbook-table__actions-td">
                    <div class="errorbook-table__actions">
                        <button class="errorbook-table__action-btn errorbook-table__action-btn--view" data-id="${item.id}">查看</button>
                        <button class="errorbook-table__action-btn errorbook-table__action-btn--edit" data-id="${item.id}">编辑</button>
                        <button class="errorbook-table__action-btn errorbook-table__action-btn--delete" data-id="${item.id}">删除</button>
                    </div>
                </td>
            </tr>
        `;
    });
    errorTableBody.innerHTML = html;

    // 绑定操作按钮事件
    errorTableBody.querySelectorAll('.errorbook-table__action-btn--view').forEach(btn => {
        btn.addEventListener('click', () => viewErrorDetail(parseInt(btn.dataset.id)));
    });
    errorTableBody.querySelectorAll('.errorbook-table__action-btn--edit').forEach(btn => {
        btn.addEventListener('click', () => openEditErrorModal(parseInt(btn.dataset.id)));
    });
    errorTableBody.querySelectorAll('.errorbook-table__action-btn--delete').forEach(btn => {
        btn.addEventListener('click', () => deleteErrorBook(parseInt(btn.dataset.id)));
    });
}

function showEmptyState() {
    filterBar.style.display = 'none';
    emptyState.style.display = 'flex';
    errorTable.style.display = 'none';
    paginationContainer.style.display = 'none';
}

// ========== 查看详情 ==========
function viewErrorDetail(errorId) {
    const item = errorBooks.items.find(e => e.id === errorId);
    if (!item) return;
    const datasetName = datasets.find(d => d.id === item.file_id)?.file_name || '-';
    // 格式化原始数据（尝试解析JSON）
    let originalDataDisplay = item.original_data || '-';
    try {
        const parsed = JSON.parse(originalDataDisplay);
        originalDataDisplay = JSON.stringify(parsed, null, 2);
    } catch (e) {
        // 不是JSON格式，直接显示
    }
    const content = `
        <div class="errorbook-detail-field">
            <div class="errorbook-detail-field__label">数据集</div>
            <div class="errorbook-detail-field__value">${datasetName}</div>
        </div>
        <div class="errorbook-detail-field">
            <div class="errorbook-detail-field__label">COT名称</div>
            <div class="errorbook-detail-field__value">${item.cot_name || '-'}</div>
        </div>
        <div class="errorbook-detail-field">
            <div class="errorbook-detail-field__label">原始数据</div>
            <div class="errorbook-detail-field__value">${originalDataDisplay}</div>
        </div>

        <div class="errorbook-detail-field">
            <div class="errorbook-detail-field__label">错误原因</div>
            <div class="errorbook-detail-field__value">${item.error_reason || '-'}</div>
        </div>
        <div class="errorbook-detail-field">
            <div class="errorbook-detail-field__label">创建时间</div>
            <div class="errorbook-detail-field__value">${formatDateTime(item.created_at)}</div>
        </div>
    `;
    getDetailPanel().show(`错题详情 #${item.id}`, content);
}

// ========== 新增/编辑错题弹窗 ==========
async function openAddErrorModal() {
    if (!currentSceneId) {
        showToast('请先选择场景', 'warning');
        return;
    }
    editingErrorId = null;
    errorModalTitle.textContent = '新增错题';
    modalDataset.value = '';
    // 先加载弹窗COT下拉（场景级）
    await loadModalCotNames(currentSceneId, null);
    setModalCotNameValue('');
    modalOriginalData.value = '';
    modalErrorReason.value = '';
    errorModal.style.display = 'flex';
}

async function openEditErrorModal(errorId) {
    const item = errorBooks.items.find(e => e.id === errorId);
    if (!item) return;
    editingErrorId = errorId;
    errorModalTitle.textContent = '编辑错题';
    modalDataset.value = item.file_id || '';
    // 先加载弹窗COT下拉（可能带file_id）
    await loadModalCotNames(currentSceneId, item.file_id || null);
    setModalCotNameValue(item.cot_name || '');
    modalOriginalData.value = item.original_data || '';
    modalErrorReason.value = item.error_reason || '';
    errorModal.style.display = 'flex';
}

function closeErrorModal() {
    errorModal.style.display = 'none';
    editingErrorId = null;
}

async function submitErrorModal() {
    const fileId = modalDataset.value ? parseInt(modalDataset.value) : null;
    const cotName = getModalCotNameValue();
    const originalData = modalOriginalData.value.trim();
    const errorReason = modalErrorReason.value.trim();

    try {
        if (editingErrorId) {
            // 编辑错题
            const updateData = {
                cot_name: cotName,
                error_reason: errorReason,
            };
            if (originalData) {
                updateData.original_data = originalData;
            }
            if (fileId) {
                updateData.file_id = fileId;
            }
            await apiPut(`/api/error-books/${editingErrorId}`, updateData);
            showToast('错题已更新', 'success');
        } else {
            // 新增错题
            await apiPost('/api/error-books', {
                scene_id: currentSceneId,
                file_id: fileId,
                cot_name: cotName,
                original_data: originalData,
                error_reason: errorReason,
            });
            showToast('错题已创建', 'success');
        }
        closeErrorModal();
        await loadErrorBooks(editingErrorId ? errorBooks.page : 1);
    } catch (err) {
        // apiPut/apiPost 已通过 showToast 展示错误
    }
}

// ========== 删除错题 ==========
async function deleteErrorBook(errorId) {
    const confirmed = await showConfirm('删除错题', '确定要删除该错题吗？此操作不可恢复。');
    if (!confirmed) return;
    try {
        await apiDelete(`/api/error-books/${errorId}`);
        showToast('错题已删除', 'success');
        await loadErrorBooks(errorBooks.page);
    } catch (err) {
        // apiDelete 已通过 showToast 展示错误
    }
}

// ========== 新增场景弹窗 ==========
function openAddSceneModal() {
    sceneModalName.value = '';
    sceneModalDesc.value = '';
    sceneModal.style.display = 'flex';
    setTimeout(() => sceneModalName.focus(), 100);
}

function closeSceneModal() {
    sceneModal.style.display = 'none';
}

async function submitSceneModal() {
    const name = sceneModalName.value.trim();
    if (!name) {
        showToast('场景名称不能为空', 'warning');
        return;
    }
    const description = sceneModalDesc.value.trim();
    try {
        const newScene = await apiPost('/api/scenes', { name, description });
        showToast('场景已创建', 'success');
        closeSceneModal();
        await loadScenes();
        selectScene(newScene.id);
    } catch (err) {
        // apiPost 已通过 showToast 展示错误
    }
}

// ========== 事件绑定 ==========
function bindEvents() {
    // 场景新增
    sceneAddBtn.addEventListener('click', openAddSceneModal);

    // 场景弹窗
    sceneModalCancel.addEventListener('click', closeSceneModal);
    sceneModalConfirm.addEventListener('click', submitSceneModal);
    sceneModal.addEventListener('click', (e) => {
        if (e.target === sceneModal) closeSceneModal();
    });
    sceneModalName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitSceneModal();
        }
    });

    // 筛选栏数据集下拉变化 → 重新加载COT名称
    filterDataset.addEventListener('change', async () => {
        const fileId = filterDataset.value ? parseInt(filterDataset.value) : null;
        await loadCotNames(currentSceneId, fileId);
        await loadErrorBooks(1);
    });

    // 弹窗数据集下拉变化 → 重新加载弹窗COT名称
    modalDataset.addEventListener('change', async () => {
        const fileId = modalDataset.value ? parseInt(modalDataset.value) : null;
        await loadModalCotNames(currentSceneId, fileId);
        setModalCotNameValue('');
    });

    // COT名称下拉变化 → 重新加载错题列表
    filterCotName.addEventListener('change', () => loadErrorBooks(1));

    // 搜索按钮
    filterSearchBtn.addEventListener('click', () => loadErrorBooks(1));

    // 搜索框回车
    filterSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loadErrorBooks(1);
    });

    // 新增错题按钮
    addErrorBtn.addEventListener('click', openAddErrorModal);

    // 错题弹窗
    errorModalCancel.addEventListener('click', closeErrorModal);
    errorModalConfirm.addEventListener('click', submitErrorModal);
    errorModal.addEventListener('click', (e) => {
        if (e.target === errorModal) closeErrorModal();
    });

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (errorModal.style.display === 'flex') {
                closeErrorModal();
            }
            if (sceneModal.style.display === 'flex') {
                closeSceneModal();
            }
        }
    });
}

// ========== 工具函数 ==========
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
