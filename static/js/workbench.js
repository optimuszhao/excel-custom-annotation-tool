/**
 * 数据飞轮 — 标注工作台前端逻辑
 * 功能：文件选择、模型/策略/Prompt加载、数据表格渲染、批量标注、任务轮询、统计面板
 */

// ========== 全局状态 ==========
let currentFileId = null;          // 当前选中的 Excel 文件 ID
let currentSceneId = null;         // 当前文件所属场景 ID
let currentFileDisplayColumns = null; // 当前文件的文件级显示列配置（null=未设置, []=空数组）
let currentTaskId = null;          // 当前查看的标注任务 ID
let currentPage = 1;               // 当前页码
const PAGE_SIZE = 20;              // 每页行数
let currentFileTotalRows = 0;      // 当前文件总行数（从文件信息获取）
let tableColumns = [];             // 数据表格展示的字段列名（从 excel_fields 配置读取）
let selectedRowIds = new Set();    // 已勾选的行 ID 集合
let annotatingRowIds = new Set();  // 当前正在标注中的行 ID 集合
let pollingTimer = null;           // 任务轮询定时器
let activeTaskIds = new Set();     // 正在运行/等待中的任务 ID 集合
let currentFilterMatchType = '';   // 当前 match_type 过滤值
let allPrompts = [];               // 当前场景所有 Prompt 列表
let allModelList = [];             // 所有模型配置文件名列表

// ===== 动态列配置全局状态 =====
let allColumns = [];               // 所有可选列：{key, label, type}，type='data'|'fixed'
let visibleColumns = new Set();    // 当前显示列的 key 集合
let sortColumn = null;             // 当前排序列 key
let sortDirection = null;          // 'asc' | 'desc' | null
let searchColumn = '';             // 搜索列 key
let searchKeyword = '';            // 搜索关键词
let totalRows = 0;                 // 总行数（分页查询结果）
let currentRows = [];              // 当前页原始数据（排序/过滤用）

let currentPageData = [];          // 当前页数据（供编辑弹窗使用）

// ========== 初始化 ==========

document.addEventListener('DOMContentLoaded', async () => {
    await Promise.all([
        loadFileList(),
        loadModelList(),
        loadStrategyList(),
    ]);

    const select = document.getElementById('file-select');

    // 从 URL 恢复 file_id 参数，或自动选中第一个文件
    const urlFileId = getUrlParam('file_id');
    if (urlFileId) {
        const option = select.querySelector(`option[value="${urlFileId}"]`);
        if (option) {
            select.value = urlFileId;
        } else {
            // 文件列表中可能不包含该文件（API分页/延迟），添加临时选项并选中
            const tempOpt = document.createElement('option');
            tempOpt.value = urlFileId;
            tempOpt.textContent = `文件 ID: ${urlFileId}`;
            select.appendChild(tempOpt);
            select.value = urlFileId;
        }
        // 直接触发文件切换，加载该文件的数据
        await onFileChange();
    } else {
        // URL 无 file_id 时，自动选中下拉框中第一个有效文件选项，立即加载数据
        const firstOption = select.querySelector('option[value]:not([value=""])');
        if (firstOption) {
            select.value = firstOption.value;
            await onFileChange();
        }
    }

    // 点击页面其他位置关闭列选择器、弹框 Prompt 下拉
    // 列选择器面板内部点击不冒泡，避免 renderColumnSelector 重建 DOM 后
    // e.target 变成 detached node 导致 contains 判断失效而误关面板
    const colPanel = document.getElementById('column-selector');
    if (colPanel) {
        colPanel.addEventListener('click', (e) => e.stopPropagation());
    }
    document.addEventListener('click', (e) => {
        const colWrap = document.getElementById('column-selector-wrap');
        if (colWrap && !colWrap.contains(e.target)) {
            const sel = document.getElementById('column-selector');
            if (sel) sel.style.display = 'none';
        }
        // 点击外部关闭弹框内 Prompt 下拉
        const dialogPromptWrap = document.getElementById('dialog-prompt-wrap');
        if (dialogPromptWrap && !dialogPromptWrap.contains(e.target)) {
            const dialogPromptMenu = document.getElementById('dialog-prompt-menu');
            if (dialogPromptMenu) dialogPromptMenu.style.display = 'none';
        }
    });

});

// ========== 文件列表加载 ==========

async function loadFileList() {
    try {
        const data = await apiGet('/api/excel/list?page=1&page_size=200');
        const files = data.items || [];
        const select = document.getElementById('file-select');
        // 清空旧选项（保留占位）
        select.innerHTML = '<option value="">— 选择文件 —</option>';
        files.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = `${f.original_file_name || f.file_name}（${f.total_rows}行）`;
            select.appendChild(opt);
        });
    } catch (e) {
        // 忽略错误，不影响页面
    }
}

// ========== 模型列表加载 ==========

async function loadModelList() {
    try {
        const data = await apiGet('/api/models/list');
        allModelList = (data.models || []).map(name => `${name}.yaml`);
        // 不自动渲染，等弹框打开时渲染
    } catch (e) { /* 忽略 */ }
}

// ========== 模型按钮组渲染 & 选择 & 检测 ==========

function renderModelButtons(models, containerId, inputId) {
    containerId = containerId || 'dialog-model-btn-group';
    inputId = inputId || 'dialog-model-select';
    const container = document.getElementById(containerId);
    if (!container) return;
    const currentModel = document.getElementById(inputId).value;
    container.innerHTML = models.map(m => {
        const name = m.replace('.yaml', '');
        const isSelected = m === currentModel;
        const btnStyle = isSelected
            ? 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #2563eb; background:#eff6ff; color:#2563eb; font-weight:500; transition:all 0.15s;'
            : 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #d1d5db; background:#fff; color:#374151; transition:all 0.15s;';
        return `<div style="display:inline-flex; align-items:center; gap:4px;">
            <button onclick="selectModel(event, '${m}', '${containerId}', '${inputId}')" data-model="${m}" style="${btnStyle}">${escapeHtml(name)}</button>
            <button onclick="testModel(event, '${m}')" id="test-btn-${name}" title="检测可用性" style="padding:2px 6px; font-size:10px; border-radius:4px; cursor:pointer; border:1px solid #d1d5db; background:#f9fafb; color:#6b7280; transition:all 0.15s;">检测</button>
        </div>`;
    }).join('');
}

function selectModel(event, modelConfig, containerId, inputId) {
    event.stopPropagation();
    containerId = containerId || 'dialog-model-btn-group';
    inputId = inputId || 'dialog-model-select';
    document.getElementById(inputId).value = modelConfig;
    renderModelButtons(allModelList, containerId, inputId);
}

async function testModel(event, modelConfig) {
    event.stopPropagation();
    const name = modelConfig.replace('.yaml', '');
    const btn = document.getElementById('test-btn-' + name);
    if (!btn) return;

    // 按钮变为 loading 状态
    const originalText = btn.textContent;
    btn.textContent = '检测中...';
    btn.style.color = '#9ca3af';
    btn.disabled = true;

    try {
        const result = await apiPost('/api/model/test', { model_config: modelConfig });
        if (result.available) {
            btn.textContent = '可用 ✓';
            btn.style.color = '#16a34a';
            btn.style.borderColor = '#16a34a';
        } else {
            btn.textContent = '不可用';
            btn.style.color = '#dc2626';
            btn.style.borderColor = '#dc2626';
        }
    } catch(e) {
        btn.textContent = '失败';
        btn.style.color = '#dc2626';
        btn.style.borderColor = '#dc2626';
    }

    // 3秒后恢复原始状态
    setTimeout(() => {
        btn.textContent = originalText;
        btn.style.color = '#6b7280';
        btn.style.borderColor = '#d1d5db';
        btn.disabled = false;
    }, 3000);
}

// ========== 策略列表加载 ==========

let allStrategies = [];

async function loadStrategyList() {
    try {
        const data = await apiGet('/api/strategies/list');
        allStrategies = data.strategies || [];
    } catch (e) { /* 忽略 */ }
}

// ========== Prompt 下拉多选 ==========

async function loadPromptList(sceneId) {
    try {
        // /api/prompts 直接返回数组
        const data = await apiGet(`/api/prompts?scene_id=${sceneId}`);
        allPrompts = Array.isArray(data) ? data : (data.items || []);
        renderPromptDropdown();
    } catch (e) {
        allPrompts = [];
        renderPromptDropdown();
    }
}

function renderPromptDropdown() {
    const menu = document.getElementById('prompt-dropdown-menu');
    if (!menu) return;
    if (!allPrompts.length) {
        menu.innerHTML = '<div class="prompt-dropdown-item" style="color:#9ca3af;">无可用 Prompt</div>';
        updatePromptLabel();
        return;
    }
    menu.innerHTML = allPrompts.map(p => {
        const roleTag = p.role_name ? ` <span style="display:inline-block; font-size:11px; color:#6b7280; background:#f3f4f6; padding:1px 6px; border-radius:4px; margin-left:4px;">${escapeHtml(p.role_name)}</span>` : '';
        return `<label class="prompt-dropdown-item">
            <input type="checkbox" class="prompt-checkbox" value="${escapeHtml(p.name)}" onchange="updatePromptLabel()">
            <span>${escapeHtml(p.name)}${roleTag}</span>
        </label>`;
    }).join('');
    updatePromptLabel();
}

function togglePromptDropdown() {
    const menu = document.getElementById('prompt-dropdown-menu');
    if (!menu) return;
    menu.classList.toggle('open');
}

function updatePromptLabel() {
    const checked = getSelectedPromptNames();
    const label = document.getElementById('prompt-dropdown-label');
    if (!label) return;
    if (!checked.length) {
        label.textContent = '未选择';
    } else if (checked.length === 1) {
        label.textContent = checked[0];
    } else {
        label.textContent = `已选 ${checked.length} 个`;
    }
}

function getSelectedPromptNames() {
    return Array.from(
        document.querySelectorAll('.prompt-checkbox:checked')
    ).map(cb => cb.value);
}

// ========== 文件切换 ==========

async function onFileChange() {
    const select = document.getElementById('file-select');
    const fileId = parseInt(select.value);
    console.log('[workbench] onFileChange called, fileId =', fileId);
    if (!fileId) {
        currentFileId = null;
        currentSceneId = null;
        currentFileDisplayColumns = null;
        renderEmptyTable('请先选择数据文件');
        updateAnnotateButtons();
        return;
    }

    currentFileId = fileId;
    currentFileDisplayColumns = null; // 重置文件级显示列缓存
    currentPage = 1;
    currentTaskId = null;
    currentFilterMatchType = '';
    document.getElementById('filter-match-type').value = '';
    selectedRowIds.clear();
    setUrlParam('file_id', fileId);

    // 显示任务管理链接，附带 file_id 参数
    const taskManageLink = document.getElementById('task-manage-link');
    if (taskManageLink) {
        taskManageLink.href = '/task-manage?file_id=' + fileId;
        taskManageLink.style.display = 'inline';
    }

    // 加载 Prompt 列表 & 缓存 sceneId
    try {
        const fileInfo = await apiGet(`/api/excel/${fileId}`);
        currentFileTotalRows = fileInfo.total_rows || 0;
        const sceneId = fileInfo.scene_id;
        currentSceneId = sceneId || null;
        // 缓存文件级 display_columns
        if (fileInfo.display_columns && fileInfo.display_columns.length > 0) {
            currentFileDisplayColumns = fileInfo.display_columns;
        } else {
            currentFileDisplayColumns = null;
        }
        if (sceneId) {
            await loadPromptList(sceneId);
        }
    } catch (e) { /* 忽略 */ }

    await Promise.all([
        loadTableData(),
        loadStats(),
        loadTaskHistory(),
    ]);

    renderCurrentTaskSummary();
    updateAnnotateButtons();
}

// ========== 加载表格数据 ==========

async function loadTableData() {
    if (!currentFileId) return;

    try {
        const params = new URLSearchParams({
            file_id: currentFileId,
            page: currentPage,
            size: PAGE_SIZE,
        });
        if (currentTaskId) params.set('task_id', currentTaskId);
        if (currentFilterMatchType) params.set('match_type', currentFilterMatchType);

        const data = await apiGet(`/api/workbench/rows?${params.toString()}`);
        totalRows = data.total || 0;

        // 并行获取展示列配置，若失败则使用已有值或空数组
        try {
            tableColumns = await getDisplayColumns();
        } catch (_) {
            if (!tableColumns.length) tableColumns = [];
        }

        const items = data.items || [];

        // 从返回数据的第一行收集所有字段 key 作为全量列
        const allFieldKeys = items.length > 0 ? Object.keys(items[0].data || {}) : tableColumns;
        // 列初始化（如果 allColumns 为空、列集合有变化、或显示列配置变化）
        const allFieldStr = allFieldKeys.join(',');
        const prevFieldStr = allColumns.filter(c => c.type === 'data').map(c => c.key).join(',');
        const prevVisibleStr = [...visibleColumns].filter(k => !k.startsWith('__')).sort().join(',');
        const newVisibleStr = (tableColumns || []).slice().sort().join(',');
        if (allColumns.length === 0 || prevFieldStr !== allFieldStr || prevVisibleStr !== newVisibleStr) {
            initColumns(allFieldKeys, tableColumns);
        }

        // 更新返回的 effective_task_id（首次可能自动赋值最新任务）
        if (data.task_id && !currentTaskId) {
            currentTaskId = data.task_id;
        }

        currentRows = items; // 保存当前页原始数据
        currentPageData = items; // 保存供编辑弹窗使用
        renderTableWithState();
        renderPagination(data.total, data.page, data.pages);
    } catch (e) {
        console.error('[workbench] loadTableData error:', e);
        renderEmptyTable('数据加载失败：' + (e && e.message ? e.message : String(e)));
    }
}

// 获取文件的展示列（优先用文件级 display_columns，降级用全局规则 excel_fields）
async function getDisplayColumns() {
    // 优先使用文件级 display_columns
    if (currentFileDisplayColumns && currentFileDisplayColumns.length > 0) {
        return currentFileDisplayColumns;
    }
    // 降级使用全局规则
    try {
        const rule = await apiGet('/api/rule');
        const fields = rule.excel_fields || [];
        if (fields.length > 0) return fields;
    } catch (e) { /* 降级 */ }
    return [];
}

/**
 * 初始化列配置
 * @param {string[]} allFieldKeys - 从数据行收集的所有字段名（全量列）
 * @param {string[]} defaultVisibleFields - rule excel_fields 中配置的默认显示列
 */
function initColumns(allFieldKeys, defaultVisibleFields) {
    // 固定列（标注状态、人工答案、标注结果、匹配类型）
    const fixedCols = [
        { key: '__row_status__',  label: '标注状态', type: 'fixed' },
        { key: '__human_answer__', label: '人工答案', type: 'fixed' },
        { key: '__label__',       label: '标注结果', type: 'fixed' },
        { key: '__match_type__',  label: '匹配类型', type: 'fixed' },
    ];
    const dataCols = (allFieldKeys || []).map(f => ({ key: f, label: f, type: 'data' }));
    allColumns = [...dataCols, ...fixedCols];
    // 默认显示列：defaultVisibleFields 中存在的列 + 固定列；若无配置则显示全部
    const defaultSet = new Set(defaultVisibleFields || []);
    if (defaultSet.size > 0) {
        visibleColumns = new Set([
            ...(allFieldKeys || []).filter(k => defaultSet.has(k)),
            '__row_status__', '__human_answer__', '__label__', '__match_type__'
        ]);
    } else {
        visibleColumns = new Set(allColumns.map(c => c.key));
    }
    // 渲染列选择器
    renderColumnSelector();
    // 初始化搜索列下拉（所有列）
    initSearchColSelect(allFieldKeys || []);
}

/** 初始化搜索列选择下拉（包含所有 Excel 列） */
function initSearchColSelect(allFieldKeys) {
    const sel = document.getElementById('search-col-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">— 选择列 —</option>';
    (allFieldKeys || []).forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        sel.appendChild(opt);
    });
    // 固定列
    ['人工答案', '标注结果'].forEach((label, i) => {
        const opt = document.createElement('option');
        opt.value = ['__human_answer__', '__label__'][i];
        opt.textContent = label;
        sel.appendChild(opt);
    });
}

// ========== 列选择器 ==========

function toggleColumnSelector() {
    const sel = document.getElementById('column-selector');
    sel.style.display = sel.style.display === 'none' ? 'block' : 'none';
}

function renderColumnSelector() {
    const container = document.getElementById('column-selector-buttons');
    if (!container || !allColumns.length) return;
    container.innerHTML = allColumns.map(col => {
        const isActive = visibleColumns.has(col.key);
        const cls = isActive ? 'col-sel-btn active' : 'col-sel-btn';
        return `<button class="${cls}" onclick="toggleColumnSelect('${escapeHtml(col.key)}')">${escapeHtml(col.label)}</button>`;
    }).join('');
}

function toggleColumnSelect(key) {
    if (visibleColumns.has(key)) {
        visibleColumns.delete(key);
    } else {
        visibleColumns.add(key);
    }
    renderColumnSelector();
    renderTableWithState();
}

// ========== 同步显示列到规则配置 ==========

async function syncColumnsToRule() {
    if (!currentFileId) {
        showToast('请先选择数据文件', 'warning');
        return;
    }

    const btn = document.getElementById('sync-rule-btn');
    const spinner = document.getElementById('sync-rule-spinner');
    const text = document.getElementById('sync-rule-text');

    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'not-allowed';
    spinner.style.display = 'inline-block';
    text.textContent = '同步中...';

    try {
        // 只同步数据列（不含固定列）
        const dataColumns = allColumns
            .filter(c => c.type === 'data' && visibleColumns.has(c.key))
            .map(c => c.key);

        await apiPut('/api/rule/display-columns', { columns: dataColumns, scene_id: currentSceneId });

        // 同时保存到当前文件的 display_columns
        if (currentFileId) {
            try {
                await apiPut(`/api/excel/${currentFileId}/display-columns`, { display_columns: dataColumns });
                currentFileDisplayColumns = dataColumns; // 更新缓存
            } catch (e) {
                console.warn('[workbench] 保存文件级 display_columns 失败:', e);
            }
        }

        showToast('已同步到规则配置', 'success');

        // 刷新数据
        await loadTableData();
    } catch (e) {
        showToast('同步失败：' + (e && e.message ? e.message : String(e)), 'error');
    } finally {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        spinner.style.display = 'none';
        text.textContent = '同步到规则';
    }
}

// ========== 排序 ==========

function onSortClick(colKey) {
    if (sortColumn === colKey) {
        if (sortDirection === 'asc') {
            sortDirection = 'desc';
        } else if (sortDirection === 'desc') {
            sortColumn = null;
            sortDirection = null;
        } else {
            sortDirection = 'asc';
        }
    } else {
        sortColumn = colKey;
        sortDirection = 'asc';
    }
    renderTableWithState();
}

function getSortIcon(colKey) {
    if (sortColumn !== colKey) {
        return '<svg style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-left:4px;opacity:0.4;" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l4 5H4l4-5zm0 10l-4-5h8l-4 5z"/></svg>';
    }
    if (sortDirection === 'asc') {
        return '<svg style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-left:4px;" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l4 5H4l4-5z" fill="#2563eb"/><path d="M8 13l-4-5h8l-4 5z" fill="#d1d5db"/></svg>';
    }
    if (sortDirection === 'desc') {
        return '<svg style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-left:4px;" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l4 5H4l4-5z" fill="#d1d5db"/><path d="M8 13l-4-5h8l-4 5z" fill="#2563eb"/></svg>';
    }
    return '';
}

// ========== 搜索 ==========

function onSearchChange() {
    searchColumn = document.getElementById('search-col-select').value;
    searchKeyword = document.getElementById('search-keyword-input').value;
    renderTableWithState();
}

function clearSearch() {
    searchColumn = '';
    searchKeyword = '';
    document.getElementById('search-col-select').value = '';
    document.getElementById('search-keyword-input').value = '';
    renderTableWithState();
}

// ========== 核心渲染入口 ==========

/**
 * 根据当前状态（搜索/排序/列显示）运行完整表格渲染
 */
function renderTableWithState() {
    let rows = [...currentRows];

    // 1. 搜索过滤
    if (searchColumn && searchKeyword) {
        const kw = searchKeyword.toLowerCase();
        rows = rows.filter(row => {
            let val = '';
            if (searchColumn === '__row_status__') {
                val = String(row.row_status || '');
            } else if (searchColumn === '__human_answer__') {
                val = String(row.human_answer || '');
            } else if (searchColumn === '__label__') {
                const ann = getDisplayAnn(row);
                val = String(ann ? (ann.merged_label || ann.label || '') : '');
            } else {
                val = String(row.data[searchColumn] || '');
            }
            return val.toLowerCase().includes(kw);
        });
    }

    // 2. 排序
    if (sortColumn && sortDirection) {
        rows = rows.slice().sort((a, b) => {
            let va = '', vb = '';
            if (sortColumn === '__row_status__') {
                va = String(a.row_status || ''); vb = String(b.row_status || '');
            } else if (sortColumn === '__human_answer__') {
                va = String(a.human_answer || ''); vb = String(b.human_answer || '');
            } else if (sortColumn === '__label__') {
                const annA = getDisplayAnn(a), annB = getDisplayAnn(b);
                va = annA ? (annA.merged_label || annA.label || '') : '';
                vb = annB ? (annB.merged_label || annB.label || '') : '';
            } else if (sortColumn === '__match_type__') {
                const annA = getDisplayAnn(a), annB = getDisplayAnn(b);
                va = annA ? (annA.match_type || '') : '';
                vb = annB ? (annB.match_type || '') : '';
            } else {
                va = String(a.data[sortColumn] || ''); vb = String(b.data[sortColumn] || '');
            }
            const cmp = va.localeCompare(vb, 'zh-CN', { numeric: true });
            return sortDirection === 'asc' ? cmp : -cmp;
        });
    }

    renderTableHead();
    renderTable(rows);
}

/** 提取行的主标注结果（内部共用） */
function getDisplayAnn(row) {
    const mergedAnn = (row.annotations || []).find(a => a.prompt_name === '__merged__');
    const singleAnn = (row.annotations || []).find(
        a => a.prompt_name !== '__merged__' && a.prompt_name !== '__error__' && a.prompt_name !== '__default__'
    );
    const defaultAnn = (row.annotations || []).find(a => a.prompt_name === '__default__');
    return mergedAnn || singleAnn || defaultAnn || null;
}

// ========== 动态表头渲染 ==========

function renderTableHead() {
    const thead = document.getElementById('table-head');
    if (!thead) return;

    // 构建列定义：复选框 + 行号 + 可见数据列 + 可见固定列 + 操作
    const cols = getVisibleColDefs();

    const thList = [
        `<th style="width:36px;"><input type="checkbox" id="select-all-checkbox" onchange="toggleSelectAll(this)"></th>`,
        `<th style="width:50px; cursor:default;">行号</th>`,
    ];

    cols.forEach(col => {
        const icon = getSortIcon(col.key);
        thList.push(`<th style="max-width:300px; white-space:nowrap; cursor:pointer; user-select:none;" onclick="onSortClick('${col.key}')">${escapeHtml(col.label)}${icon}</th>`);
    });

    thList.push(`<th class="sticky-op-col" style="width:180px; cursor:default; text-align:center;">操作</th>`);

    thead.innerHTML = `<tr>${thList.join('')}</tr>`;
}

/** 返回当前应显示的列定义（按 allColumns 顺序过滤） */
function getVisibleColDefs() {
    return allColumns.filter(c => visibleColumns.has(c.key));
}

// ========== 渲染表格 ==========

function renderTable(rows) {
    const tbody = document.getElementById('table-body');
    if (!tbody) {
        console.error('[workbench] renderTable: #table-body not found');
        return;
    }

    const cols = getVisibleColDefs();
    const colCount = cols.length + 3; // 复选 + 行号 + 列组 + 操作

    if (!rows || !rows.length) {
        tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center; color:#9ca3af; padding:64px 0;">暂无数据</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(row => {
        const isSelected = selectedRowIds.has(row.id);
        const displayAnn = getDisplayAnn(row);
        const label = displayAnn ? (displayAnn.merged_label || displayAnn.label || '') : '';
        const matchType = displayAnn ? (displayAnn.match_type || '') : '';

        // 动态列单元格
        const dataCells = cols.map(col => {
            let cellHtml = '';
            if (col.key === '__row_status__') {
                cellHtml = renderRowStatus(row.row_status);
            } else if (col.key === '__human_answer__') {
                cellHtml = `<span style="font-size:12px; color:${row.human_answer === '是' ? '#16a34a' : row.human_answer === '否' ? '#ef4444' : '#9ca3af'}">${escapeHtml(row.human_answer || '-')}</span>`;
            } else if (col.key === '__label__') {
                cellHtml = `<span style="font-size:12px; font-weight:500; color:${label === '是' ? '#16a34a' : label === '否' ? '#ef4444' : '#9ca3af'}">${escapeHtml(label || '-')}</span>`;
            } else if (col.key === '__match_type__') {
                cellHtml = renderMatchTypeBadge(matchType);
            } else {
                const val = row.data[col.key];
                const text = val != null ? String(val) : '';
                const truncated = text.length > 80 ? text.slice(0, 80) + '…' : text;
                cellHtml = `<span style="display:block; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; color:#374151; margin:0 auto; text-align:center;" title="${escapeHtml(text)}">${escapeHtml(truncated)}</span>`;
                return `<td ondblclick="openCellEditor(${row.id}, this.dataset.field, this)" data-field="${escapeHtml(col.key)}" style="cursor:pointer;" title="双击编辑">${cellHtml}</td>`;
            }
            return `<td>${cellHtml}</td>`;
        }).join('');

        return `
        <tr class="${isSelected ? 'selected' : ''}" data-row-id="${row.id}">
            <td>
                <input type="checkbox" class="row-checkbox" value="${row.id}"
                    ${isSelected ? 'checked' : ''}
                    onchange="onRowCheckboxChange(${row.id}, this.checked)">
            </td>
            <td style="color:#9ca3af; font-size:12px;">${row.row_index + 1}</td>
            ${dataCells}
            <td class="sticky-op-col" style="text-align:center; white-space:nowrap;">
                <div style="display:inline-flex; align-items:center; gap:4px;">
                    <button class="annotate-btn-secondary" style="padding:3px 8px;font-size:12px;"
                        onclick="doAnnotateSingle(${row.id})" title="标注">标注</button>
                    <button class="annotate-btn-secondary" style="padding:3px 8px;font-size:12px;color:#6b7280;"
                        onclick="showRowDetail(${row.id})" title="查看详情">详情</button>
                    <button onclick="toggleRowMenu(event, ${row.id})" style="padding:3px 8px; font-size:12px; background:#f3f4f6; color:#374151; border:1px solid #d1d5db; border-radius:4px; cursor:pointer;">更多 ▾</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderMatchTypeBadge(matchType) {
    if (!matchType) return '<span class="badge-unknown">-</span>';
    const classMap = { TP: 'badge-tp', TN: 'badge-tn', FP: 'badge-fp', FN: 'badge-fn', UNKNOWN: 'badge-unknown' };
    const cls = classMap[matchType] || 'badge-unknown';
    return `<span class="${cls}">${matchType}</span>`;
}

function renderRowStatus(status) {
    if (status === '标注中') {
        return `<span style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:#fef3c7; color:#d97706;"><span style="display:inline-block; width:6px; height:6px; background:#d97706; border-radius:50%; animation:wb-pulse 1s infinite;"></span>标注中</span>`;
    }
    const styles = {
        '任务创建中': 'background:#fef3c7; color:#92400e;',    // 黄色
        '排队中': 'background:#e0e7ff; color:#3730a3;',        // 蓝紫色
        '已标注': 'background:#d1fae5; color:#065f46;',        // 绿色
        '失败': 'background:#fee2e2; color:#991b1b;',          // 红色
        '未标注': 'background:#f3f4f6; color:#6b7280;',        // 灰色
    };
    const style = styles[status] || styles['未标注'];
    return `<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; ${style}">${status || '未标注'}</span>`;
}

function renderEmptyTable(msg) {
    const tbody = document.getElementById('table-body');
    const colCount = getVisibleColDefs().length + 3;
    tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center; color:#9ca3af; padding:64px 0;">${escapeHtml(msg)}</td></tr>`;
}

// ========== 分页渲染 ==========

function renderPagination(total, page, pages) {
    const info = document.getElementById('pagination-info');
    const btns = document.getElementById('pagination-btns');
    info.textContent = `共 ${total} 条`;
    if (pages <= 1) { btns.innerHTML = ''; return; }

    let html = '';
    html += `<button class="px-2 py-1 text-xs border rounded ${page <= 1 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100'}"
        ${page <= 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">上一页</button>`;

    // 页码按钮（最多显示7个）
    const pageNums = buildPageNumbers(page, pages);
    pageNums.forEach(p => {
        if (p === '...') {
            html += '<span class="px-2 py-1 text-xs text-gray-400">…</span>';
        } else {
            html += `<button class="px-2 py-1 text-xs border rounded ${p === page ? 'bg-blue-600 text-white border-blue-600' : 'hover:bg-gray-100'}"
                onclick="goToPage(${p})">${p}</button>`;
        }
    });

    html += `<button class="px-2 py-1 text-xs border rounded ${page >= pages ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100'}"
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
    await loadTableData();
    window.scrollTo(0, 0);
}

// ========== 全选 / 单选 ==========

function toggleSelectAll(checkbox) {
    const allCheckboxes = document.querySelectorAll('.row-checkbox');
    allCheckboxes.forEach(cb => {
        cb.checked = checkbox.checked;
        const rowId = parseInt(cb.value);
        if (checkbox.checked) {
            selectedRowIds.add(rowId);
        } else {
            selectedRowIds.delete(rowId);
        }
    });
    updateSelectedRowHighlight();
    updateAnnotateButtons();
}

function onRowCheckboxChange(rowId, checked) {
    if (checked) {
        selectedRowIds.add(rowId);
    } else {
        selectedRowIds.delete(rowId);
    }
    updateSelectedRowHighlight();
    updateAnnotateButtons();
}

function updateSelectedRowHighlight() {
    document.querySelectorAll('[data-row-id]').forEach(tr => {
        const rowId = parseInt(tr.dataset.rowId);
        if (selectedRowIds.has(rowId)) {
            tr.classList.add('selected');
        } else {
            tr.classList.remove('selected');
        }
    });
}

// ========== 按钮状态控制 ==========

function updateAnnotateButtons() {
    const hasFile = !!currentFileId;
    const createBtn = document.getElementById('create-task-btn');
    if (createBtn) createBtn.disabled = !hasFile;
    // 导出按钮
    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) {
        exportBtn.disabled = !hasFile;
    }
}

// ========== 过滤 ==========

async function onFilterChange() {
    currentFilterMatchType = document.getElementById('filter-match-type').value;
    currentPage = 1;
    await loadTableData();
}

// ========== 标注操作 ==========

/** 选中行标注（追加到当前任务） */
async function doAnnotateSelected() {
    if (!currentFileId || selectedRowIds.size === 0) return;
    if (!currentTaskId) {
        // 无活跃任务，弹出创建任务弹框
        openCreateTaskDialog();
        return;
    }
    // 过滤掉正在标注中的行
    const rowsToAnnotate = [...selectedRowIds].filter(id => !annotatingRowIds.has(id));
    if (rowsToAnnotate.length === 0) {
        showToast('选中的行都在标注中，请等待完成', 'warning');
        return;
    }
    if (rowsToAnnotate.length < selectedRowIds.size) {
        showToast(`${selectedRowIds.size - rowsToAnnotate.length} 行正在标注中已跳过`, 'info');
    }
    try {
        const result = await apiPost('/api/workbench/annotate', {
            task_id: currentTaskId,
            row_ids: rowsToAnnotate,
        });
        showToast(`已追加 ${result.total_rows} 行到当前任务`, 'success');
        activeTaskIds.add(currentTaskId);
        startPolling();
        loadData();
    } catch (e) { /* apiRequest 已 toast */ }
}

/** 单行标注（追加到当前任务） */
async function doAnnotateSingle(rowId) {
    if (!currentFileId) return;
    if (!currentTaskId) {
        openCreateTaskDialog();
        return;
    }
    // 检查该行是否正在标注中
    if (annotatingRowIds.has(rowId)) {
        showToast('该行正在标注中，请等待完成', 'warning');
        return;
    }
    try {
        const result = await apiPost('/api/workbench/annotate', {
            task_id: currentTaskId,
            row_ids: [rowId],
        });
        showToast('已追加标注', 'success');
        activeTaskIds.add(currentTaskId);
        startPolling();
        loadData();
    } catch (e) { /* apiRequest 已 toast */ }
}

/** 标注任务创建成功后处理 */
function onAnnotateStarted(result) {
    const newTaskId = result.task_id;
    showToast(`标注任务已创建，共 ${result.total_rows} 行`, 'success');
    activeTaskIds.add(newTaskId);
    currentTaskId = newTaskId;
    startPolling();
    loadTaskHistory();
    loadData();
    renderCurrentTaskSummary();
}

/** 刷新当前视图数据（表格+统计） */
function loadData() {
    return Promise.all([
        loadTableData(),
        loadStats(),
    ]);
}

// ========== 统计面板 ==========

async function loadStats() {
    if (!currentFileId) return;
    try {
        const params = new URLSearchParams({ file_id: currentFileId });
        if (currentTaskId) params.set('task_id', currentTaskId);
        const stats = await apiGet(`/api/workbench/stats?${params.toString()}`);
        updateStatPanel(stats);
    } catch (e) { /* 忽略 */ }
}

// ========== 指标颜色与提示 ==========

function getMetricColor(value) {
    if (value == null || value === '-') return '#111827';
    const num = parseFloat(value);
    if (isNaN(num)) return '#111827';
    if (num > 95) return '#16a34a';
    if (num < 80) return '#dc2626';
    return '#111827';
}

const METRIC_TIPS = {
    '准确率': '模型标注结果与标准答案一致的比例',
    '召回率': '标准答案中被模型正确识别的比例',
    '精确率': '模型标注为正的样本中实际为正的比例',
    'F1': '精确率和召回率的调和平均值',
    '一致率': '多次标注结果一致的比例',
};

function showMetricTooltip(el, text) {
    let tip = document.getElementById('metric-tooltip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'metric-tooltip';
        tip.style.cssText = 'position:fixed; padding:8px 12px; background:#1f2937; color:#fff; font-size:12px; border-radius:6px; max-width:240px; z-index:9999; pointer-events:none; box-shadow:0 4px 12px rgba(0,0,0,0.15);';
        document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.style.display = 'block';

    const rect = el.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';

    requestAnimationFrame(() => {
        const tipRect = tip.getBoundingClientRect();
        if (tipRect.right > window.innerWidth - 8) {
            tip.style.left = (window.innerWidth - tipRect.width - 8) + 'px';
        }
    });
}

function hideMetricTooltip() {
    const tip = document.getElementById('metric-tooltip');
    if (tip) tip.style.display = 'none';
}

function updateStatPanel(stats) {
    const totalEl = document.getElementById('stat-total');
    if (totalEl) totalEl.textContent = stats.total ?? '-';
    const annotatedEl = document.getElementById('stat-annotated');
    if (annotatedEl) annotatedEl.textContent = stats.annotated ?? '-';

    const metricEls = [
        { id: 'stat-accuracy',  value: stats.accuracy,  raw: stats.annotated ? stats.accuracy : null },
        { id: 'stat-recall',    value: stats.recall,    raw: stats.annotated ? stats.recall : null },
        { id: 'stat-precision', value: stats.precision,  raw: stats.annotated ? stats.precision : null },
        { id: 'stat-f1',        value: stats.f1_score,  raw: stats.annotated ? stats.f1_score : null },
    ];
    metricEls.forEach(m => {
        const el = document.getElementById(m.id);
        if (!el) return;
        const displayText = m.value != null ? formatPercent(m.value) : '-';
        el.textContent = displayText;
        el.style.color = getMetricColor(m.raw != null ? m.raw * 100 : null);
    });

    document.getElementById('stat-tp').textContent = stats.tp ?? 0;
    document.getElementById('stat-tn').textContent = stats.tn ?? 0;
    document.getElementById('stat-fp').textContent = stats.fp ?? 0;
    document.getElementById('stat-fn').textContent = stats.fn ?? 0;
    document.getElementById('stat-unknown').textContent = stats.unknown ?? 0;
}

// ========== 任务历史面板 ==========

async function loadTaskHistory() {
    if (!currentFileId) return;
    try {
        const data = await apiGet(`/api/workbench/tasks?file_id=${currentFileId}`);
        renderTaskHistoryList(data.tasks || []);
    } catch (e) { /* 忽略 */ }
}

function renderTaskHistoryList(tasks) {
    const container = document.getElementById('task-history-list');
    if (!tasks.length) {
        container.innerHTML = '<div style="text-align:center; color:#9ca3af; font-size:13px; padding:32px 0;">暂无标注任务</div>';
        // 无任务时也尝试恢复活跃任务状态
        _tryRestoreActiveTasks(tasks);
        return;
    }
    container.innerHTML = tasks.map(t => {
        const isActive = currentTaskId === t.id;
        const statusBadge = renderTaskStatusBadge(t.status);
        const dateText = formatTaskDate(t.created_at);
        const durationText = t.duration_ms != null ? formatDurationMs(t.duration_ms) : '';
        const modelName = (t.model_name || '').replace(/\(.*\)/, '');
        const strategy = (t.model_name || '').match(/\((.*?)\)/)?.[1] || '';
        const concurrency = t.concurrency || 1;
        const promptNames = (t.prompt_names || []).join(',');

        // 运行中/等待中任务：文本进度
        let progressHtml = '';
        if (t.status === 'running' || t.status === 'pending') {
            const completed = t.completed_count ?? 0;
            const annotating = t.annotating_count ?? 0;
            const queuing = t.queuing_count ?? 0;
            progressHtml = `
                <div style="margin-top:8px; font-size:12px;">
                    <span style="color:#16a34a;">完成 ${completed}</span><span style="color:#6b7280;"> - </span><span style="color:#d97706;">标注中 ${annotating}</span><span style="color:#6b7280;"> - </span><span style="color:#3b82f6;">排队中 ${queuing}</span>
                </div>`;
        }

        // 已完成/失败/取消任务：成功/失败格式
        let metricsHtml = '';
        if (t.status === 'success' || t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
            const successCount = t.success_count || 0;
            const failedCount = t.failed_count || 0;
            const accuracyText = (t.accuracy != null) ? formatPercent(t.accuracy) : '-';
            metricsHtml = `
                <div style="display:flex; gap:10px; margin-top:6px; font-size:12px; color:#6b7280;">
                    <span>成功 <b style="color:#16a34a;">${successCount}</b></span>
                    <span>失败 <b style="color:#dc2626;">${failedCount}</b></span>
                    <span>准确率 <b style="color:#111827;">${accuracyText}</b></span>
                </div>`;
        }

        // 操作按钮（底部）
        const isRunning = t.status === 'running' || t.status === 'pending';
        const cancelBtn = isRunning
            ? `<button onclick="event.stopPropagation(); confirmCancelTask('${t.id}')" style="padding:3px 8px; font-size:11px; color:#d97706; background:#fffbeb; border:1px solid #fde68a; border-radius:4px; cursor:pointer;">取消标注</button>`
            : '';
        const switchBtn = `<button onclick="event.stopPropagation(); switchToTask('${t.id}')" style="padding:3px 8px; font-size:11px; color:#2563eb; background:#eff6ff; border:1px solid #bfdbfe; border-radius:4px; cursor:pointer;">切换数据</button>`;
        const deleteBtn = `<button onclick="event.stopPropagation(); confirmDeleteTask('${t.id}', ${isRunning})" style="padding:3px 8px; font-size:11px; color:#dc2626; background:#fef2f2; border:1px solid #fecaca; border-radius:4px; cursor:pointer;">删除</button>`;

        return `
        <div class="task-history-item ${isActive ? 'active' : ''}" style="margin:8px 12px; padding:12px 14px; background:#fff; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,0.06); border:1px solid ${isActive ? '#bfdbfe' : '#f3f4f6'}; cursor:pointer;" onclick="selectTask('${t.id}')">
            <div style="display:flex; align-items:center; justify-content:space-between;">
                <span style="font-size:13px; font-weight:600; color:#111827; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:200px;" title="${escapeHtml(t.model_name || '')}">${escapeHtml(modelName)}${strategy ? ' \u00b7 ' + escapeHtml(strategy) : ''}</span>
                ${statusBadge}
            </div>
            <div style="display:flex; align-items:center; gap:6px; margin-top:5px; font-size:11px; color:#9ca3af; flex-wrap:wrap;">
                <span style="background:#f3f4f6; color:#6b7280; padding:1px 6px; border-radius:3px;">并发${concurrency}</span>
                ${promptNames ? `<span style="background:#f3f4f6; color:#6b7280; padding:1px 6px; border-radius:3px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(promptNames)}">${escapeHtml(promptNames)}</span>` : ''}
                <span style="color:#d1d5db;">|</span>
                <span>总行数 ${t.total_rows || 0}</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px; margin-top:3px; font-size:11px; color:#9ca3af; flex-wrap:wrap;">
                <span>创建 ${dateText}</span>
                ${durationText ? `<span style="color:#d1d5db;">|</span><span>耗时 ${durationText}</span>` : ''}
            </div>
            ${progressHtml}
            ${metricsHtml}
            <div style="display:flex; gap:6px; margin-top:10px; padding-top:8px; border-top:1px solid #f3f4f6;">
                ${cancelBtn}
                ${switchBtn}
                ${deleteBtn}
            </div>
        </div>`;
    }).join('');

    // 页面加载后，检测运行中的任务并恢复轮询
    _tryRestoreActiveTasks(tasks);
}

/**
 * 检测任务列表中是否有运行中/等待中的任务，若有则恢复 activeTaskIds 和轮询
 * 解决刷新页面后排队中行显示为"未标注"的问题
 */
function _tryRestoreActiveTasks(tasks) {
    if (!tasks || !tasks.length) return;
    let restored = false;
    tasks.forEach(t => {
        if (t.status === 'running' || t.status === 'pending') {
            activeTaskIds.add(t.id);
            restored = true;
        }
    });
    if (restored) {
        // 恢复正在标注行 ID 集合
        const newAnnotatingIds = new Set();
        tasks.forEach(t => {
            if (t.status === 'running' && t.current_row_id) {
                try {
                    const ids = JSON.parse(t.current_row_id);
                    (Array.isArray(ids) ? ids : [ids]).forEach(id => newAnnotatingIds.add(id));
                } catch (e) { /* 忽略 */ }
            }
        });
        annotatingRowIds = newAnnotatingIds;

        // 启动轮询
        startPolling();
    }
}

function renderTaskStatusBadge(status) {
    const map = {
        pending: '<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:#f3f4f6; color:#6b7280;">等待中</span>',
        running: '<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:#fef3c7; color:#d97706;">运行中</span>',
        success: '<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:#d1fae5; color:#065f46;">完成</span>',
        completed: '<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:#d1fae5; color:#065f46;">完成</span>',
        failed: '<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:#fee2e2; color:#991b1b;">失败</span>',
        cancelled: '<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:#f3f4f6; color:#6b7280;">已取消</span>',
    };
    return map[status] || `<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:#f3f4f6; color:#6b7280;">${status}</span>`;
}

function calcProgress(task) {
    if (!task.total_rows) return 0;
    const done = (task.success_count || 0) + (task.failed_count || 0);
    return Math.round((done / task.total_rows) * 100);
}

/** 任务卡片专用日期格式：MM-DD HH:mm */
function formatTaskDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
}

/** 切换查看某个任务的结果 */
async function selectTask(taskId) {
    currentTaskId = taskId;
    currentPage = 1;
    await Promise.all([
        loadTableData(),
        loadStats(),
    ]);
    // 更新历史面板高亮
    loadTaskHistory();
    renderCurrentTaskSummary();
}

// ========== 任务卡片操作按钮 ==========

/** 取消标注（二次确认） */
async function confirmCancelTask(taskId) {
    const confirmed = await showConfirm('取消标注', '确定要取消该任务剩余的所有排队中的标注吗？已完成的标注结果将保留。');
    if (!confirmed) return;
    try {
        await apiPost(`/api/workbench/tasks/${taskId}/cancel`, {});
        showToast('已取消标注', 'success');
        activeTaskIds.delete(taskId);
        loadTaskHistory();
        loadData();
        renderCurrentTaskSummary();
    } catch (e) { /* toast already shown */ }
}

/** 切换到该任务数据视图 */
function switchToTask(taskId) {
    currentTaskId = taskId;
    currentPage = 1;
    loadData();
    renderCurrentTaskSummary();
    loadTaskHistory();
    showToast('已切换到该任务数据', 'success');
}

/** 删除任务（二次确认，运行中需特别提示） */
async function confirmDeleteTask(taskId, isRunning) {
    const warningText = isRunning
        ? '⚠️ 该任务正在运行中！删除将终止标注并清除所有已标注数据，此操作不可恢复。确定要删除吗？'
        : '确定要删除该任务及其所有标注结果数据吗？此操作不可恢复。';
    const confirmed = await showConfirm('删除任务', warningText);
    if (!confirmed) return;
    try {
        await apiDelete(`/api/workbench/tasks/${taskId}`);
        showToast('任务已删除', 'success');
        // 如果删除的是当前任务，清空视图
        if (currentTaskId === taskId) {
            currentTaskId = null;
            loadData();
            renderCurrentTaskSummary();
        }
        activeTaskIds.delete(taskId);
        loadTaskHistory();
    } catch (e) { /* toast already shown */ }
}

// ========== 任务状态轮询 ==========

function startPolling() {
    if (pollingTimer) return; // 已在轮询
    pollingTimer = setInterval(pollTaskStatus, 2000);
}

function stopPolling() {
    if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
    }
}

async function pollTaskStatus() {
    if (!activeTaskIds.size) {
        stopPolling();
        return;
    }

    try {
        const ids = [...activeTaskIds].join(',');
        const data = await apiGet(`/api/workbench/task-status?task_ids=${encodeURIComponent(ids)}`);
        const tasks = data.tasks || [];
        let hasRunning = false;
        let runningTasks = [];

        // 重建 annotatingRowIds
        const newAnnotatingIds = new Set();
        tasks.forEach(t => {
            if (t.status === 'running' || t.status === 'pending') {
                hasRunning = true;
                runningTasks.push(t);
                // 收集当前正在标注的行 ID
                if (t.current_row_id) {
                    try {
                        const ids = JSON.parse(t.current_row_id);
                        (Array.isArray(ids) ? ids : [ids]).forEach(id => newAnnotatingIds.add(id));
                    } catch (e) { /* 忽略 */ }
                }
            } else {
                // 任务完成/失败/取消：从活跃集合移除
                activeTaskIds.delete(t.id);
            }
        });
        annotatingRowIds = newAnnotatingIds;

        // 有任务完成或运行中时刷新表格和统计（实时更新行状态）
        const completedCount = tasks.filter(t => t.status === 'success' || t.status === 'failed').length;
        if (completedCount > 0 || hasRunning) {
            await Promise.all([
                loadTableData(),
                loadStats(),
                loadTaskHistory(),
            ]);
            renderCurrentTaskSummary();
        }

        if (!hasRunning) {
            stopPolling();
        }
    } catch (e) { /* 忽略轮询错误 */ }
}

function updateRunningTaskBanner(runningTasks) {
    // banner 已移除，此函数保留为空避免报错
}

/** 取消任务 */
async function cancelTask(taskId) {
    try {
        await apiPost(`/api/workbench/tasks/${taskId}/cancel`, {});
        showToast('任务已取消', 'info');
        activeTaskIds.delete(taskId);
        loadTaskHistory();
    } catch (e) { /* 忽略 */ }
}

// ========== JSON高亮显示 ==========

function highlightJson(jsonStr) {
    if (typeof jsonStr !== 'string') {
        jsonStr = JSON.stringify(jsonStr, null, 2);
    }
    try {
        const obj = JSON.parse(jsonStr);
        jsonStr = JSON.stringify(obj, null, 2);
    } catch(e) {
        return `<pre style="margin:0; white-space:pre-wrap; word-break:break-all; font-size:12px; font-family:Menlo,Monaco,monospace; background:#f8fafc; padding:8px; border-radius:4px; border:1px solid #e2e8f0;">${escapeHtml(jsonStr)}</pre>`;
    }
    const highlighted = escapeHtml(jsonStr)
        .replace(/"([^"]+)"(?=\s*:)/g, '<span style="color:#7ec8e3;">"$1"</span>')
        .replace(/:\s*"([^"]*)"/g, ': <span style="color:#ce9178;">"$1"</span>')
        .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#b5cea8; font-weight:600;">$1</span>')
        .replace(/:\s*(true|false)/g, ': <span style="color:#ff7b72; font-weight:600;">$1</span>')
        .replace(/:\s*(null)/g, ': <span style="color:#8b949e; font-style:italic;">$1</span>');
    return `<pre style="margin:0; white-space:pre-wrap; word-break:break-all; font-size:12px; line-height:1.6; font-family:Menlo,Monaco,monospace; background:#1e1e1e; color:#ffffff; padding:12px; border-radius:6px; border:1px solid #333; max-height:400px; overflow-y:auto;">${highlighted}</pre>`;
}

// ========== 行详情弹窗 ==========

async function showRowDetail(rowId) {
    try {
        const params = new URLSearchParams({ file_id: currentFileId, page: 1, size: 200 });
        if (currentTaskId) params.set('task_id', currentTaskId);
        const data = await apiGet(`/api/workbench/rows?${params.toString()}`);
        const row = (data.items || []).find(r => r.id === rowId);
        if (!row) { showToast('未找到行数据', 'error'); return; }

        // 构建详情 HTML
        let html = '<div class="space-y-3">';

        // 数据字段
        html += '<div><div class="text-xs font-semibold text-gray-500 mb-1">数据字段</div><div class="bg-gray-50 rounded p-3 space-y-1">';
        Object.entries(row.data || {}).forEach(([k, v]) => {
            html += `<div class="text-xs"><span class="font-medium text-gray-500">${escapeHtml(k)}：</span><span class="text-gray-700">${escapeHtml(String(v ?? ''))}</span></div>`;
        });
        html += '</div></div>';

        // 人工答案
        html += `<div class="text-xs"><span class="font-medium text-gray-500">人工答案：</span><span class="font-semibold ${row.human_answer === '是' ? 'text-green-600' : 'text-red-500'}">${escapeHtml(row.human_answer || '-')}</span></div>`;

        // 标注结果
        if (row.annotations && row.annotations.length > 0) {
            html += '<div><div class="text-xs font-semibold text-gray-500 mb-1">标注结果</div>';
            row.annotations.forEach(ann => {
                if (ann.prompt_name === '__error__') return;
                const isMerged = ann.prompt_name === '__merged__';
                html += `<div class="bg-gray-50 rounded p-2 mb-2">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs font-medium text-gray-600">${isMerged ? '合并结果' : escapeHtml(ann.prompt_name)}</span>
                        ${renderMatchTypeBadge(ann.match_type)}
                    </div>
                    <div class="text-xs"><span class="text-gray-500">标注标签：</span><span class="font-medium">${escapeHtml(ann.label || '-')}</span></div>`;
                if (ann.result && Object.keys(ann.result).length > 0) {
                    html += `<div style="margin-top:8px;">${highlightJson(ann.result)}</div>`;
                }
                html += '</div>';
            });
            html += '</div>';
        }

        html += '</div>';
        getDetailPanel().show(`行 #${row.row_index + 1} 详情`, html);
    } catch (e) {
        showToast('加载详情失败', 'error');
    }
}

// ========== 删除单行数据（旧版，已移至更多菜单） ==========

async function deleteRow(rowId) {
    if (!rowId) return;
    const confirmed = await showConfirm('确认删除', '确定要删除该行数据吗？删除后不可恢复。');
    if (!confirmed) return;
    try {
        const result = await apiRequest('/api/rows', { method: 'DELETE', body: { row_ids: [rowId], confirmed: true } });
        if (result.success) {
            showToast('删除成功', 'success');
            selectedRowIds.delete(rowId);
            await Promise.all([
                loadTableData(),
                loadStats(),
            ]);
            updateAnnotateButtons();
        } else {
            showToast(result.message || '删除失败', 'error');
        }
    } catch (e) {
        showToast('删除失败', 'error');
    }
}

// ========== 更多下拉菜单 ==========

function toggleRowMenu(event, rowId) {
    event.stopPropagation();

    // 先关闭已有的 body 级菜单
    const existingMenu = document.getElementById('row-action-menu');
    if (existingMenu) {
        existingMenu.remove();
        // 如果是同一个按钮再次点击，则仅关闭
        if (existingMenu.dataset.rowId === String(rowId)) return;
    }

    // 获取按钮位置
    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();

    // 创建菜单并挂到 body
    const menu = document.createElement('div');
    menu.id = 'row-action-menu';
    menu.dataset.rowId = String(rowId);
    menu.style.cssText = 'position:fixed; background:#fff; border:1px solid #e5e7eb; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.1); z-index:9999; min-width:120px; overflow:hidden;';

    menu.innerHTML =
        '<div onmouseover="this.style.background=\'#f9fafb\'" onmouseout="this.style.background=\'#fff\'" onclick="editRowData(' + rowId + ')" style="padding:8px 16px; font-size:13px; color:#374151; cursor:pointer; border-bottom:1px solid #f3f4f6;">编辑数据</div>' +
        '<div onmouseover="this.style.background=\'#fef3c7\'" onmouseout="this.style.background=\'#fff\'" onclick="cancelRowAnnotation(' + rowId + ')" style="padding:8px 16px; font-size:13px; color:#d97706; cursor:pointer; border-bottom:1px solid #f3f4f6;">取消标注</div>' +
        '<div onmouseover="this.style.background=\'#fee2e2\'" onmouseout="this.style.background=\'#fff\'" onclick="deleteRowData(' + rowId + ')" style="padding:8px 16px; font-size:13px; color:#dc2626; cursor:pointer;">删除数据</div>';

    document.body.appendChild(menu);

    // 计算位置，确保不超出视口
    const menuRect = menu.getBoundingClientRect();
    const menuW = menuRect.width;
    const menuH = menuRect.height;

    // 水平方向：优先左对齐，超出右边界则右对齐到按钮右侧
    let left = rect.left;
    if (left + menuW > window.innerWidth) {
        left = rect.right - menuW;
    }
    if (left < 0) left = 4;

    // 垂直方向：优先向下，超出底部则向上
    let top = rect.bottom + 4;
    if (top + menuH > window.innerHeight) {
        top = rect.top - menuH - 4;
    }
    if (top < 0) top = 4;

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

// 点击页面其他地方关闭 body 级行操作菜单
let _rowMenuDocClickAdded = false;
if (!_rowMenuDocClickAdded) {
    document.addEventListener('click', () => {
        const menu = document.getElementById('row-action-menu');
        if (menu) menu.remove();
    });
    _rowMenuDocClickAdded = true;
}

// ========== 编辑数据弹窗 ==========

async function editRowData(rowId) {
    // 关闭 body 级行操作菜单
    const actionMenu = document.getElementById('row-action-menu');
    if (actionMenu) actionMenu.remove();

    // 获取该行数据
    const row = currentPageData.find(r => r.id === rowId);
    if (!row) return;

    const data = row.data || {};
    const fields = Object.keys(data);

    // 创建编辑弹窗
    let overlay = document.getElementById('edit-row-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'edit-row-overlay';
        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.3); z-index:9999; display:flex; align-items:center; justify-content:center;';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.body.appendChild(overlay);
    }

    let fieldsHtml = fields.map(f => {
        // 用 data-field 属性避免字段名含特殊字符导致 id 选择器问题
        const fieldKey = f.replace(/[^a-zA-Z0-9_]/g, '_');
        return `
        <div style="margin-bottom:10px;">
            <label style="display:block; font-size:12px; color:#6b7280; margin-bottom:2px;">${escapeHtml(f)}</label>
            <input data-field="${escapeHtml(f)}" id="edit-field-${fieldKey}" value="${escapeHtml(String(data[f] || ''))}" style="width:100%; padding:6px 10px; font-size:13px; border:1px solid #d1d5db; border-radius:6px; box-sizing:border-box;">
        </div>`;
    }).join('');

    overlay.innerHTML = `
        <div style="background:#fff; border-radius:12px; padding:24px; box-shadow:0 8px 32px rgba(0,0,0,0.15); width:70%; max-height:80vh; overflow-y:auto;">
            <h3 style="margin:0 0 16px 0; font-size:16px; color:#111827;">编辑数据 - 行 #${rowId}</h3>
            ${fieldsHtml}
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
                <button onclick="document.getElementById('edit-row-overlay').style.display='none'" style="padding:8px 20px; font-size:13px; background:#f3f4f6; color:#374151; border:1px solid #d1d5db; border-radius:8px; cursor:pointer;">取消</button>
                <button onclick="saveRowData(${rowId})" style="padding:8px 20px; font-size:13px; background:#2563eb; color:#fff; border:none; border-radius:8px; cursor:pointer; font-weight:500;">保存</button>
            </div>
        </div>
    `;
    overlay.style.display = 'flex';

    // ESC 关闭弹窗
    function onEsc(e) {
        if (e.key === 'Escape') {
            overlay.style.display = 'none';
            document.removeEventListener('keydown', onEsc);
        }
    }
    document.addEventListener('keydown', onEsc);
}

async function saveRowData(rowId) {
    const row = currentPageData.find(r => r.id === rowId);
    if (!row) return;

    const data = row.data || {};
    const updatedData = {};
    Object.keys(data).forEach(f => {
        const fieldKey = f.replace(/[^a-zA-Z0-9_]/g, '_');
        const input = document.getElementById('edit-field-' + fieldKey);
        if (input) {
            updatedData[f] = input.value;
        } else {
            updatedData[f] = data[f];
        }
    });

    try {
        await apiPut('/api/workbench/rows/' + rowId, { data: updatedData });
        document.getElementById('edit-row-overlay').style.display = 'none';
        showToast('数据已更新', 'success');
        loadTableData();
    } catch (e) {
        showToast('保存失败: ' + (e.message || ''), 'error');
    }
}

// ========== 删除数据（更多菜单） ==========

async function deleteRowData(rowId) {
    // 关闭 body 级行操作菜单
    const actionMenu = document.getElementById('row-action-menu');
    if (actionMenu) actionMenu.remove();

    // 确认弹窗
    const confirmed = await showConfirm('确认删除', '确定要删除这行数据吗？此操作不可恢复。');
    if (!confirmed) return;

    try {
        await apiDelete('/api/workbench/rows/' + rowId);
        showToast('数据已删除', 'success');
        selectedRowIds.delete(rowId);
        await Promise.all([
            loadTableData(),
            loadStats(),
        ]);
        updateAnnotateButtons();
    } catch (e) {
        showToast('删除失败: ' + (e.message || ''), 'error');
    }
}

// ========== 取消标注 ==========

async function cancelRowAnnotation(rowId) {
    // 关闭 body 级行操作菜单
    const actionMenu = document.getElementById('row-action-menu');
    if (actionMenu) actionMenu.remove();

    const confirmed = await showConfirm('取消标注', '确定要取消该行的标注结果吗？');
    if (!confirmed) return;

    try {
        await apiDelete('/api/workbench/rows/' + rowId + '/annotations');
        showToast('标注已取消', 'success');
        await Promise.all([
            loadTableData(),
            loadStats(),
        ]);
    } catch (e) {
        showToast('取消标注失败: ' + (e.message || ''), 'error');
    }
}

// ========== 单元格编辑弹窗 ==========

// 暂存当前编辑的 fieldName（避免特殊字符在 onclick 内联属性中出错）
let _currentCellEditField = null;
let _currentCellEditRowId = null;

function openCellEditor(rowId, fieldName, tdElement) {
    const row = currentPageData.find(r => r.id === rowId);
    if (!row) return;

    _currentCellEditField = fieldName;
    _currentCellEditRowId = rowId;

    const data = row.data || {};
    let cellValue = data[fieldName];
    if (cellValue === undefined || cellValue === null) cellValue = '';

    let isJson = false;
    let displayValue = String(cellValue);
    try {
        if (typeof cellValue === 'string' && (cellValue.trim().startsWith('{') || cellValue.trim().startsWith('['))) {
            const parsed = JSON.parse(cellValue);
            displayValue = JSON.stringify(parsed, null, 2);
            isJson = true;
        } else if (typeof cellValue === 'object' && cellValue !== null) {
            displayValue = JSON.stringify(cellValue, null, 2);
            isJson = true;
        }
    } catch(e) {}

    let overlay = document.getElementById('cell-editor-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'cell-editor-overlay';
        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.3); z-index:9999; display:flex; align-items:center; justify-content:center;';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display === 'flex') overlay.style.display = 'none';
        });
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div style="background:#fff; border-radius:12px; padding:24px; box-shadow:0 8px 32px rgba(0,0,0,0.15); width:70%; max-height:80vh; overflow-y:auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="margin:0; font-size:15px; color:#111827;">编辑字段: <span style="color:#2563eb;">${escapeHtml(fieldName)}</span></h3>
                <span style="font-size:12px; color:#9ca3af;">行 #${rowId}</span>
            </div>
            <div style="display:flex; gap:16px; min-height:300px;">
                <div style="flex:1; display:flex; flex-direction:column;">
                    <label style="font-size:12px; color:#6b7280; margin-bottom:6px; display:block; font-weight:500;">内容编辑</label>
                    <textarea id="cell-editor-textarea" style="flex:1; width:100%; min-height:280px; padding:12px; font-size:13px; font-family:${isJson ? 'Menlo,Monaco,monospace' : 'inherit'}; border:1px solid #d1d5db; border-radius:6px; box-sizing:border-box; resize:none; line-height:1.6;">${escapeHtml(displayValue)}</textarea>
                </div>
                <div style="flex:1; display:flex; flex-direction:column;">
                    <label style="font-size:12px; color:#6b7280; margin-bottom:6px; display:block; font-weight:500;">${isJson ? '预览（语法高亮）' : '预览'}</label>
                    <div id="cell-json-preview" style="flex:1; background:#1e1e1e; color:#ffffff; padding:12px; border-radius:6px; font-family:Menlo,Monaco,monospace; font-size:12px; overflow:auto; white-space:pre-wrap; word-break:break-all; line-height:1.6; border:1px solid #333;">${isJson ? highlightJson(displayValue) : escapeHtml(displayValue)}</div>
                </div>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
                <button onclick="document.getElementById('cell-editor-overlay').style.display='none'" style="padding:8px 20px; font-size:13px; background:#f3f4f6; color:#374151; border:1px solid #d1d5db; border-radius:8px; cursor:pointer;">取消</button>
                <button onclick="saveCellEdit()" style="padding:8px 20px; font-size:13px; background:#2563eb; color:#fff; border:none; border-radius:8px; cursor:pointer; font-weight:500;">保存</button>
            </div>
        </div>
    `;
    overlay.style.display = 'flex';

    const textarea = document.getElementById('cell-editor-textarea');
    if (textarea) {
        textarea.focus();
        if (isJson) {
            textarea.addEventListener('input', () => {
                const preview = document.getElementById('cell-json-preview');
                if (!preview) return;
                try {
                    const parsed = JSON.parse(textarea.value);
                    preview.innerHTML = highlightJson(JSON.stringify(parsed, null, 2));
                } catch(e) {
                    preview.textContent = textarea.value;
                }
            });
        }
    }
}

async function saveCellEdit() {
    const rowId = _currentCellEditRowId;
    const fieldName = _currentCellEditField;
    if (rowId === null || fieldName === null) return;

    const textarea = document.getElementById('cell-editor-textarea');
    if (!textarea) return;

    let newValue = textarea.value;

    // 尝试解析 JSON，如果是合法 JSON 则存为对象
    try {
        if (newValue.trim().startsWith('{') || newValue.trim().startsWith('[')) {
            newValue = JSON.parse(newValue);
        }
    } catch(e) {
        // 保持字符串
    }

    const row = currentPageData.find(r => r.id === rowId);
    if (!row) return;

    const updatedData = { ...(row.data || {}) };
    updatedData[fieldName] = newValue;

    try {
        await apiPut('/api/workbench/rows/' + rowId, { data: updatedData });
        document.getElementById('cell-editor-overlay').style.display = 'none';
        showToast('保存成功', 'success');
        loadTableData();
    } catch(e) {
        showToast('保存失败: ' + (e.message || ''), 'error');
    }
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

/** 格式化耗时（毫秒 -> 可读字符串） */
function formatDurationMs(ms) {
    if (ms == null) return '';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 1) return ms + 'ms';
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    const remainSec = seconds % 60;
    if (minutes < 60) return minutes + 'm ' + remainSec + 's';
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    return hours + 'h ' + remainMin + 'm';
}

// ========== 创建标注任务弹框 ==========

/** 打开创建标注任务弹框 */
function openCreateTaskDialog() {
    if (!currentFileId) {
        showToast('请先选择数据文件', 'warning');
        return;
    }
    // 重置倒计时状态
    resetCountdownState();

    // 填充弹框内的模型按钮
    renderModelButtons(allModelList, 'dialog-model-btn-group', 'dialog-model-select');

    // 填充策略按钮组
    renderStrategyBtnGroup();

    // 填充并发数按钮组
    renderConcurrencyBtnGroup();

    // 初始化标注范围选择器
    currentRangeKey = 'all';
    renderRangeBtnGroup();
    selectDialogRange('all');

    // 填充 Prompt 多选按钮组
    renderDialogPromptBtnGroup();

    // 显示弹框
    document.getElementById('create-task-overlay').style.display = 'flex';
    document.getElementById('create-task-dialog').style.display = 'block';
}

/** 关闭创建标注任务弹框 */
function closeCreateTaskDialog() {
    cancelCreateCountdown();
    document.getElementById('create-task-overlay').style.display = 'none';
    document.getElementById('create-task-dialog').style.display = 'none';
}

/** 策略按钮组渲染 */
function renderStrategyBtnGroup() {
    const container = document.getElementById('dialog-strategy-btn-group');
    const input = document.getElementById('dialog-strategy-select');
    if (!container) return;
    if (!allStrategies.length) {
        container.innerHTML = '<span style="font-size:12px; color:#9ca3af;">无可用策略</span>';
        input.value = '';
        return;
    }
    // 默认选第一个
    if (!input.value || !allStrategies.includes(input.value)) {
        input.value = allStrategies[0];
    }
    container.innerHTML = allStrategies.map(name => {
        const isSelected = name === input.value;
        const style = isSelected
            ? 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #bfdbfe; background:#eff6ff; color:#2563eb; font-weight:500; transition:all 0.15s;'
            : 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #e5e7eb; background:#f3f4f6; color:#6b7280; transition:all 0.15s;';
        return `<button onclick="selectDialogStrategy('${escapeHtml(name)}')" style="${style}">${escapeHtml(name)}</button>`;
    }).join('');
}

function selectDialogStrategy(name) {
    document.getElementById('dialog-strategy-select').value = name;
    renderStrategyBtnGroup();
}

/** 并发数按钮组渲染 */
const CONCURRENCY_OPTIONS = [1, 2, 4, 6, 8, 10];

function renderConcurrencyBtnGroup() {
    const container = document.getElementById('dialog-concurrency-btn-group');
    const input = document.getElementById('dialog-concurrency-input');
    const hidden = document.getElementById('dialog-concurrency-hidden');
    if (!container || !input) return;
    const currentVal = parseInt(input.value) || parseInt(hidden.value) || 1;
    container.innerHTML = CONCURRENCY_OPTIONS.map(n => {
        const isSelected = n === currentVal;
        const style = isSelected
            ? 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #bfdbfe; background:#eff6ff; color:#2563eb; font-weight:500; transition:all 0.15s;'
            : 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #e5e7eb; background:#f3f4f6; color:#6b7280; transition:all 0.15s;';
        return `<button onclick="selectDialogConcurrency(${n})" style="${style}">${n}</button>`;
    }).join('');
}

function selectDialogConcurrency(n) {
    const input = document.getElementById('dialog-concurrency-input');
    const hidden = document.getElementById('dialog-concurrency-hidden');
    if (input) input.value = n;
    if (hidden) hidden.value = n;
    renderConcurrencyBtnGroup();
}

/** 用户在自定义输入框手动输入并发数时，取消按钮组选中状态 */
function onConcurrencyInput() {
    const input = document.getElementById('dialog-concurrency-input');
    const hidden = document.getElementById('dialog-concurrency-hidden');
    const val = parseInt(input.value);
    if (isNaN(val) || val < 1) {
        if (hidden) hidden.value = '';
    } else {
        if (hidden) hidden.value = val;
    }
    renderConcurrencyBtnGroup();
}

// ========== 数据范围选择器 ==========

const RANGE_OPTIONS = [
    { key: 'all', label: '全部' },
    { key: 'first100', label: '前100条' },
    { key: 'first200', label: '前200条' },
    { key: 'first500', label: '前500条' },
    { key: 'latter', label: '后半部分' },
    { key: 'custom', label: '自定义' },
];
let currentRangeKey = 'all';

function renderRangeBtnGroup() {
    const container = document.getElementById('dialog-range-btn-group');
    if (!container) return;
    container.innerHTML = RANGE_OPTIONS.map(opt => {
        const isSelected = opt.key === currentRangeKey;
        const style = isSelected
            ? 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #bfdbfe; background:#eff6ff; color:#2563eb; font-weight:500; transition:all 0.15s;'
            : 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #e5e7eb; background:#f3f4f6; color:#6b7280; transition:all 0.15s;';
        return `<button onclick="selectDialogRange('${opt.key}')" style="${style}">${opt.label}</button>`;
    }).join('');
}

function selectDialogRange(key) {
    currentRangeKey = key;
    const customDiv = document.getElementById('dialog-custom-range');
    const rowStartInput = document.getElementById('dialog-row-start');
    const rowEndInput = document.getElementById('dialog-row-end');
    const total = currentFileTotalRows || 0;

    if (key === 'custom') {
        customDiv.style.display = 'flex';
        // 默认填充
        if (!rowStartInput.value) rowStartInput.value = 1;
    } else {
        customDiv.style.display = 'none';
        // 根据快捷选项填充输入框
        switch (key) {
            case 'all':
                rowStartInput.value = 1;
                rowEndInput.value = '';
                break;
            case 'first100':
                rowStartInput.value = 1;
                rowEndInput.value = Math.min(100, total);
                break;
            case 'first200':
                rowStartInput.value = 1;
                rowEndInput.value = Math.min(200, total);
                break;
            case 'first500':
                rowStartInput.value = 1;
                rowEndInput.value = Math.min(500, total);
                break;
            case 'latter':
                rowStartInput.value = Math.floor(total / 2) + 1;
                rowEndInput.value = '';
                break;
        }
    }

    renderRangeBtnGroup();
    updateRangeCount();
}

/** 计算并更新标注数量提示 */
function updateRangeCount() {
    const total = currentFileTotalRows || 0;
    const hintEl = document.getElementById('dialog-range-count-hint');
    const totalHintEl = document.getElementById('dialog-range-total-hint');
    if (!hintEl) return;

    if (totalHintEl) totalHintEl.textContent = `共${total}行`;

    let count = 0;
    if (currentRangeKey === 'all') {
        count = total;
    } else if (currentRangeKey === 'first100') {
        count = Math.min(100, total);
    } else if (currentRangeKey === 'first200') {
        count = Math.min(200, total);
    } else if (currentRangeKey === 'first500') {
        count = Math.min(500, total);
    } else if (currentRangeKey === 'latter') {
        count = total - Math.floor(total / 2);
    } else if (currentRangeKey === 'custom') {
        let start = parseInt(document.getElementById('dialog-row-start').value) || 1;
        let endVal = document.getElementById('dialog-row-end').value;
        let end = endVal ? parseInt(endVal) : total;
        start = Math.max(1, Math.min(start, total));
        end = endVal ? Math.min(end, total) : total;
        if (end < start) end = start;
        count = end - start + 1;
    }
    count = Math.max(0, count);
    hintEl.textContent = `本次将标注 ${count} 条数据`;
}

/** 获取当前标注范围的 row_start / row_end */
function getDialogRangeParams() {
    const total = currentFileTotalRows || 0;
    let rowStart = 1;
    let rowEnd = null; // null 表示到最后

    if (currentRangeKey === 'all') {
        rowStart = 1;
        rowEnd = null;
    } else if (currentRangeKey === 'first100') {
        rowStart = 1;
        rowEnd = Math.min(100, total);
    } else if (currentRangeKey === 'first200') {
        rowStart = 1;
        rowEnd = Math.min(200, total);
    } else if (currentRangeKey === 'first500') {
        rowStart = 1;
        rowEnd = Math.min(500, total);
    } else if (currentRangeKey === 'latter') {
        rowStart = Math.floor(total / 2) + 1;
        rowEnd = null;
    } else if (currentRangeKey === 'custom') {
        let startVal = parseInt(document.getElementById('dialog-row-start').value) || 1;
        let endVal = document.getElementById('dialog-row-end').value;
        rowStart = Math.max(1, Math.min(startVal, total));
        rowEnd = endVal ? Math.min(parseInt(endVal), total) : null;
    }

    return { row_start: rowStart, row_end: rowEnd };
}

/** Prompt 多选按钮组渲染 */
function renderDialogPromptBtnGroup() {
    const container = document.getElementById('dialog-prompt-btn-group');
    if (!container) return;
    if (!allPrompts.length) {
        container.innerHTML = '<span style="font-size:12px; color:#9ca3af;">无可用 Prompt</span>';
        return;
    }
    container.innerHTML = allPrompts.map(p => {
        const roleTag = p.role_name ? ` <span style="display:inline-block; font-size:10px; color:#6b7280; background:#f3f4f6; padding:0px 5px; border-radius:3px; margin-left:2px;">${escapeHtml(p.role_name)}</span>` : '';
        const cb = document.querySelector(`.dialog-prompt-checkbox[value="${CSS.escape(p.name)}"]`);
        const isSelected = cb ? cb.checked : false;
        const style = isSelected
            ? 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #bfdbfe; background:#eff6ff; color:#2563eb; font-weight:500; transition:all 0.15s; display:inline-flex; align-items:center;'
            : 'padding:5px 12px; font-size:12px; border-radius:6px; cursor:pointer; border:1px solid #e5e7eb; background:#f3f4f6; color:#6b7280; transition:all 0.15s; display:inline-flex; align-items:center;';
        return `<button onclick="toggleDialogPromptBtn(this, '${escapeHtml(p.name)}')" class="dialog-prompt-toggle" data-prompt="${escapeHtml(p.name)}" style="${style}">${escapeHtml(p.name)}${roleTag}</button>`;
    }).join('');
}

function toggleDialogPromptBtn(btnEl, promptName) {
    // 使用 hidden checkbox 追踪多选状态
    let existing = document.querySelector(`.dialog-prompt-checkbox[value="${CSS.escape(promptName)}"]`);
    if (!existing) {
        // 创建 hidden checkbox
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'dialog-prompt-checkbox';
        cb.value = promptName;
        cb.checked = true;
        cb.style.display = 'none';
        document.getElementById('create-task-dialog').appendChild(cb);
    } else {
        existing.checked = !existing.checked;
    }
    renderDialogPromptBtnGroup();
}

function getDialogSelectedPromptNames() {
    return Array.from(
        document.querySelectorAll('.dialog-prompt-checkbox:checked')
    ).map(cb => cb.value);
}

/** 5秒倒计时确认机制 */
let _countdownTimer = null;
let _countdownSeconds = 5;

function resetCountdownState() {
    if (_countdownTimer) {
        clearInterval(_countdownTimer);
        _countdownTimer = null;
    }
    _countdownSeconds = 5;
    const countdownArea = document.getElementById('countdown-area');
    const confirmBtn = document.getElementById('confirm-create-btn');
    const cancelBtn = document.getElementById('cancel-create-btn');
    if (countdownArea) countdownArea.style.display = 'none';
    if (confirmBtn) confirmBtn.style.display = 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
}

function startCreateCountdown() {
    // 验证参数
    const model = document.getElementById('dialog-model-select').value;
    if (!model) {
        showToast('请选择模型', 'warning');
        return;
    }
    const prompts = getDialogSelectedPromptNames();
    if (!prompts.length) {
        showToast('请至少选择一个 Prompt', 'warning');
        return;
    }

    _countdownSeconds = 5;
    const countdownArea = document.getElementById('countdown-area');
    const confirmBtn = document.getElementById('confirm-create-btn');
    const cancelBtn = document.getElementById('cancel-create-btn');

    // 隐藏确认按钮，显示倒计时区域
    confirmBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    countdownArea.style.display = 'flex';
    updateCountdownDisplay();

    _countdownTimer = setInterval(() => {
        _countdownSeconds--;
        if (_countdownSeconds <= 0) {
            clearInterval(_countdownTimer);
            _countdownTimer = null;
            // 恢复 UI
            countdownArea.style.display = 'none';
            confirmBtn.style.display = 'inline-flex';
            cancelBtn.style.display = 'inline-flex';
            // 真正创建任务
            doCreateTask();
        } else {
            updateCountdownDisplay();
        }
    }, 1000);
}

function cancelCreateCountdown() {
    if (!_countdownTimer) return;
    clearInterval(_countdownTimer);
    _countdownTimer = null;
    const countdownArea = document.getElementById('countdown-area');
    const confirmBtn = document.getElementById('confirm-create-btn');
    const cancelBtn = document.getElementById('cancel-create-btn');
    if (countdownArea) countdownArea.style.display = 'none';
    if (confirmBtn) confirmBtn.style.display = 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    showToast('已取消创建', 'info');
}

function updateCountdownDisplay() {
    const el = document.getElementById('countdown-text');
    if (el) {
        el.textContent = `任务将在 ${_countdownSeconds}s 后开始...`;
    }
}

/** 真正执行创建任务 API 调用 */
async function doCreateTask() {
    const model = document.getElementById('dialog-model-select').value;
    const prompts = getDialogSelectedPromptNames();
    const rangeParams = getDialogRangeParams();
    const payload = {
        file_id: currentFileId,
        row_ids: null,  // 全量
        model_config: model,
        strategy: document.getElementById('dialog-strategy-select').value,
        prompt_names: prompts,
        concurrency: parseInt(document.getElementById('dialog-concurrency-input').value) || 1,
        row_start: rangeParams.row_start,
        row_end: rangeParams.row_end,
    };
    try {
        const result = await apiPost('/api/workbench/annotate', payload);
        closeCreateTaskDialog();
        onAnnotateStarted(result);
    } catch (e) { /* apiRequest 已 toast */ }
}

/** 保留旧函数名兼容 - 直接启动倒计时 */
async function confirmCreateTask() {
    startCreateCountdown();
}

// ========== 当前任务摘要 ==========

/** 渲染当前任务摘要 */
function renderCurrentTaskSummary() {
    const el = document.getElementById('task-summary-bar');
    if (!el) return;
    if (!currentTaskId || !currentFileId) {
        el.innerHTML = '<span style="color:#9ca3af; font-size:12px;">未选择任务</span>';
        return;
    }
    apiGet(`/api/workbench/tasks?file_id=${currentFileId}`).then(data => {
        const tasks = data.tasks || [];
        const task = tasks.find(t => String(t.id) === String(currentTaskId));
        if (!task) {
            el.innerHTML = '<span style="color:#9ca3af; font-size:12px;">未选择任务</span>';
            return;
        }
        const modelName = (task.model_name || '').replace(/\(.*\)/, '');
        const strategy = (task.model_name || '').match(/\((.*?)\)/)?.[1] || task.strategy || '';
        const concurrency = task.concurrency || 1;
        const statusBadge = renderTaskStatusBadge(task.status);

        el.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; padding:3px 10px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; font-size:12px;">
                <span style="font-weight:500; color:#1e293b;">${escapeHtml(modelName)}</span>
                ${strategy ? `<span style="color:#94a3b8;">\u00b7</span><span style="color:#64748b;">${escapeHtml(strategy)}</span>` : ''}
                <span style="color:#94a3b8;">\u00b7</span><span style="color:#64748b;">并发${concurrency}</span>
                ${statusBadge}
            </div>
        `;
    }).catch(() => {
        el.innerHTML = '<span style="color:#9ca3af; font-size:12px;">未选择任务</span>';
    });
}

// ========== 任务历史抄屉 ==========

function openTaskDrawer() {
    document.getElementById('task-drawer-overlay').style.display = 'block';
    document.getElementById('task-drawer').style.transform = 'translateX(0)';
    loadTaskHistory();
}

function closeTaskDrawer() {
    document.getElementById('task-drawer').style.transform = 'translateX(100%)';
    setTimeout(() => {
        document.getElementById('task-drawer-overlay').style.display = 'none';
    }, 300);
}

// ========== 导出标注结果 ==========

/**
 * 调用 POST /api/export 将当前文件的标注结果导出为 Excel
 * 自动使用当前选中的 file_id 和 task_id
 */
async function exportAnnotationData() {
    if (!currentFileId) {
        showToast('请先选择数据文件', 'warning');
        return;
    }
    const exportBtn = document.getElementById('export-btn');
    // 防止重复点击
    lockBtn(exportBtn, '导出中...');
    try {
        const requestBody = { file_id: currentFileId };
        // 如果选择了具体任务，则按该任务导出
        if (currentTaskId) {
            requestBody.task_id = currentTaskId;
        }
        const response = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
            const errorText = await response.text();
            showToast(`导出失败：${errorText}`, 'error');
            return;
        }
        // 解析文件名，支持 Content-Disposition里的 filename* 和 filename
        const contentDisposition = response.headers.get('content-disposition') || '';
        let downloadFileName = 'annotation_export.xlsx';
        // 优先解析 filename*（RFC 5987 编码）
        const rfc5987Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (rfc5987Match) {
            downloadFileName = decodeURIComponent(rfc5987Match[1].trim());
        } else {
            // 降级解析普通 filename
            const plainMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
            if (plainMatch) {
                downloadFileName = plainMatch[1].trim();
            }
        }
        // 创建临时链接触发浏览器下载
        const blobData = await response.blob();
        const blobUrl = URL.createObjectURL(blobData);
        const downloadLink = document.createElement('a');
        downloadLink.href = blobUrl;
        downloadLink.download = downloadFileName;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        URL.revokeObjectURL(blobUrl);
        showToast('导出成功', 'success');
    } catch (error) {
        console.error('导出异常:', error);
        showToast('导出失败，请重试', 'error');
    } finally {
        // 恢复按钮状态
        unlockBtn(exportBtn);
    }
}
